import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EpochKeys } from '../src/manager';

/* eslint-disable @typescript-eslint/no-explicit-any */
const h = vi.hoisted(() => {
  const state = {
    order: [] as string[], rooms: [] as any[], managers: [] as any[],
    enableOnConnect: true, support: { ok: true, path: 'insertable-streams' } as any,
  };
  class FakeEmitter {
    l = new Map<string, Array<(...a: any[]) => void>>();
    on(e: string, f: (...a: any[]) => void): this { this.l.set(e, [...(this.l.get(e) ?? []), f]); return this; }
    off(e: string, f: (...a: any[]) => void): this { this.l.set(e, (this.l.get(e) ?? []).filter((x) => x !== f)); return this; }
    emit(e: string, ...a: any[]): boolean { for (const f of this.l.get(e) ?? []) f(...a); return true; }
  }
  class FakeRoom extends FakeEmitter {
    isE2EEEnabled = false;
    localParticipant = { identity: 'a1'.repeat(16) };
    engine = { rtcConfig: { iceTransportPolicy: 'all' } as RTCConfiguration };
    connectArgs: unknown[] = [];
    opts: any;
    constructor(opts: any) { super(); this.opts = opts; state.rooms.push(this); state.order.push('new Room'); }
    async setE2EEEnabled(v: boolean): Promise<void> { state.order.push(`setE2EEEnabled(${v})`); }
    async connect(...args: unknown[]): Promise<void> {
      state.order.push('connect');
      this.connectArgs = args;
      if (state.enableOnConnect) {
        setTimeout(() => { this.isE2EEEnabled = true; this.emit('participantEncryptionStatusChanged', true, this.localParticipant); }, 1);
      }
    }
    async disconnect(): Promise<void> { state.order.push('disconnect'); }
  }
  class FakeManager {
    worker: unknown;
    installEpoch = vi.fn(async () => { state.order.push('installEpoch'); });
    dispose = vi.fn(() => { state.order.push('dispose'); });
    constructor(worker: unknown) { this.worker = worker; state.managers.push(this); }
  }
  const createMediaWorker = vi.fn(() => ({ terminate: vi.fn(() => { state.order.push('terminate'); }) }));
  return { state, FakeRoom, FakeManager, createMediaWorker };
});

vi.mock('livekit-client', () => ({ Room: h.FakeRoom }));
vi.mock('../src/manager', () => ({ DillaE2EEManager: h.FakeManager, createMediaWorker: h.createMediaWorker }));
vi.mock('../src/support', () => ({ isVoiceSupported: () => h.state.support }));

import { joinCall, refreshIceServers, type JoinCallOptions } from '../src/connect';

const held = new Set<string>();
const epoch = (): EpochKeys => ({ groupId: 'g', epoch: 3n, baseKey: new Uint8Array(16), selfLeaf: 0, minEpoch: 3n, roster: [{ leaf: 0, deviceId: 'a1'.repeat(16) }] });
const options = (o: Partial<JoinCallOptions> = {}): JoinCallOptions => ({
  livekitUrl: 'wss://dilla.test', token: 'jwt', iceServers: [], epoch: epoch(), lock: { instanceId: 'inst', callGroupId: 'cg' }, ...o,
});

