import type { CoreClient } from '../bridge';

const ID = /^[0-9a-f]{32}$/u;
const POLL_INTERVAL_MS = 200;
const REQUEST_TIMEOUT_MS = 30_000;

export interface BotInteractionResult {
  requestId: string;
  status: number;
  revision: string | null;
  data: Uint8Array;
  /** Live installation identity checked before dispatch and after response delivery. */
  readonly scope: BotInteractionScope;
}

export interface BotInteractionScope {
  readonly installationId: string;
  readonly botUserId: string | null;
  readonly revision: string;
}

export interface BotInteractionRequest {
  operation: number;
  channelId?: string | null;
  args: readonly (string | number | Uint8Array | null)[];
  revision?: string | null;
  requestId?: string;
  /** Optional capability-authority scope checked before dispatch and before returning. */
  expectedScope?: BotInteractionScope;
}

export class BotInteractionUncertainError extends Error {
  constructor(readonly requestId: string, message: string) {
    super(message);
    this.name = 'BotInteractionUncertainError';
  }
}

export class BotInteractionRejectedError extends Error {
  constructor(readonly requestId: string) {
    super('The Bot interaction request was rejected before the server confirmed its upload.');
    this.name = 'BotInteractionRejectedError';
  }
}

export class BotInteractionBindingMismatchError extends Error {
  constructor() {
    super('The Bot interaction capability binding changed before dispatch.');
    this.name = 'BotInteractionBindingMismatchError';
  }
}

export interface BotInteractionClient {
  request(input: BotInteractionRequest): Promise<BotInteractionResult>;
  read(requestId: string, operation: number): Promise<BotInteractionResult | null>;
}

const clients = new WeakMap<CoreClient, Map<string, BotInteractionClient>>();

/**
 * Shared typed transport for authenticated Bot interactions. Domain response statuses are returned
 * unchanged in `BotInteractionResult.status`; callers decide how to present each operation's status.
 * An uncertain upload or response timeout carries the original request id so reconciliation can
 * continue with `read` after reload without issuing a second mutation. The adapter never retries a
 * timed out mutation because the original request body and expiry are bound to that id in the core.
 */
