import { afterEach, expect, it, vi } from 'vitest';
import type { CoreClient } from '../bridge';
import { createBotInteractionClient, BotInteractionRejectedError, BotInteractionUncertainError } from './interactions';

const COMMUNITY = '11'.repeat(16);
const REQUEST = '22'.repeat(16);
const response = (status = 0) => ({ deliveryId: '7', requestId: REQUEST, operation: 70, status, revision: '3', data: new Uint8Array([9]) });

function fake(handler: (command: { m: string; [key: string]: unknown }) => unknown | Promise<unknown>) {
  const calls: { m: string; [key: string]: unknown }[] = [];
  const client = { call: vi.fn((command: { m: string; [key: string]: unknown }) => {
    calls.push(command); return Promise.resolve(handler(command));
  }) } as unknown as CoreClient;
  return { client, calls };
}

afterEach(() => { vi.useRealTimers(); });

it('sends once, reads only the exact pending request and returns domain status consistently', async () => {
  let reads = 0;
  const f = fake(command => {
    if (command.m === 'humanInteractionRequest') return { requestId: REQUEST, upload: 'accepted' };
    if (command.m === 'readBotInteractionResponses') return { responses: ++reads === 1 ? [] : [response(4)], through: reads === 1 ? null : '1' };
    return null;
  });
  const api = createBotInteractionClient(f.client, COMMUNITY);
  const result = await api.request({ requestId: REQUEST, operation: 70, args: [new Uint8Array([1])] });
  expect(result).toEqual({ requestId: REQUEST, status: 4, revision: '3', data: new Uint8Array([9]) });
  expect(f.calls.filter(call => call.m === 'humanInteractionRequest')).toHaveLength(1);
  expect(f.calls.filter(call => call.m === 'readBotInteractionResponses').every(call =>
    call.requestIds instanceof Array && call.requestIds[0] === REQUEST)).toBe(true);
  expect(f.calls.at(-1)?.m).toBe('ackBotInteractionResponses');
});

it('exposes same-id reload reconciliation without sending another mutation', async () => {
  const f = fake(command => command.m === 'readBotInteractionResponses'
    ? { responses: [response()], through: '2' } : null);
  const result = await createBotInteractionClient(f.client, COMMUNITY).read(REQUEST, 70);
  expect(result?.requestId).toBe(REQUEST);
  expect(f.calls.map(call => call.m)).toEqual(['getBotInstallation', 'readBotInteractionResponses', 'ackBotInteractionResponses']);
});

it('shares one client per core/community and coalesces concurrent requests and reads for the same id', async () => {
  const f = fake(command => command.m === 'humanInteractionRequest'
    ? { requestId: REQUEST, upload: 'accepted' }
    : command.m === 'readBotInteractionResponses' ? { responses: [response()], through: '8' } : null);
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
  const f = fake(command => command.m === 'getBotInstallation' ? { id: installation }
    : command.m === 'readBotInteractionResponses' ? { responses: [response(++reads === 1 ? 0 : 4)], through: String(reads) } : null);
  const api = createBotInteractionClient(f.client, COMMUNITY);
  expect((await api.read(REQUEST, 70))?.status).toBe(0);
  installation = 'bb'.repeat(16);
  expect((await api.read(REQUEST, 70))?.status).toBe(4);
  expect(reads).toBe(2);
});

it('turns pending and rejected uploads into typed errors carrying the stable request id', async () => {
  for (const upload of ['pending', 'unknown']) {
    const f = fake(() => ({ requestId: REQUEST, upload }));
    const api = createBotInteractionClient(f.client, COMMUNITY);
    await expect(api.request({ requestId: REQUEST, operation: 70, args: [] }))
      .rejects.toMatchObject({ name: 'BotInteractionUncertainError', requestId: REQUEST });
    await expect(api.request({ requestId: REQUEST, operation: 70, args: [] }))
      .rejects.toMatchObject({ name: 'BotInteractionUncertainError', requestId: REQUEST });
    expect(f.calls.filter(call => call.m === 'humanInteractionRequest')).toHaveLength(1);
  }
  const rejected = fake(() => ({ requestId: REQUEST, upload: 'rejected' }));
  await expect(createBotInteractionClient(rejected.client, COMMUNITY).request({ requestId: REQUEST, operation: 70, args: [] }))
    .rejects.toBeInstanceOf(BotInteractionRejectedError);
  expect(rejected.calls.filter(call => call.m === 'humanInteractionRequest')).toHaveLength(1);
});

it('times out with a typed uncertain result and never resends with a new id', async () => {
  vi.useFakeTimers();
  const f = fake(command => command.m === 'humanInteractionRequest'
    ? { requestId: REQUEST, upload: 'accepted' } : { responses: [], through: null });
  const pending = createBotInteractionClient(f.client, COMMUNITY).request({ requestId: REQUEST, operation: 70, args: [] });
  const rejected = expect(pending).rejects.toBeInstanceOf(BotInteractionUncertainError);
  await vi.advanceTimersByTimeAsync(30_000);
  await rejected;
  expect(f.calls.filter(call => call.m === 'humanInteractionRequest')).toHaveLength(1);
});
