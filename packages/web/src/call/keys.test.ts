/* eslint-disable @typescript-eslint/require-await -- the doubles answer as the async functions they stand for do */
import { describe, expect, it, vi } from 'vitest';
import type { CallKeys } from '@dilla/client-core';
import type { EpochKeys } from '@dilla/media';
import { createKeyRelay, toEpochKeys } from './keys.ts';

const CALL = 'a1'.repeat(16);
const OTHER = 'ff'.repeat(16);
const GROUP = 'b2'.repeat(16);
const DEV = (n: number) => n.toString(16).padStart(2, '0').repeat(16);
const USER = (n: number) => (n + 0x40).toString(16).padStart(2, '0').repeat(16);

function keysFor(epoch: bigint, roster = [{ leaf: 0, deviceId: DEV(1), userId: USER(1) }]): CallKeys {
  return { groupId: GROUP, epoch: epoch.toString(), baseKey: new Uint8Array(16).fill(0x5a).buffer, selfLeaf: 0, roster };
}

const zero = (b: Uint8Array | ArrayBuffer) => new Uint8Array(b instanceof ArrayBuffer ? b : b.buffer).every((x) => x === 0);

/** Every copy the relay makes is recorded, so a test can check that each one is zero-filled at the end. */
function harness(installImpl?: (k: EpochKeys) => Promise<void>) {
  const copies: Uint8Array[] = [];
  const relay = createKeyRelay({ copy: (b) => { const c = new Uint8Array(b.slice(0)); copies.push(c); return c; } });
  const installs: EpochKeys[] = [];
  const settles: Array<{ resolve: () => void; reject: (e: Error) => void }> = [];
  const installer = {
    installEpoch: vi.fn((k: EpochKeys) => {
      installs.push(k);
      if (installImpl) return installImpl(k);
      return new Promise<void>((resolve, reject) => settles.push({ resolve, reject }));
    }),
  };
  return { relay, copies, installs, installer, settles };
}

const flush = () => new Promise<void>((r) => setTimeout(r, 0));

