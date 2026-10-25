import { afterEach, expect, it, vi } from 'vitest';
import type { CoreClient } from '../bridge';
import { createBotInteractionClient, BotInteractionBindingMismatchError, BotInteractionIdentityConflictError,
  BotInteractionRejectedError, BotInteractionUncertainError, BotInteractionUnverifiableRequestError } from './interactions';
import { world, toReady, COMMUNITY as WORKER_COMMUNITY, USER, DEVICE, textGroup } from '../worker/world';
import { toHex } from '../hex';
import { encodeBotResponse } from './protocol';
import { encode } from '../cbor';

const COMMUNITY = '11'.repeat(16);
const REQUEST = '22'.repeat(16);
const INSTALLATION = 'aa'.repeat(16);
const user = { id: '33'.repeat(16), username: 'member' };
const response = (status = 0) => ({ deliveryId: '7', requestId: REQUEST, operation: 70, status, revision: '3', data: new Uint8Array([9]) });

function fake(handler: (command: { m: string; [key: string]: unknown }) => unknown) {
  const calls: { m: string; [key: string]: unknown }[] = [];
  const client = { get: (name: string) => name === 'account' ? { phase: 'ready', user, deviceId: '44'.repeat(16) }
    : name === 'communities' ? [{ id: COMMUNITY }] : name === `permissions:${COMMUNITY}` ? { loaded: true } : undefined,
  subscribe: () => () => {}, call: vi.fn((command: { m: string; [key: string]: unknown }) => {
    calls.push(command); return Promise.resolve(handler(command));
  }) } as unknown as CoreClient;
  return { client, calls };
}

afterEach(() => { vi.useRealTimers(); });

it('sends once, reads only the exact pending request and returns domain status consistently', async () => {
  let reads = 0;
  const f = fake(command => {
    if (command.m === 'humanInteractionRequest') return { requestId: REQUEST, upload: 'accepted' };
    if (command.m === 'getBotCommandStatus') return { installationId: INSTALLATION, botUserId: null, state: 3, revision: '1' };
    if (command.m === 'readBotInteractionResponses') return { responses: ++reads === 1 ? [] : [response(4)], through: reads === 1 ? null : 'b'.repeat(32) };
    return null;
  });
  const api = createBotInteractionClient(f.client, COMMUNITY);
  const result = await api.request({ requestId: REQUEST, operation: 70, args: [new Uint8Array([1])] });
  expect(result).toEqual({ requestId: REQUEST, status: 4, revision: '3', data: new Uint8Array([9]),
    scope: { installationId: INSTALLATION, botUserId: null, revision: '1' } });
  expect(f.calls.filter(call => call.m === 'humanInteractionRequest')).toHaveLength(1);
  expect(f.calls.filter(call => call.m === 'readBotInteractionResponses').every(call =>
    call.requestIds instanceof Array && call.requestIds[0] === REQUEST)).toBe(true);
  expect(f.calls.filter(call => call.m === 'ackBotInteractionResponses')).toHaveLength(1);
});

it('rejects changed body reuse before returning a successful cached response', async () => {
  const f = fake(command => command.m === 'getBotCommandStatus' ? { installationId: INSTALLATION, botUserId: null, state: 3, revision: '1' }
    : command.m === 'humanInteractionRequest' ? { requestId: REQUEST, upload: 'accepted' }
      : command.m === 'readBotInteractionResponses' ? { responses: [response()], through: 'b'.repeat(32) } : null);
  const api = createBotInteractionClient(f.client, COMMUNITY);
  await api.request({ requestId: REQUEST, operation: 70, args: [new Uint8Array([1])] });
  await expect(api.request({ requestId: REQUEST, operation: 70, args: [new Uint8Array([2])] }))
    .rejects.toBeInstanceOf(BotInteractionIdentityConflictError);
  expect(f.calls.filter(call => call.m === 'humanInteractionRequest')).toHaveLength(1);
});