export function createBotInteractionClient(client: CoreClient, communityId: string) {
  if (!ID.test(communityId)) throw new Error('Invalid community id.');
  const existing = clients.get(client)?.get(communityId);
  if (existing !== undefined) return existing;
  const results = new Map<string, BotInteractionResult>();
  const uncertain = new Map<string, BotInteractionUncertainError | BotInteractionRejectedError>();
  // A shared read task includes the final authorization recheck. Store only that fully checked
  // promise so no coalesced waiter can observe the inner, not-yet-scoped response.
  const reads = new Map<string, Promise<BotInteractionResult | null>>();
  const requests = new Map<string, Promise<BotInteractionResult>>();
  const keyOf = (requestId: string, operation: number): string => `${requestId}:${operation}`;
  const resultCopy = (row: BotInteractionResult): BotInteractionResult => ({ ...row, data: row.data.slice(), scope: Object.freeze({ ...row.scope }) });
  let accountId = client.get?.('account')?.user?.id ?? null;
  let authorizationScope: string | null = null;
  let accessScopeKey: string | null = null;
  let scopeGeneration = 0;
  const clearScopedResults = (): void => { scopeGeneration++; results.clear(); uncertain.clear(); reads.clear(); requests.clear(); };
  const updateAccountScope = (): void => {
    const nextAccount = client.get?.('account')?.user?.id ?? null;
    if (nextAccount !== accountId) {
      accountId = nextAccount;
      authorizationScope = null;
      clearScopedResults();
    }
  };
  const localAccessScope = (): { key: string } => {
    updateAccountScope();
    const account = client.get?.('account');
    if (account?.phase !== 'ready' || account.user === null || account.deviceId === null) {
      throw new Error('The Bot interaction transport requires a ready account and device.');
    }
    const communities = client.get?.('communities') ?? [];
    if (!communities.some(row => row.id === communityId)) throw new Error('The Bot interaction community is no longer accessible.');
    const permissions = client.get?.(`permissions:${communityId}`);
    return { key: JSON.stringify([account.instance?.id ?? null, account.user.id, account.deviceId,
      communities.find(row => row.id === communityId), permissions ?? null]) };
  };
  const observeAccessScope = (): void => {
    try {
      const current = localAccessScope().key;
      if (accessScopeKey !== null && current !== accessScopeKey) clearScopedResults();
      accessScopeKey = current;
    } catch {
      if (accessScopeKey !== null) clearScopedResults();
      accessScopeKey = null;
    }
  };
  client.subscribe?.('account', () => { updateAccountScope(); observeAccessScope(); });
  const ensureInstallationScope = async (): Promise<{ generation: number; scope: BotInteractionScope }> => {
    const before = localAccessScope();
    const generation = scopeGeneration;
    const installation = await client.call({ m: 'getBotCommandStatus', communityId }) as {
      installationId?: unknown; botUserId?: unknown; state?: unknown; revision?: unknown;
    } | null;
    let after: { key: string };
    try { after = localAccessScope(); }
    catch (error) { clearScopedResults(); accessScopeKey = null; authorizationScope = null; throw error; }
    if (generation !== scopeGeneration || before.key !== after.key) {
      clearScopedResults();
      throw new Error('The Bot interaction account or community access changed during authorization.');
    }
    const installKey = installation === null ? null : JSON.stringify([installation.installationId, installation.botUserId,
      installation.state, installation.revision]);
    const nextScope = JSON.stringify([after.key, installKey]);
    if (authorizationScope !== null && nextScope !== authorizationScope) clearScopedResults();
    authorizationScope = nextScope;
    accessScopeKey = after.key;
    if (installation === null || typeof installation.installationId !== 'string' || !ID.test(installation.installationId)
      || installation.state !== 3 || installation.botUserId !== null && (typeof installation.botUserId !== 'string' || !ID.test(installation.botUserId))
      || typeof installation.revision !== 'string' || !/^(?:0|[1-9]\d*)$/u.test(installation.revision)) {
      throw new Error('The Bot interaction installation is not active.');
    }
    return { generation: scopeGeneration, scope: {
      installationId: installation.installationId, botUserId: installation.botUserId, revision: installation.revision,
    } };
  };
  const sameScope = (left: BotInteractionScope, right: BotInteractionScope): boolean => left.installationId === right.installationId
    && left.botUserId === right.botUserId && left.revision === right.revision;
  const assertRequestScope = (generation: number): void => {
    const current = localAccessScope().key;
    if (generation !== scopeGeneration || current !== accessScopeKey) {
      clearScopedResults();
      throw new BotInteractionUncertainError('', 'The Bot interaction account or community access changed while the request was pending.');
    }
  };
  const rememberResult = (key: string, result: BotInteractionResult): void => {
    results.delete(key);
    results.set(key, result);
    while (results.size > 128) {
      const oldest = results.keys().next().value;
      if (oldest === undefined) break;
      results.delete(oldest);
    }
  };

  const readOnce = async (requestId: string, operation: number, generation = scopeGeneration): Promise<Omit<BotInteractionResult, 'scope'> | null> => {
    if (!ID.test(requestId) || !Number.isSafeInteger(operation) || operation < 0) throw new Error('Invalid Bot interaction identity.');
    const key = keyOf(requestId, operation);
    const prior = results.get(key);
    if (prior !== undefined) return resultCopy(prior);
    const page = await client.call({ m: 'readBotInteractionResponses', communityId, operations: [operation], requestIds: [requestId] }) as {
      responses: (Omit<BotInteractionResult, 'scope'> & { operation: number })[]; through: string | null;
    };
    const matches = page.responses.filter(row => row.requestId === requestId && row.operation === operation);
    if (matches.length > 1) throw new Error('Duplicate Bot interaction response for the same request id.');
    const row = matches[0];
    if (row === undefined) return null;
    if (generation !== scopeGeneration) return null;
    if (page.through !== null) await client.call({ m: 'ackBotInteractionResponses', communityId, through: page.through });
    if (generation !== scopeGeneration) return null;
    return { requestId: row.requestId, status: row.status, revision: row.revision, data: row.data.slice() };
  };

  const read = async (requestId: string, operation: number): Promise<BotInteractionResult | null> => {
    const initial = await ensureInstallationScope();
    const generation = initial.generation;
    const key = keyOf(requestId, operation);
    const cached = results.get(key);
    if (cached !== undefined) return resultCopy(cached);
    const pending = reads.get(key);
    if (pending !== undefined) return pending.then(row => row === null ? null : resultCopy(row));
    const task = (async (): Promise<BotInteractionResult | null> => {
      const result = await readOnce(requestId, operation, generation);
      if (result === null) return null;
      const final = await ensureInstallationScope();
      if (final.generation !== generation) return null;
      const scoped = { ...result, scope: final.scope };
      rememberResult(key, scoped);
      return scoped;
    })();
    reads.set(key, task);
    try { const result = await task; return result === null ? null : resultCopy(result); }
    finally { if (reads.get(key) === task) reads.delete(key); }
  };

  const executeRequest = async (input: BotInteractionRequest, requestId: string, generation: number, scope: BotInteractionScope): Promise<BotInteractionResult> => {
    if (!ID.test(requestId)) throw new Error('Invalid Bot interaction request id.');
    const send = client.call({ m: 'humanInteractionRequest', communityId,
      channelId: input.channelId ?? null, requestId, operation: input.operation, args: input.args,
      revision: input.revision ?? null }) as Promise<{ requestId: string; upload: string }>;
    let uploadTimer: ReturnType<typeof setTimeout> | undefined;
    const sent = await Promise.race([
      send,
      new Promise<never>((_, reject) => {
        uploadTimer = setTimeout(() => reject(new BotInteractionUncertainError(requestId, 'Timed out waiting for the Bot interaction upload result.')),
          REQUEST_TIMEOUT_MS);
      }),
    ]).finally(() => { if (uploadTimer !== undefined) clearTimeout(uploadTimer); });
    if (sent.requestId !== requestId) throw new BotInteractionUncertainError(requestId, 'The worker returned a different request id.');
    if (sent.upload === 'rejected') throw new BotInteractionRejectedError(requestId);
    if (sent.upload !== 'accepted') throw new BotInteractionUncertainError(requestId, 'The Bot interaction upload is still unresolved.');

    const deadline = Date.now() + REQUEST_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (generation !== scopeGeneration) throw new BotInteractionUncertainError(requestId, 'The Bot installation or account changed while the request was pending.');
      const result = await readOnce(requestId, input.operation, generation);
      if (result !== null) {
        try {
          const final = await ensureInstallationScope();
          if (final.generation !== generation || !sameScope(final.scope, scope)) throw new Error('scope changed');
        } catch {
          throw new BotInteractionUncertainError(requestId, 'The Bot installation or account changed while the request was pending.');
        }
        try { assertRequestScope(generation); }
        catch { throw new BotInteractionUncertainError(requestId, 'The Bot interaction account or community access changed while the request was pending.'); }
        const scoped = { ...result, scope };
        rememberResult(keyOf(requestId, input.operation), scoped);
        return scoped;
      }
      const remaining = deadline - Date.now();
      if (remaining > 0) await new Promise<void>(resolve => setTimeout(resolve, Math.min(POLL_INTERVAL_MS, remaining)));
    }
    throw new BotInteractionUncertainError(requestId, 'Timed out waiting for the Bot interaction response.');
  };

  const request = (input: BotInteractionRequest): Promise<BotInteractionResult> => {
    const requestId = input.requestId ?? [...crypto.getRandomValues(new Uint8Array(16))]
      .map(byte => byte.toString(16).padStart(2, '0')).join('');
    const key = keyOf(requestId, input.operation);
    return (async () => {
      const initial = await ensureInstallationScope();
      const { generation, scope } = initial;
      if (input.expectedScope !== undefined && !sameScope(scope, input.expectedScope)) {
        throw new BotInteractionBindingMismatchError();
      }
      const prior = results.get(key);
      if (prior !== undefined) return resultCopy(prior);
      const pending = requests.get(key);
      if (pending !== undefined) return pending.then(resultCopy);
      const failure = uncertain.get(key);
      if (failure !== undefined) throw failure;
      const task = executeRequest(input, requestId, generation, scope);
      requests.set(key, task);
      void task.catch(error => {
        if (error instanceof BotInteractionUncertainError || error instanceof BotInteractionRejectedError) {
          uncertain.delete(key);
          uncertain.set(key, error);
          while (uncertain.size > 128) {
            const oldest = uncertain.keys().next().value;
            if (oldest === undefined) break;
            uncertain.delete(oldest);
          }
        }
      });
      void task.finally(() => { if (requests.get(key) === task) requests.delete(key); }).catch(() => undefined);
      return task.then(resultCopy);
    })();
  };

  const adapter: BotInteractionClient = { request, read };
  const communityClients = clients.get(client) ?? new Map<string, BotInteractionClient>();
  communityClients.set(communityId, adapter);
  clients.set(client, communityClients);
  return adapter;
}