beforeEach(() => {
  h.state.order.length = 0;
  h.state.rooms.length = 0;
  h.state.managers.length = 0;
  h.state.enableOnConnect = true;
  h.state.support = { ok: true, path: 'insertable-streams' };
  h.createMediaWorker.mockClear();
  held.clear();
  vi.stubGlobal('navigator', {
    userAgent: 'test',
    locks: {
      request: async (name: string, _o: unknown, cb: (lock: unknown) => Promise<void>): Promise<void> => {
        if (held.has(name)) return cb(null);
        held.add(name);
        try { return await cb({ name, mode: 'exclusive' }); } finally { held.delete(name); }
      },
    },
  });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('joinCall (DEV-27)', () => {
  it('installs the epoch, enables E2EE before connect, and resolves once the local participant is encrypted', async () => {
    const s = await joinCall(options());
    expect(h.state.order).toEqual(['installEpoch', 'new Room', 'setE2EEEnabled(true)', 'connect']);
    expect(s.room).toBe(h.state.rooms[0]);
    expect(s.manager).toBe(h.state.managers[0]);
    expect(h.state.rooms[0].isE2EEEnabled).toBe(true);
  });

  it('builds Room with e2ee: { e2eeManager } and the dilla publish defaults; the caller cannot replace the manager', async () => {
    await joinCall(options({ roomOptions: { e2ee: undefined, adaptiveStream: true } }));
    const room = h.state.rooms[0];
    expect(room.opts.e2ee.e2eeManager).toBe(h.state.managers[0]);
    expect(room.opts.adaptiveStream).toBe(true);
    expect(room.opts.publishDefaults).toMatchObject({
      audioPreset: { maxBitrate: 64_000, priority: 'high' }, dtx: true, red: false, forceStereo: false, videoCodec: 'vp8', simulcast: true, backupCodec: false,
    });
  });

  it('always passes iceServers (also []) and max-bundle (DEV-52, DEV-54)', async () => {
    await joinCall(options());
    expect(h.state.rooms[0].connectArgs).toEqual(['wss://dilla.test', 'jwt', expect.objectContaining({ rtcConfig: { iceServers: [], bundlePolicy: 'max-bundle' } })]);
    await (await joinCall(options({ lock: { instanceId: 'inst', callGroupId: 'cg2' }, iceServers: [[['turn:dilla.test:443?transport=udp'], 'u', 'c']] }))).release();
    expect(h.state.rooms[1].connectArgs[2].rtcConfig.iceServers).toEqual([{ urls: ['turn:dilla.test:443?transport=udp'], username: 'u', credential: 'c' }]);
  });

  it('refuses with E_CALL_IN_OTHER_TAB while another tab holds the media lock (N2)', async () => {
    held.add('dilla-media:inst:cg');
    await expect(joinCall(options())).rejects.toThrow('E_CALL_IN_OTHER_TAB');
    expect(h.state.order).toEqual([]);
    expect(h.createMediaWorker).not.toHaveBeenCalled();
  });

  it('refuses an unsupported browser before taking the lock', async () => {
    h.state.support = { ok: false, reason: 'no-transform-api' };
    await expect(joinCall(options())).rejects.toThrow('E_E2EE_REQUIRED: no-transform-api');
    expect(h.createMediaWorker).not.toHaveBeenCalled();
  });

  it('gives up with E_E2EE_REQUIRED and cleans up when the local participant never becomes encrypted', async () => {
    vi.useFakeTimers();
    h.state.enableOnConnect = false;
    const p = joinCall(options());
    const assertion = expect(p).rejects.toThrow('E_E2EE_REQUIRED');
    await vi.advanceTimersByTimeAsync(10_001);
    await assertion;
    expect(h.state.order.slice(-3)).toEqual(['dispose', 'disconnect', 'terminate']);
    await vi.waitFor(() => expect(held.size).toBe(0));
  });

  it('release disposes, disconnects, terminates and frees the lock', async () => {
    const s = await joinCall(options());
    await s.release();
    expect(h.state.order.slice(-3)).toEqual(['dispose', 'disconnect', 'terminate']);
    await vi.waitFor(() => expect(held.size).toBe(0));
    await expect(joinCall(options())).resolves.toBeDefined();
  });

  it('refreshIceServers swaps the live credentials on room.engine.rtcConfig (DEV-53)', async () => {
    const s = await joinCall(options());
    refreshIceServers(s.room, [[['turn:dilla.test:443?transport=tcp'], 'u2', 'c2']]);
    expect(h.state.rooms[0].engine.rtcConfig).toEqual({ iceTransportPolicy: 'all', iceServers: [{ urls: ['turn:dilla.test:443?transport=tcp'], username: 'u2', credential: 'c2' }] });
  });
});