it('rejects a different body while the original request is awaiting its response', async () => {
  let responseReads = 0;
  const f = fake(command => command.m === 'getBotCommandStatus' ? { installationId: INSTALLATION, botUserId: null, state: 3, revision: '1' }
    : command.m === 'humanInteractionRequest' ? { requestId: REQUEST, upload: 'accepted' }
      : command.m === 'readBotInteractionResponses' ? { responses: ++responseReads === 1 ? [] : [response()],
        through: responseReads === 1 ? null : 'b'.repeat(32) } : null);
  const api = createBotInteractionClient(f.client, COMMUNITY);
  const first = api.request({ requestId: REQUEST, operation: 70, args: ['original'] });
  await vi.waitFor(() => expect(responseReads).toBe(1));
  await expect(api.request({ requestId: REQUEST, operation: 70, args: ['changed'] }))
    .rejects.toBeInstanceOf(BotInteractionIdentityConflictError);
  expect(f.calls.filter(call => call.m === 'humanInteractionRequest')).toHaveLength(1);
  await expect(first).resolves.toMatchObject({ requestId: REQUEST });
});

it('rejects reuse of a request id across different operations', async () => {
  const f = fake(command => command.m === 'getBotCommandStatus' ? { installationId: INSTALLATION, botUserId: null, state: 3, revision: '1' }
    : command.m === 'humanInteractionRequest' ? { requestId: REQUEST, upload: 'accepted' }
      : command.m === 'readBotInteractionResponses' ? { responses: [response()], through: 'b'.repeat(32) } : null);
  const api = createBotInteractionClient(f.client, COMMUNITY);
  await api.request({ requestId: REQUEST, operation: 70, args: ['same args'] });
  await expect(api.request({ requestId: REQUEST, operation: 71, args: ['same args'] }))
    .rejects.toBeInstanceOf(BotInteractionIdentityConflictError);
  expect(f.calls.filter(call => call.m === 'humanInteractionRequest')).toHaveLength(1);
});

it('exposes same-id reload reconciliation without sending another mutation', async () => {
  const f = fake(command => command.m === 'getBotCommandStatus' ? { installationId: INSTALLATION, botUserId: null, state: 3, revision: '1' }
    : command.m === 'readBotInteractionResponses' ? { responses: [response()], through: 'b'.repeat(32) } : null);
  const result = await createBotInteractionClient(f.client, COMMUNITY).read(REQUEST, 70);
  expect(result?.requestId).toBe(REQUEST);
  expect(result?.scope).toEqual({ installationId: INSTALLATION, botUserId: null, revision: '1' });
  expect(f.calls.map(call => call.m)).toEqual(['getBotCommandStatus', 'readBotInteractionResponses', 'ackBotInteractionResponses', 'getBotCommandStatus']);
});

it('rejects a capability scope mismatch before dispatching the requested operation', async () => {
  const f = fake(command => command.m === 'getBotCommandStatus' ? { installationId: 'bb'.repeat(16), botUserId: null, state: 3, revision: '2' } : null);
  await expect(createBotInteractionClient(f.client, COMMUNITY).request({ requestId: REQUEST, operation: 71, args: [],
    expectedScope: { installationId: INSTALLATION, botUserId: null, revision: '1' } })).rejects.toThrow('capability binding changed');
  expect(f.calls.some(call => call.m === 'humanInteractionRequest')).toBe(false);
});

