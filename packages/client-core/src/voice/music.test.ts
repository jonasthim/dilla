import { describe, expect, it, vi } from 'vitest';
import { encode } from '../cbor';
import type { CoreClient } from '../bridge';
import { createVoiceMusicAdapter, voiceMusicAdapter } from './music.ts';

const COMMUNITY = 'ab'.repeat(16);
const CHANNEL = 'cd'.repeat(16);
const ITEM = Uint8Array.from({ length: 16 }, (_, i) => i + 1);

function snapshot(revision: bigint, paused: boolean, canControl = true) {
  return encode([1n, revision, ['ef'.repeat(16), 'youtube', 'abcdefghijk', 'Track', 'Artist', '', 120_000n, ITEM], [], 0n,
    paused ? 1n : 0n, 75n, 0n, 0n, canControl ? 1n : 0n]);
}

function response(request: Record<string, unknown>, deliveryId: string, status: number, revision: string | null, data: Uint8Array) {
  return { deliveryId, requestId: request.requestId as string, communityId: COMMUNITY, operation: request.operation as number,
    channelId: CHANNEL, status, revision, data, sourceSeq: deliveryId };
}

function fixture() {
  const commands: Record<string, unknown>[] = [];
  const events: ReturnType<typeof response>[] = [];
  let id = 0;
  const client = {
    call: vi.fn((command: Record<string, unknown>) => {
      commands.push(command);
      if (command.m === 'humanInteractionRequest') return Promise.resolve({ upload: 'accepted' });
      if (command.m === 'readBotInteractionResponses') return Promise.resolve({ responses: events.splice(0), through: null, blocked: false });
      return Promise.resolve(null);
    }),
    get: () => undefined,
    subscribe: () => () => undefined,
    onCallKeys: () => () => undefined,
    dispose: () => undefined,
  } as unknown as CoreClient;
  return {
    client, commands,
    adapter: createVoiceMusicAdapter(client, COMMUNITY),
    getRequest(operation: number) { return [...commands].reverse().find(command => command.m === 'humanInteractionRequest' && command.operation === operation)!; },
    answer(request: Record<string, unknown>, status: number, revision: string | null, data: Uint8Array) {
      events.push(response(request, String(++id), status, revision, data));
    },
  };
}

