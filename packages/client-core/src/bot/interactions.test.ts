import { afterEach, expect, it, vi } from 'vitest';
import type { CoreClient } from '../bridge';
import { createBotInteractionClient, BotInteractionRejectedError, BotInteractionUncertainError } from './interactions';

const COMMUNITY = '11'.repeat(16);
const REQUEST = '22'.repeat(16);
const INSTALLATION = 'aa'.repeat(16);
const user = { id: '33'.repeat(16), username: 'member' };
const response = (status = 0) => ({ deliveryId: '7', requestId: REQUEST, operation: 70, status, revision: '3', data: new Uint8Array([9]) });

function fake(handler: (command: { m: string; [key: string]: unknown }) => unknown | Promise<unknown>) {
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
  expect(result).toEqual({ requestId: REQUEST, status: 4, revision: '3', data: new Uint8Array([9]) });
  expect(f.calls.filter(call => call.m === 'humanInteractionRequest')).toHaveLength(1);
  expect(f.calls.filter(call => call.m === 'readBotInteractionResponses').every(call =>
    call.requestIds instanceof Array && call.requestIds[0] === REQUEST)).toBe(true);
  expect(f.calls.filter(call => call.m === 'ackBotInteractionResponses')).toHaveLength(1);
});

it('exposes same-id reload reconciliation without sending another mutation', async () => {
  const f = fake(command => command.m === 'getBotCommandStatus' ? { installationId: INSTALLATION, botUserId: null, state: 3, revision: '1' }
    : command.m === 'readBotInteractionResponses' ? { responses: [response()], through: 'b'.repeat(32) } : null);
  const result = await createBotInteractionClient(f.client, COMMUNITY).read(REQUEST, 70);
  expect(result?.requestId).toBe(REQUEST);
  expect(f.calls.map(call => call.m)).toEqual(['getBotCommandStatus', 'readBotInteractionResponses', 'ackBotInteractionResponses', 'getBotCommandStatus']);
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