it('keeps an unrelated uncertain upload guard after rejecting a stale expected scope', async () => {
  let sends = 0;
  const f = fake(command => {
    if (command.m === 'getBotCommandStatus') return { installationId: INSTALLATION, botUserId: null, state: 3, revision: '1' };
    if (command.m === 'humanInteractionRequest') { sends++; return { requestId: command.requestId, upload: 'pending' }; }
    throw new Error(`unexpected command ${command.m}`);
  });
  const api = createBotInteractionClient(f.client, COMMUNITY);
  const mutation = { requestId: REQUEST, operation: 70, args: [], expectedScope: { installationId: INSTALLATION, botUserId: null, revision: '1' } };
  await expect(api.request(mutation)).rejects.toBeInstanceOf(BotInteractionUncertainError);
  await expect(api.request(mutation)).rejects.toBeInstanceOf(BotInteractionUncertainError);
  expect(sends).toBe(1);

  await expect(api.request({ requestId: '55'.repeat(16), operation: 71, args: [],
    expectedScope: { installationId: 'bb'.repeat(16), botUserId: null, revision: '1' } }))
    .rejects.toBeInstanceOf(BotInteractionBindingMismatchError);
  await expect(api.request(mutation)).rejects.toBeInstanceOf(BotInteractionUncertainError);
  expect(sends).toBe(1);
});

it('preserves coalesced current-scope readers and their cached result after a stale expectation is rejected', async () => {
  let reads = 0;
  let resolveResponse: ((value: unknown) => void) | undefined;
  const f = fake(command => {
    if (command.m === 'getBotCommandStatus') return { installationId: INSTALLATION, botUserId: null, state: 3, revision: '1' };
    if (command.m === 'readBotInteractionResponses') {
      reads++;
      return new Promise(resolve => { resolveResponse = resolve; });
    }
    if (command.m === 'ackBotInteractionResponses') return null;
    throw new Error(`unexpected command ${command.m}`);
  });
  const api = createBotInteractionClient(f.client, COMMUNITY);
  const first = api.read(REQUEST, 70);
  const second = api.read(REQUEST, 70);
  await vi.waitFor(() => expect(reads).toBe(1));
  await expect(api.request({ requestId: '55'.repeat(16), operation: 71, args: [],
    expectedScope: { installationId: 'bb'.repeat(16), botUserId: null, revision: '1' } }))
    .rejects.toBeInstanceOf(BotInteractionBindingMismatchError);
  resolveResponse?.({ responses: [response()], through: null });
  const [firstResult, secondResult] = await Promise.all([first, second]);
  expect(firstResult?.scope).toEqual({ installationId: INSTALLATION, botUserId: null, revision: '1' });
  expect(secondResult).toEqual(firstResult);
  expect(await api.read(REQUEST, 70)).toEqual(firstResult);
  expect(reads).toBe(1);
});

it('shares one client per core/community and coalesces concurrent requests and reads for the same id', async () => {
  const f = fake(command => command.m === 'getBotCommandStatus' ? { installationId: INSTALLATION, botUserId: null, state: 3, revision: '1' }
    : command.m === 'humanInteractionRequest'
    ? { requestId: REQUEST, upload: 'accepted' }
    : command.m === 'readBotInteractionResponses' ? { responses: [response()], through: 'b'.repeat(32) } : null);
  const first = createBotInteractionClient(f.client, COMMUNITY);
  const second = createBotInteractionClient(f.client, COMMUNITY);
  expect(second).toBe(first);
  const [a, b] = await Promise.all([
    first.request({ requestId: REQUEST, operation: 70, args: [] }),
    second.request({ requestId: REQUEST, operation: 70, args: [] }),
  ]);
  expect(a).toEqual(b);
  expect(f.calls.filter(call => call.m === 'humanInteractionRequest')).toHaveLength(1);
  expect(f.calls.filter(call => call.m === 'readBotInteractionResponses')).toHaveLength(1);
  expect(f.calls.filter(call => call.m === 'ackBotInteractionResponses')).toHaveLength(1);
});

