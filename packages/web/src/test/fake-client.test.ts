import { describe, expect, it, vi } from 'vitest';
import { FakeClient } from './fake-client.ts';

// Lesson f: the double answers onCallKeys as the real bridge does (packages/client-core/src/bridge.ts).
describe('FakeClient.pushCallKeys', () => {
  it('isolates a throwing listener, rethrows it in a microtask, and still zero-fills the key', () => {
    const client = new FakeClient();
    const rethrown: unknown[] = [];
    const micro = vi.spyOn(globalThis, 'queueMicrotask').mockImplementation((cb: () => void) => {
      try { cb(); } catch (err) { rethrown.push(err); }
    });
    try {
      const boom = new Error('listener failed');
      client.onCallKeys(() => { throw boom; });
      const seen: number[][] = [];
      client.onCallKeys((_, k) => { seen.push([...new Uint8Array(k.baseKey)]); });
      const baseKey = new Uint8Array(16).fill(4).buffer;
      client.pushCallKeys('aa'.repeat(16), { groupId: 'bb'.repeat(16), epoch: '1', baseKey, selfLeaf: 0, roster: [] });
      expect(seen).toEqual([Array(16).fill(4)]);
      expect(rethrown).toEqual([boom]);
      expect([...new Uint8Array(baseKey)]).toEqual(Array(16).fill(0));
    } finally {
      micro.mockRestore();
    }
  });
});
