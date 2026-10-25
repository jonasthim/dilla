import type { CoreClient } from '../bridge';

const ID = /^[0-9a-f]{32}$/u;
const POLL_INTERVAL_MS = 200;
const REQUEST_TIMEOUT_MS = 30_000;

export interface BotInteractionResult {
  requestId: string;
  status: number;
  revision: string | null;
  data: Uint8Array;
}

export interface BotInteractionRequest {
  operation: number;
  channelId?: string | null;
  args: readonly (string | number | Uint8Array | null)[];
  revision?: string | null;
  requestId?: string;
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
  const reads = new Map<string, Promise<BotInteractionResult | null>>();
  const requests = new Map<string, Promise<BotInteractionResult>>();
  const keyOf = (requestId: string, operation: number): string => `${requestId}:${operation}`;
  const resultCopy = (row: BotInteractionResult): BotInteractionResult => ({ ...row, data: row.data.slice() });
  let accountId = client.get?.('account')?.user?.id ?? null;
  let installationId: string | null | undefined;
  let scopeGeneration = 0;
  const clearScopedResults = (): void => { scopeGeneration++; results.clear(); uncertain.clear(); reads.clear(); requests.clear(); };
  const updateAccountScope = (): void => {
    const nextAccount = client.get?.('account')?.user?.id ?? null;
    if (nextAccount !== accountId) {
      accountId = nextAccount;
      installationId = undefined;
      clearScopedResults();
    }
  };
  client.subscribe?.('account', updateAccountScope);
  const ensureInstallationScope = async (): Promise<void> => {
    updateAccountScope();
    const installation = await client.call({ m: 'getBotInstallation', communityId }) as { id?: unknown } | null;
    const nextInstallation = installation !== null && typeof installation.id === 'string' ? installation.id : null;
    if (installationId !== undefined && nextInstallation !== installationId) clearScopedResults();
    installationId = nextInstallation;
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

  const readOnce = async (requestId: string, operation: number, generation = scopeGeneration): Promise<BotInteractionResult | null> => {
    if (!ID.test(requestId) || !Number.isSafeInteger(operation) || operation < 0) throw new Error('Invalid Bot interaction identity.');
    const key = keyOf(requestId, operation);
    const prior = results.get(key);
    if (prior !== undefined) return resultCopy(prior);
    const page = await client.call({ m: 'readBotInteractionResponses', communityId, operations: [operation], requestIds: [requestId] }) as {
      responses: (BotInteractionResult & { operation: number })[]; through: string | null;
    };
    const matches = page.responses.filter(row => row.requestId === requestId && row.operation === operation);
    if (matches.length > 1) throw new Error('Duplicate Bot interaction response for the same request id.');
    const row = matches[0];
    if (row === undefined) return null;
    if (generation !== scopeGeneration) return null;
    if (page.through !== null) await client.call({ m: 'ackBotInteractionResponses', communityId, through: page.through });
    if (generation !== scopeGeneration) return null;
    const result = { requestId: row.requestId, status: row.status, revision: row.revision, data: row.data.slice() };
    rememberResult(key, result);
    return resultCopy(result);
  };

  const read = async (requestId: string, operation: number): Promise<BotInteractionResult | null> => {
    await ensureInstallationScope();
    const generation = scopeGeneration;
    const key = keyOf(requestId, operation);
    const cached = results.get(key);
    if (cached !== undefined) return resultCopy(cached);
    const pending = reads.get(key);
    if (pending !== undefined) return pending.then(row => row === null ? null : resultCopy(row));
    const task = readOnce(requestId, operation, generation);
    reads.set(key, task);
    try { return await task; }
    finally { if (reads.get(key) === task) reads.delete(key); }
  };

  const executeRequest = async (input: BotInteractionRequest, requestId: string): Promise<BotInteractionResult> => {
    if (!ID.test(requestId)) throw new Error('Invalid Bot interaction request id.');
    await ensureInstallationScope();
    const generation = scopeGeneration;
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
      if (result !== null) return result;
      const remaining = deadline - Date.now();
      if (remaining > 0) await new Promise<void>(resolve => setTimeout(resolve, Math.min(POLL_INTERVAL_MS, remaining)));
    }
    throw new BotInteractionUncertainError(requestId, 'Timed out waiting for the Bot interaction response.');
  };

  const request = (input: BotInteractionRequest): Promise<BotInteractionResult> => {
    const requestId = input.requestId ?? [...crypto.getRandomValues(new Uint8Array(16))]
      .map(byte => byte.toString(16).padStart(2, '0')).join('');
    const key = keyOf(requestId, input.operation);
    const prior = results.get(key);
    if (prior !== undefined) return Promise.resolve(resultCopy(prior));
    const pending = requests.get(key);
    if (pending !== undefined) return pending.then(resultCopy);
    const failure = uncertain.get(key);
    if (failure !== undefined) return Promise.reject(failure);
    const task = executeRequest(input, requestId);
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
  };

  const adapter: BotInteractionClient = { request, read };
  const communityClients = clients.get(client) ?? new Map<string, BotInteractionClient>();
  communityClients.set(communityId, adapter);
  clients.set(client, communityClients);
  return adapter;
}