it('drops cached responses when the Bot installation changes', async () => {
  let installation = 'aa'.repeat(16);
  let reads = 0;
  const f = fake(command => command.m === 'getBotCommandStatus' ? { installationId: installation, botUserId: null, state: 3, revision: '1' }
    : command.m === 'readBotInteractionResponses' ? { responses: [response(++reads === 1 ? 0 : 4)], through: 'b'.repeat(32) } : null);
  const api = createBotInteractionClient(f.client, COMMUNITY);
  expect((await api.read(REQUEST, 70))?.status).toBe(0);
  installation = 'bb'.repeat(16);
  expect((await api.read(REQUEST, 70))?.status).toBe(4);
  expect(reads).toBe(2);
});

it('turns pending and rejected uploads into typed errors carrying the stable request id', async () => {
  for (const upload of ['pending', 'unknown']) {
    const f = fake(command => command.m === 'getBotCommandStatus' ? { installationId: INSTALLATION, botUserId: null, state: 3, revision: '1' }
      : ({ requestId: REQUEST, upload }));
    const api = createBotInteractionClient(f.client, COMMUNITY);
    await expect(api.request({ requestId: REQUEST, operation: 70, args: [] }))
      .rejects.toMatchObject({ name: 'BotInteractionUncertainError', requestId: REQUEST });
    await expect(api.request({ requestId: REQUEST, operation: 70, args: ['changed'] }))
      .rejects.toBeInstanceOf(BotInteractionIdentityConflictError);
    await expect(api.request({ requestId: REQUEST, operation: 70, args: [] }))
      .rejects.toMatchObject({ name: 'BotInteractionUncertainError', requestId: REQUEST });
    expect(f.calls.filter(call => call.m === 'humanInteractionRequest')).toHaveLength(1);
  }
  const rejected = fake(command => command.m === 'getBotCommandStatus' ? { installationId: INSTALLATION, botUserId: null, state: 3, revision: '1' }
    : ({ requestId: REQUEST, upload: 'rejected' }));
  await expect(createBotInteractionClient(rejected.client, COMMUNITY).request({ requestId: REQUEST, operation: 70, args: [] }))
    .rejects.toBeInstanceOf(BotInteractionRejectedError);
  expect(rejected.calls.filter(call => call.m === 'humanInteractionRequest')).toHaveLength(1);
});

it.each(['response read', 'acknowledgement'] as const)('turns raw %s failures after upload acceptance into uncertain outcomes and allows same-id reconciliation', async stage => {
  let responseReads = 0; let ackCalls = 0; let failed = false;
  const f = fake(command => {
    if (command.m === 'getBotCommandStatus') return { installationId: INSTALLATION, botUserId: null, state: 3, revision: '1' };
    if (command.m === 'humanInteractionRequest') return { requestId: REQUEST, upload: 'accepted' };
    if (command.m === 'readBotInteractionResponses') {
      responseReads++;
      if (stage === 'response read' && !failed) { failed = true; throw Object.assign(new Error('read connection lost'), { status: 403 }); }
      return { responses: [response()], through: stage === 'acknowledgement' && ackCalls === 0 ? 'b'.repeat(32) : null };
    }
    if (command.m === 'ackBotInteractionResponses') {
      ackCalls++;
      if (stage === 'acknowledgement' && ackCalls === 1) throw Object.assign(new Error('ack connection lost'), { status: 403 });
      return null;
    }
    return null;
  });
  const api = createBotInteractionClient(f.client, COMMUNITY);
  await expect(api.request({ requestId: REQUEST, operation: 70, args: ['immutable'] }))
    .rejects.toMatchObject({ name: 'BotInteractionUncertainError', requestId: REQUEST });
  expect(f.calls.filter(call => call.m === 'humanInteractionRequest')).toHaveLength(1);
  await expect(api.read(REQUEST, 70)).resolves.toMatchObject({ status: 0, requestId: REQUEST });
  expect(f.calls.filter(call => call.m === 'humanInteractionRequest')).toHaveLength(1);
  expect(responseReads).toBeGreaterThanOrEqual(2);
});