describe('authenticated voice music adapter', () => {
  it('keeps the unavailable fallback until it receives an authenticated state snapshot', async () => {
    expect(voiceMusicAdapter.state(CHANNEL)).toEqual({ status: 'unavailable', reason: 'authenticated-transport-missing' });
    await expect(voiceMusicAdapter.pause(CHANNEL, true)).rejects.toThrow(/transport is unavailable/);
  });

  it('decodes a Bot state response and acks only after applying it', async () => {
    const f = fixture();
    const unsubscribe = f.adapter.subscribe(CHANNEL, () => undefined);
    await vi.waitFor(() => expect(f.getRequest(10)).toBeDefined());
    f.answer(f.getRequest(10), 0, '1', snapshot(1n, false));
    await vi.waitFor(() => expect(f.adapter.state(CHANNEL).status).toBe('available'));
    const state = f.adapter.state(CHANNEL);
    expect(state).toMatchObject({ status: 'available', track: { id: 'ef'.repeat(16), title: 'Track', artist: 'Artist' },
      queue: [], positionMs: 0, volume: 75, paused: false, shuffle: false, repeat: 'off',
      permissions: { control: true, manageQueue: true } });
    unsubscribe();
  });

  it('does not resolve a mutation on upload receipt and waits for the operation and resulting snapshot', async () => {
    const f = fixture();
    const unsubscribe = f.adapter.subscribe(CHANNEL, () => undefined);
    await vi.waitFor(() => expect(f.getRequest(10)).toBeDefined());
    f.answer(f.getRequest(10), 0, '1', snapshot(1n, false));
    await vi.waitFor(() => expect(f.adapter.state(CHANNEL)).toMatchObject({ status: 'available', paused: false }));

    let settled = false;
    const command = Promise.resolve(f.adapter.pause(CHANNEL, true)).then(() => { settled = true; });
    await vi.waitFor(() => expect(f.getRequest(13)).toBeDefined());
    expect(f.getRequest(13)?.revision).toBe('1');
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(settled).toBe(false);

    f.answer(f.getRequest(13), 0, '2', encode([]));
    await vi.waitFor(() => expect(f.commands.filter(call => call.m === 'humanInteractionRequest' && call.operation === 10)).toHaveLength(2));
    const reads = f.commands.filter(call => call.m === 'humanInteractionRequest' && call.operation === 10);
    f.answer(reads[1], 0, '2', snapshot(2n, true));
    await command;
    expect(settled).toBe(true);
    expect(f.adapter.state(CHANNEL)).toMatchObject({ status: 'available', paused: true });
    unsubscribe();
  });

  it('surfaces a Bot rejection without changing the confirmed snapshot', async () => {
    const f = fixture();
    const unsubscribe = f.adapter.subscribe(CHANNEL, () => undefined);
    await vi.waitFor(() => expect(f.getRequest(10)).toBeDefined());
    f.answer(f.getRequest(10), 0, '1', snapshot(1n, false));
    await vi.waitFor(() => expect(f.adapter.state(CHANNEL).status).toBe('available'));
    const command = Promise.resolve(f.adapter.pause(CHANNEL, true));
    await vi.waitFor(() => expect(f.getRequest(13)).toBeDefined());
    f.answer(f.getRequest(13), 2, '1', encode([]));
    await expect(command).rejects.toThrow(/permission/);
    expect(f.adapter.state(CHANNEL)).toMatchObject({ status: 'available', paused: false });
    unsubscribe();
  });

  it('keeps controls read-only when the authenticated snapshot denies the current actor DJ access', async () => {
    const f = fixture();
    const unsubscribe = f.adapter.subscribe(CHANNEL, () => undefined);
    await vi.waitFor(() => expect(f.getRequest(10)).toBeDefined());
    f.answer(f.getRequest(10), 0, '1', snapshot(1n, false, false));
    await vi.waitFor(() => expect(f.adapter.state(CHANNEL)).toMatchObject({ status: 'available',
      permissions: { control: false, manageQueue: false } }));
    unsubscribe();
  });

  it('refreshes the revision after a conflict before rejecting, so the next control uses current state', async () => {
    const f = fixture();
    const unsubscribe = f.adapter.subscribe(CHANNEL, () => undefined);
    await vi.waitFor(() => expect(f.getRequest(10)).toBeDefined());
    f.answer(f.getRequest(10), 0, '1', snapshot(1n, false));
    await vi.waitFor(() => expect(f.adapter.state(CHANNEL).status).toBe('available'));

    const conflict = Promise.resolve(f.adapter.pause(CHANNEL, true));
    await vi.waitFor(() => expect(f.commands.filter(call => call.m === 'humanInteractionRequest' && call.operation === 13)).toHaveLength(1));
    const firstMutation = f.commands.find(call => call.m === 'humanInteractionRequest' && call.operation === 13)!;
    expect(firstMutation.revision).toBe('1');
    f.answer(firstMutation, 4, '2', encode([]));
    await vi.waitFor(() => expect(f.commands.filter(call => call.m === 'humanInteractionRequest' && call.operation === 10)).toHaveLength(2));
    const reads = f.commands.filter(call => call.m === 'humanInteractionRequest' && call.operation === 10);
    f.answer(reads[1], 0, '2', snapshot(2n, false));
    await expect(conflict).rejects.toThrow(/state changed/);
    expect(f.adapter.state(CHANNEL)).toMatchObject({ status: 'available', paused: false });

    const retry = Promise.resolve(f.adapter.pause(CHANNEL, true));
    await vi.waitFor(() => expect(f.commands.filter(call => call.m === 'humanInteractionRequest' && call.operation === 13)).toHaveLength(2));
    const secondMutation = f.commands.filter(call => call.m === 'humanInteractionRequest' && call.operation === 13)[1];
    expect(secondMutation.revision).toBe('2');
    f.answer(secondMutation, 0, '3', encode([]));
    await vi.waitFor(() => expect(f.commands.filter(call => call.m === 'humanInteractionRequest' && call.operation === 10)).toHaveLength(3));
    const updatedReads = f.commands.filter(call => call.m === 'humanInteractionRequest' && call.operation === 10);
    f.answer(updatedReads[2], 0, '3', snapshot(3n, true));
    await retry;
    expect(f.adapter.state(CHANNEL)).toMatchObject({ status: 'available', paused: true });
    unsubscribe();
  });
});