describe('the call key relay (decision 3, L-WEB-50)', () => {
  it('copies the join key synchronously, hands back the one for this call and epoch, and zero-fills every other buffered copy', () => {
    const { relay, copies } = harness();
    const join = keysFor(4n);
    relay.listener(CALL, keysFor(3n));
    relay.listener(CALL, join);
    relay.listener(OTHER, keysFor(4n));
    // The copy outlives the push: the bridge zero-fills the transferred buffer as soon as the listener returns.
    new Uint8Array(join.baseKey).fill(0);
    const got = relay.takeJoin(CALL, 4n);
    expect(got).not.toBeNull();
    expect(got!.epoch).toBe(4n);
    expect([...got!.baseKey]).toEqual(new Array(16).fill(0x5a));
    expect(copies).toHaveLength(3);
    expect(copies.filter((c) => !zero(c))).toEqual([got!.baseKey]);
  });

  it('takeJoin without a matching copy returns null and leaves no copy unzeroed', () => {
    const { relay, copies } = harness();
    relay.listener(CALL, keysFor(1n));
    relay.listener(OTHER, keysFor(2n));
    expect(relay.takeJoin(CALL, 2n)).toBeNull();
    expect(copies.every(zero)).toBe(true);
  });

  it('keeps at most four copies before the join answer, zero-filling the oldest', () => {
    const { relay, copies } = harness();
    for (let e = 1n; e <= 6n; e++) relay.listener(CALL, keysFor(e));
    expect(copies.slice(0, 2).every(zero)).toBe(true);
    expect(relay.takeJoin(CALL, 1n)).toBeNull();
    expect(copies.every(zero)).toBe(true);
  });

  it('installs each later key at once with minEpoch = the join epoch, and zero-fills the copy once the install settles', async () => {
    const { relay, copies, installs, installer, settles } = harness();
    relay.listener(CALL, keysFor(5n));
    const join = relay.takeJoin(CALL, 5n)!;
    relay.attach(installer);
    relay.listener(CALL, keysFor(6n));
    expect(installs.map((k) => [k.epoch, k.minEpoch])).toEqual([[6n, 5n]]);
    expect(installs[0].roster).toEqual([{ leaf: 0, deviceId: DEV(1) }]);
    expect(zero(installs[0].baseKey)).toBe(false);
    settles[0].resolve();
    await flush();
    expect(zero(installs[0].baseKey)).toBe(true);
    relay.listener(CALL, keysFor(7n));
    settles[1].reject(new Error('E_NO_EPOCH: refused'));
    await flush();
    expect(zero(installs[1].baseKey)).toBe(true);
    join.baseKey.fill(0);
    expect(copies.every(zero)).toBe(true);
  });

  it('a key for another call is zero-filled, source and all, and never installed', () => {
    const { relay, installs, installer } = harness();
    relay.listener(CALL, keysFor(1n));
    relay.takeJoin(CALL, 1n)!.baseKey.fill(0);
    relay.attach(installer);
    const foreign = keysFor(9n);
    relay.listener(OTHER, foreign);
    expect(installs).toEqual([]);
    expect(zero(foreign.baseKey)).toBe(true);
  });

  it('a stale epoch (not above the newest one handed over) is zero-filled and never installed', () => {
    const { relay, installs, installer, copies } = harness();
    relay.listener(CALL, keysFor(3n));
    relay.takeJoin(CALL, 3n)!.baseKey.fill(0);
    relay.attach(installer);
    const stale = keysFor(3n);
    relay.listener(CALL, stale);
    relay.listener(CALL, keysFor(2n));
    expect(installs).toEqual([]);
    expect(zero(stale.baseKey)).toBe(true);
    expect(copies.every(zero)).toBe(true);
  });

  it('holds a key that arrives between the join answer and attach, and installs it on attach', () => {
    const { relay, installs, installer } = harness();
    relay.listener(CALL, keysFor(1n));
    relay.takeJoin(CALL, 1n)!.baseKey.fill(0);
    relay.listener(CALL, keysFor(2n));
    expect(installs).toEqual([]);
    relay.attach(installer);
    expect(installs.map((k) => k.epoch)).toEqual([2n]);
  });

  it('while paused nothing is installed; only the newest copy is held, and resume installs it', async () => {
    const { relay, installs, installer, copies } = harness(async () => undefined);
    relay.listener(CALL, keysFor(1n));
    relay.takeJoin(CALL, 1n)!.baseKey.fill(0);
    relay.attach(installer);
    relay.setPaused(true);
    relay.listener(CALL, keysFor(2n));
    expect(installs).toEqual([]);
    relay.listener(CALL, keysFor(3n));
    expect(installs).toEqual([]);
    expect(zero(copies[1])).toBe(true); // epoch 2's copy, replaced by epoch 3
    relay.setPaused(false);
    expect(installs.map((k) => k.epoch)).toEqual([3n]);
    await flush();
    expect(copies.every(zero)).toBe(true);
  });

  it('close() zero-fills every held copy and no key is installed after it', () => {
    const { relay, installs, installer, copies } = harness();
    relay.listener(CALL, keysFor(1n));
    relay.takeJoin(CALL, 1n)!.baseKey.fill(0);
    relay.listener(CALL, keysFor(2n)); // pending until attach
    relay.close();
    relay.attach(installer);
    const late = keysFor(3n);
    relay.listener(CALL, late);
    expect(installs).toEqual([]);
    expect(zero(late.baseKey)).toBe(true);
    expect(copies.every(zero)).toBe(true);
  });

  it('close() while paused zero-fills the held copy', () => {
    const { relay, installer, copies } = harness();
    relay.listener(CALL, keysFor(1n));
    relay.takeJoin(CALL, 1n)!.baseKey.fill(0);
    relay.attach(installer);
    relay.setPaused(true);
    relay.listener(CALL, keysFor(2n));
    relay.close();
    relay.setPaused(false);
    expect(installer.installEpoch).not.toHaveBeenCalled();
    expect(copies.every(zero)).toBe(true);
  });

  it('an install that throws synchronously still zero-fills its copy', () => {
    const { relay, copies } = harness();
    relay.listener(CALL, keysFor(1n));
    relay.takeJoin(CALL, 1n)!.baseKey.fill(0);
    relay.attach({ installEpoch: () => { throw new Error('E_NO_EPOCH: disposed'); } });
    expect(() => relay.listener(CALL, keysFor(2n))).not.toThrow();
    expect(copies.every(zero)).toBe(true);
  });

  it('reports the join roster at takeJoin and each later roster only once its install resolved (review m6)', async () => {
    const rosters: Array<Array<[string, string]>> = [];
    const r2 = createKeyRelay({ onRoster: (m) => rosters.push([...m.entries()].map(([d, v]) => [d, v.userId])) });
    const settles: Array<{ resolve: () => void; reject: (e: Error) => void }> = [];
    const installer = { installEpoch: () => new Promise<void>((resolve, reject) => settles.push({ resolve, reject })) };
    r2.listener(CALL, keysFor(1n));
    r2.takeJoin(CALL, 1n)!.baseKey.fill(0);
    expect(rosters).toEqual([[[DEV(1), USER(1)]]]);
    r2.attach(installer);
    const two = [{ leaf: 0, deviceId: DEV(1), userId: USER(1) }, { leaf: 1, deviceId: DEV(2), userId: USER(2) }];
    r2.listener(CALL, keysFor(2n, two));
    expect(rosters).toHaveLength(1);
    settles[0].resolve();
    await flush();
    expect(rosters).toEqual([[[DEV(1), USER(1)]], [[DEV(1), USER(1)], [DEV(2), USER(2)]]]);
    r2.listener(CALL, keysFor(3n, [{ leaf: 0, deviceId: DEV(1), userId: USER(1) }]));
    settles[1].reject(new Error('E_NO_EPOCH: refused'));
    await flush();
    expect(rosters).toHaveLength(2);
  });

  it('takeJoin keeps a newer key of the same call that raced the join answer, and installs it on attach (review m2)', () => {
    const { relay, installs, installer, copies } = harness();
    relay.listener(CALL, keysFor(1n));
    relay.listener(CALL, keysFor(3n));
    relay.listener(CALL, keysFor(2n));
    relay.listener(OTHER, keysFor(4n));
    relay.takeJoin(CALL, 1n)!.baseKey.fill(0);
    // epoch 2 and the other call's 4 are zero-filled at once; 3 is held.
    expect(zero(copies[2])).toBe(true);
    expect(zero(copies[3])).toBe(true);
    expect(zero(copies[1])).toBe(false);
    relay.attach(installer);
    expect(installs.map((k) => [k.epoch, k.minEpoch])).toEqual([[3n, 1n]]);
    relay.listener(CALL, keysFor(2n));
    expect(installs).toHaveLength(1);
  });

  it('a push with a malformed roster leaves no copy unzeroed and does not throw (review m3)', () => {
    const { relay, copies, installer, installs } = harness();
    relay.listener(CALL, keysFor(1n));
    relay.takeJoin(CALL, 1n)!.baseKey.fill(0);
    relay.attach(installer);
    const bad = { ...keysFor(2n), roster: null } as unknown as CallKeys;
    expect(() => relay.listener(CALL, bad)).not.toThrow();
    expect(zero(bad.baseKey)).toBe(true);
    expect(installs).toEqual([]);
    expect(copies.every(zero)).toBe(true);
  });

  it('toEpochKeys keeps leaf and device only and carries the given minEpoch', () => {
    const k = toEpochKeys({ callId: CALL, groupId: GROUP, epoch: 9n, baseKey: new Uint8Array(16), selfLeaf: 2,
      roster: [{ leaf: 2, deviceId: DEV(3), userId: USER(3) }] }, 7n);
    expect(k).toEqual({ groupId: GROUP, epoch: 9n, minEpoch: 7n, baseKey: new Uint8Array(16), selfLeaf: 2, roster: [{ leaf: 2, deviceId: DEV(3) }] });
  });
});