it('treats a raw upload response failure after dispatch as uncertain and reconciles without resending', async () => {
  let sends = 0; let loseUploadResponse = true;
  const f = fake(command => {
    if (command.m === 'getBotCommandStatus') return { installationId: INSTALLATION, botUserId: null, state: 3, revision: '1' };
    if (command.m === 'humanInteractionRequest') {
      sends++;
      if (loseUploadResponse) { loseUploadResponse = false; throw new Error('upload response connection lost'); }
      return { requestId: REQUEST, upload: 'accepted' };
    }
    if (command.m === 'readBotInteractionResponses') return { responses: [response()], through: null };
    return null;
  });
  const api = createBotInteractionClient(f.client, COMMUNITY);
  await expect(api.request({ requestId: REQUEST, operation: 70, args: ['effect'] }))
    .rejects.toMatchObject({ name: 'BotInteractionUncertainError', requestId: REQUEST });
  await expect(api.read(REQUEST, 70)).resolves.toMatchObject({ status: 0, requestId: REQUEST });
  expect(sends).toBe(1);
});

it('does not wrap pre-dispatch authorization errors as mutation uncertainty', async () => {
  const f = fake(command => {
    if (command.m === 'getBotCommandStatus') throw new Error('authorization lookup failed');
    return null;
  });
  await expect(createBotInteractionClient(f.client, COMMUNITY).request({ requestId: REQUEST, operation: 70, args: [] }))
    .rejects.toThrow('authorization lookup failed');
  expect(f.calls.some(call => call.m === 'humanInteractionRequest')).toBe(false);
});

it('snapshots caller-owned bytes before awaiting installation authorization', async () => {
  let statusReads = 0;
  let finishStatus: ((value: unknown) => void) | undefined;
  const f = fake(command => command.m === 'getBotCommandStatus' ? ++statusReads === 1
    ? new Promise(resolve => { finishStatus = resolve; })
    : { installationId: INSTALLATION, botUserId: null, state: 3, revision: '1' }
    : command.m === 'humanInteractionRequest' ? { requestId: REQUEST, upload: 'accepted' }
      : command.m === 'readBotInteractionResponses' ? { responses: [response()], through: 'b'.repeat(32) } : null);
  const bytes = new Uint8Array([1]);
  const args = [bytes] as (string | number | Uint8Array | null)[];
  const pending = createBotInteractionClient(f.client, COMMUNITY).request({ requestId: REQUEST, operation: 70, args });
  await vi.waitFor(() => expect(finishStatus).toBeTypeOf('function'));
  bytes[0] = 2;
  args[0] = new Uint8Array([3]);
  finishStatus?.({ installationId: INSTALLATION, botUserId: null, state: 3, revision: '1' });
  await pending;
  expect(f.calls.find(call => call.m === 'humanInteractionRequest')?.args).toEqual([new Uint8Array([1])]);
});

it('does not treat a read-only result as a known request body fingerprint', async () => {
  const f = fake(command => command.m === 'getBotCommandStatus' ? { installationId: INSTALLATION, botUserId: null, state: 3, revision: '1' }
    : command.m === 'readBotInteractionResponses' ? { responses: [response()], through: 'b'.repeat(32) }
      : command.m === 'humanInteractionRequest' ? { requestId: REQUEST, upload: 'rejected' } : null);
  const api = createBotInteractionClient(f.client, COMMUNITY);
  expect((await api.read(REQUEST, 70))?.status).toBe(0);
  await expect(api.request({ requestId: REQUEST, operation: 70, args: ['unverified original body'] }))
    .rejects.toBeInstanceOf(BotInteractionUnverifiableRequestError);
  expect(f.calls.filter(call => call.m === 'humanInteractionRequest')).toHaveLength(0);
});

it('refuses read-then-request reuse when the actual worker has an id-only accepted receipt', async () => {
  const w = world();
  await toReady(w);
  const rid = new Uint8Array(16).fill(0x71);
  const requestId = toHex(rid);
  const communityId = toHex(WORKER_COMMUNITY);
  const groupId = new Uint8Array(16).fill(0x52);
  w.state.groups.push({ ...textGroup(2), groupId, kind: 3, targetId: USER });
  w.core.humanInteractionSendPrepare.mockImplementation(id => {
    w.state.outbox.push({ msgId: id, state: 0, error: '', created: 1n, body: 'original persisted body',
      type: 0, replyTo: null, attachments: [] });
    return id;
  });
  let callId = 92000;
  const call = async (command: unknown): Promise<unknown> => {
    const id = callId++;
    w.call(id, command);
    await vi.waitFor(() => expect(w.ret(id)).toBeDefined());
    const result = w.ret(id) as unknown as { ok: boolean; error: unknown; value: unknown };
    if (!result.ok) throw Object.assign(new Error('worker call failed'), result.error as object);
    return result.value;
  };
  // Seed the actual Controller shortcut through a legacy/direct operation with body A.
  await expect(call({ m: 'humanInteractionRequest', communityId, channelId: null, requestId,
    operation: 71, args: ['75'.repeat(16)], revision: null })).resolves.toMatchObject({ upload: 'accepted' });
  w.routes.getBotCommandStatus.mockResolvedValue({ installationId: new Uint8Array(16).fill(0xaa),
    botUserId: USER, state: 3, revision: 1n } as never);
  w.core.humanInteractionEventsRead.mockReturnValue({ events: [{ deliveryId: 9n, groupId,
    communityId: WORKER_COMMUNITY, requestId: rid, sourceSeq: 9n, epoch: 1n, receivedAt: 1n,
    senderUser: USER, senderDevice: DEVICE, messageId: rid,
    body: encodeBotResponse({ requestId: rid, communityId: WORKER_COMMUNITY, status: 0,
      revision: null, data: encode([]) }), operation: 71, channelId: null }], next: 9n, highWater: 9n });
  const client = { get: (name: string) => w.last(name), subscribe: () => () => undefined, call } as unknown as CoreClient;
  const api = createBotInteractionClient(client, communityId);
  await expect(api.read(requestId, 71)).resolves.toMatchObject({ status: 0 });
  await expect(api.request({ requestId, operation: 71, args: ['76'.repeat(16)], revision: null }))
    .rejects.toBeInstanceOf(BotInteractionUnverifiableRequestError);
  expect(w.core.humanInteractionSendPrepare).toHaveBeenCalledTimes(1);
  expect(w.routes.postMessage).toHaveBeenCalledTimes(1);
});

it('blocks request while an actual-worker read is awaiting its first authorization lookup', async () => {
  const w = world();
  await toReady(w);
  const rid = new Uint8Array(16).fill(0x71);
  const requestId = toHex(rid);
  const communityId = toHex(WORKER_COMMUNITY);
  const groupId = new Uint8Array(16).fill(0x52);
  w.state.groups.push({ ...textGroup(2), groupId, kind: 3, targetId: USER });
  w.core.humanInteractionSendPrepare.mockImplementation(id => {
    w.state.outbox.push({ msgId: id, state: 0, error: '', created: 1n, body: 'original persisted body',
      type: 0, replyTo: null, attachments: [] });
    return id;
  });
  let callId = 93000;
  const call = async (command: unknown): Promise<unknown> => {
    const id = callId++;
    w.call(id, command);
    await vi.waitFor(() => expect(w.ret(id)).toBeDefined());
    const result = w.ret(id) as unknown as { ok: boolean; error: unknown; value: unknown };
    if (!result.ok) throw Object.assign(new Error('worker call failed'), result.error as object);
    return result.value;
  };
  await expect(call({ m: 'humanInteractionRequest', communityId, channelId: null, requestId,
    operation: 71, args: ['75'.repeat(16)], revision: null })).resolves.toMatchObject({ upload: 'accepted' });
  w.routes.getBotCommandStatus.mockResolvedValue({ installationId: new Uint8Array(16).fill(0xaa),
    botUserId: USER, state: 3, revision: 1n } as never);
  w.core.humanInteractionEventsRead.mockReturnValue({ events: [{ deliveryId: 9n, groupId,
    communityId: WORKER_COMMUNITY, requestId: rid, sourceSeq: 9n, epoch: 1n, receivedAt: 1n,
    senderUser: USER, senderDevice: DEVICE, messageId: rid,
    body: encodeBotResponse({ requestId: rid, communityId: WORKER_COMMUNITY, status: 0,
      revision: null, data: encode([]) }), operation: 71, channelId: null }], next: 9n, highWater: 9n });
  let releaseReadAuthorization: ((value: unknown) => void) | undefined;
  let readAuthorizationPending = false;
  const adapterCall = (command: { m?: string; [key: string]: unknown }): Promise<unknown> => {
    if (command.m === 'getBotCommandStatus' && !readAuthorizationPending) {
      readAuthorizationPending = true;
      return new Promise(resolve => { releaseReadAuthorization = resolve; });
    }
    return call(command);
  };
  const client = { get: (name: string) => w.last(name), subscribe: () => () => undefined,
    call: adapterCall } as unknown as CoreClient;
  const api = createBotInteractionClient(client, communityId);
  const pendingRead = api.read(requestId, 71);
  await vi.waitFor(() => expect(releaseReadAuthorization).toBeTypeOf('function'));
  await expect(api.request({ requestId, operation: 71, args: ['76'.repeat(16)], revision: null }))
    .rejects.toBeInstanceOf(BotInteractionUnverifiableRequestError);
  releaseReadAuthorization?.({ installationId: 'aa'.repeat(16), botUserId: toHex(USER), state: 3, revision: '1' });
  await expect(pendingRead).resolves.toMatchObject({ status: 0 });
  expect(w.core.humanInteractionSendPrepare).toHaveBeenCalledTimes(1);
  expect(w.routes.postMessage).toHaveBeenCalledTimes(1);
});

it('times out with a typed uncertain result and never resends with a new id', async () => {
  vi.useFakeTimers();
  const f = fake(command => command.m === 'getBotCommandStatus' ? { installationId: INSTALLATION, botUserId: null, state: 3, revision: '1' }
    : command.m === 'humanInteractionRequest' ? { requestId: REQUEST, upload: 'accepted' } : { responses: [], through: null });
  const pending = createBotInteractionClient(f.client, COMMUNITY).request({ requestId: REQUEST, operation: 70, args: [] });
  const rejected = expect(pending).rejects.toBeInstanceOf(BotInteractionUncertainError);
  await vi.advanceTimersByTimeAsync(30_000);
  await rejected;
  expect(f.calls.filter(call => call.m === 'humanInteractionRequest')).toHaveLength(1);
});

it('rechecks active installation before cached result fast paths and invalidates disabled or changed scope', async () => {
  let installation = INSTALLATION, state = 3, reads = 0, sends = 0;
  const f = fake(command => command.m === 'getBotCommandStatus' ? { installationId: installation, botUserId: null, state, revision: '1' }
    : command.m === 'readBotInteractionResponses' ? { responses: [response(++reads === 1 ? 0 : 4)], through: 'b'.repeat(32) }
      : command.m === 'humanInteractionRequest' ? (sends++, { requestId: REQUEST, upload: 'accepted' }) : null);
  const api = createBotInteractionClient(f.client, COMMUNITY);
  await api.read(REQUEST, 70);
  state = 4;
  await expect(api.request({ requestId: REQUEST, operation: 70, args: [] })).rejects.toThrow('not active');
  expect(sends).toBe(0);
  state = 3;
  installation = 'cc'.repeat(16);
  expect((await api.read(REQUEST, 70))?.status).toBe(4);
  expect(reads).toBe(2);
});

it('does not return a pending response if account scope changes while reading', async () => {
  let changed = false;
  const client = {
    get: (name: string) => name === 'account' ? { phase: changed ? 'revoked' : 'ready', user, deviceId: '44'.repeat(16) }
      : name === 'communities' ? [{ id: COMMUNITY }] : name === `permissions:${COMMUNITY}` ? { loaded: true } : undefined,
    subscribe: () => () => {},
    call: vi.fn((command: { m: string; [key: string]: unknown }) => {
      if (command.m === 'getBotCommandStatus') return Promise.resolve({ installationId: INSTALLATION, botUserId: null, state: 3, revision: '1' });
      if (command.m === 'humanInteractionRequest') return Promise.resolve({ requestId: REQUEST, upload: 'accepted' });
      if (command.m === 'readBotInteractionResponses') { changed = true; return Promise.resolve({ responses: [response()], through: 'b'.repeat(32) }); }
      return Promise.resolve(null);
    }),
  } as unknown as CoreClient;
  await expect(createBotInteractionClient(client, COMMUNITY).request({ requestId: REQUEST, operation: 70, args: [] }))
    .rejects.toMatchObject({ name: 'BotInteractionUncertainError', requestId: REQUEST });
});

it('withholds a response from every coalesced reader when installation scope changes before resolution', async () => {
  let statusReads = 0;
  let responseReads = 0;
  let resolveResponse: ((value: unknown) => void) | undefined;
  const f = fake(command => {
    if (command.m === 'getBotCommandStatus') return {
      installationId: ++statusReads <= 2 ? INSTALLATION : 'bb'.repeat(16), botUserId: null, state: 3, revision: '1',
    };
    if (command.m === 'readBotInteractionResponses') {
      responseReads++;
      return new Promise(resolve => { resolveResponse = resolve; });
    }
    if (command.m === 'ackBotInteractionResponses') return null;
    throw new Error(`unexpected command ${command.m}`);
  });
  const api = createBotInteractionClient(f.client, COMMUNITY);
  const first = api.read(REQUEST, 70);
  const second = api.read(REQUEST, 70);
  await vi.waitFor(() => expect(responseReads).toBe(1));
  resolveResponse?.({ responses: [response()], through: 'b'.repeat(32) });
  const [a, b] = await Promise.all([first, second]);
  expect(a).toBeNull();
  expect(b).toBeNull();
  expect(statusReads).toBe(3);
  expect(responseReads).toBe(1);
});

it('rejects an in-flight status lookup after the account device/store scope changes', async () => {
  let deviceId = '44'.repeat(16);
  let finishStatus: ((value: unknown) => void) | undefined;
  let sends = 0;
  const client = {
    get: (name: string) => name === 'account' ? { phase: 'ready', user, deviceId }
      : name === 'communities' ? [{ id: COMMUNITY }] : name === `permissions:${COMMUNITY}` ? { loaded: true } : undefined,
    subscribe: () => () => {},
    call: vi.fn((command: { m: string; [key: string]: unknown }) => {
      if (command.m === 'getBotCommandStatus') return new Promise(resolve => { finishStatus = resolve; });
      if (command.m === 'humanInteractionRequest') { sends++; return Promise.resolve({ requestId: REQUEST, upload: 'accepted' }); }
      return Promise.resolve(null);
    }),
  } as unknown as CoreClient;
  const pending = createBotInteractionClient(client, COMMUNITY).request({ requestId: REQUEST, operation: 70, args: [] });
  await vi.waitFor(() => expect(finishStatus).toBeTypeOf('function'));
  deviceId = '55'.repeat(16);
  finishStatus?.({ installationId: INSTALLATION, botUserId: null, state: 3, revision: '1' });
  await expect(pending).rejects.toThrow('changed during authorization');
  expect(sends).toBe(0);
});
