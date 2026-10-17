/* eslint-disable @typescript-eslint/require-await -- the doubles answer as the async functions they stand for do */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CallJoinResult, CallKeys, Command } from '@dilla/client-core';
import type { EpochKeys, JoinCallOptions } from '@dilla/media';
import { startPageCall, type PageCall, type PageCallDeps, type PageCallOptions } from './session.ts';

const CH = 'c1'.repeat(16);
const callId = 'a1'.repeat(16);
const GROUP = 'b2'.repeat(16);
const ME = 'd0'.repeat(16);
const ALICE = 'd1'.repeat(16);
const DEV_D = 'd4'.repeat(16);
const BOB = 'e1'.repeat(16);
const BOB_DEV = 'd2'.repeat(16);
const CAROL = 'e2'.repeat(16);
const CAROL_DEV = 'd3'.repeat(16);
const ME_USER = 'e0'.repeat(16);
const ALICE_USER = 'e5'.repeat(16);

type Row = { leaf: number; deviceId: string; userId: string };
const BASE_ROSTER: Row[] = [
  { leaf: 0, deviceId: ME, userId: ME_USER },
  { leaf: 1, deviceId: BOB_DEV, userId: BOB },
  { leaf: 2, deviceId: CAROL_DEV, userId: CAROL },
];

function keysFor(epoch: bigint, roster: Row[] = BASE_ROSTER): CallKeys {
  return { groupId: GROUP, epoch: epoch.toString(), baseKey: new Uint8Array(16).fill(0x42).buffer, selfLeaf: 0, roster };
}
const zero = (b: Uint8Array) => b.every((x) => x === 0);
const flush = async () => { for (let i = 0; i < 5; i++) await new Promise<void>((r) => setTimeout(r, 0)); };

class Emitter {
  private readonly map = new Map<string, Set<(...a: unknown[]) => void>>();
  on(e: string, f: (...a: unknown[]) => void) { (this.map.get(e) ?? this.map.set(e, new Set()).get(e)!).add(f); return this; }
  off(e: string, f: (...a: unknown[]) => void) { this.map.get(e)?.delete(f); return this; }
  emit(e: string, ...a: unknown[]) { for (const f of [...(this.map.get(e) ?? [])]) f(...a); return true; }
  count(e: string) { return this.map.get(e)?.size ?? 0; }
}

interface FakeTrack { kind: string; muted: boolean; stopped: boolean; mute: () => void; unmute: () => void; stop: () => void;
  mediaStreamTrack: { kind: string; stop: () => void; addEventListener: () => void; removeEventListener: () => void };
  mediaStream?: unknown; setProcessor?: (p: unknown) => Promise<void> }

function fakeLocalTrack(kind: string): FakeTrack {
  const t: FakeTrack = {
    kind, muted: false, stopped: false,
    mute() { t.muted = true; }, unmute() { t.muted = false; }, stop() { t.stopped = true; },
    mediaStreamTrack: { kind, stop: () => { t.stopped = true; }, addEventListener: () => undefined, removeEventListener: () => undefined },
    setProcessor: vi.fn(async () => undefined),
  };
  return t;
}

/** A remote track as livekit hands it over: attach() makes an element (as RemoteAudioTrack’s, a fresh <audio>), detach(el)
 *  lets it go; every element ever made is kept in `made`. */
function fakeRemoteTrack(kind: 'audio' | 'video', sid: string) {
  const t = {
    kind, sid, attached: [] as HTMLMediaElement[], made: [] as HTMLMediaElement[],
    /** The MediaStreamTrack livekit puts on the element it attaches (web3.8 V1: the level meter reads it). */
    mst: { kind, id: sid } as unknown as MediaStreamTrack,
    attach: vi.fn((el?: HTMLMediaElement) => {
      const out = el ?? document.createElement(kind);
      if (kind === 'audio') out.srcObject = { getAudioTracks: () => [t.mst] } as unknown as MediaStream;
      t.attached.push(out);
      t.made.push(out);
      return out;
    }),
    detach: vi.fn((el?: HTMLMediaElement) => {
      const out = el === undefined ? t.attached.splice(0) : t.attached.filter((x) => x === el);
      t.attached = t.attached.filter((x) => !out.includes(x));
      return el === undefined ? out : el;
    }),
  };
  return t;
}
type FakeRemoteTrack = ReturnType<typeof fakeRemoteTrack>;

/** The session’s own AudioContext (PageCallDeps.audioContext): its state, statechange, resume, close and setSinkId. */
class FakeAudioContext extends EventTarget {
  state: 'running' | 'suspended' | 'closed' = 'running';
  readonly resume = vi.fn(async () => { this.to('running'); });
  readonly close = vi.fn(async () => { this.to('closed'); });
  readonly setSinkId = vi.fn(async (id: string) => { void id; });
  to(s: 'running' | 'suspended' | 'closed') { this.state = s; this.dispatchEvent(new Event('statechange')); }
}

function fakeRemote(identity: string) {
  const gains = { microphone: 1, screen_share_audio: 1 } as Record<string, number>;
  const p = {
    identity, isSpeaking: false, attributes: {},
    gains,
    get gain() { return { value: gains.microphone }; },
    setVolume: vi.fn((v: number, source: string = 'microphone') => { gains[source] = v; }),
    trackPublications: new Map<string, unknown>(),
    getTrackPublication: (source: string) => [...p.trackPublications.values()].find((x) => (x as { source: string }).source === source),
  };
  return p;
}

interface Options {
  joinEpoch?: bigint;
  joinCallError?: Error;
  iceUsername?: string;
  now?: number;
  getUserMedia?: () => Promise<MediaStream>;
  devices?: MediaDeviceInfo[];
  statsError?: Error;
}

function fakes(o: Options = {}) {
  const joinEpoch = o.joinEpoch ?? 1n;
  const order: string[] = [];
  const calls: Command[] = [];
  const listeners = new Set<(id: string, k: CallKeys) => void>();
  const pushKeys = (id: string, k: CallKeys) => { for (const l of [...listeners]) l(id, k); };

  // A manual clock: setTimer queues, advance() runs what falls due in order and lets promises settle.
  let now = o.now ?? 1_000_000;
  let nextTimer = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const advance = async (ms: number) => {
    const end = now + ms;
    for (;;) {
      const due = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (!due) break;
      timers.delete(due[0]);
      now = due[1].at;
      due[1].fn();
      for (let i = 0; i < 20; i++) await Promise.resolve();
    }
    now = end;
    await flush();
  };

  const verified = new Set<string>();
  const installs: EpochKeys[] = [];
  const manager = {
    installs,
    installEpoch: vi.fn(async (k: EpochKeys) => { installs.push(k); }),
    dispose: vi.fn(() => { order.push('manager.dispose'); }),
    clearKeys: vi.fn(() => { order.push('manager.clearKeys'); }),
    verifiedIdentities: vi.fn(async () => new Set(verified)),
    stats: vi.fn(async () => ({ encrypted: {}, dropped: {} })),
  };

  const localTracks: FakeTrack[] = [];
  const room = Object.assign(new Emitter(), {
    remoteParticipants: new Map<string, ReturnType<typeof fakeRemote>>(),
    engine: { rtcConfig: { iceServers: [] as RTCIceServer[] }, pcManager: { publisher: { getStats: async () => new Map() } } },
    localParticipant: Object.assign(new Emitter(), {
      identity: ME,
      audioLevel: 0,
      permissions: { canPublish: true, canPublishSources: [2] as number[] },
      publishTrack: vi.fn(async (track: MediaStreamTrack, opts: { source: string }) => {
        const t = fakeLocalTrack(track.kind);
        localTracks.push(t);
        return { source: opts.source, track: t, trackSid: `TR_${localTracks.length}` };
      }),
      unpublishTrack: vi.fn(async (track: unknown) => { order.push('unpublish'); void track; }),
    }),
    disconnect: vi.fn(async () => { order.push('room.disconnect'); }),
    // The browser’s autoplay rule: false while it holds call audio back; startAudio() is the one press that lifts it.
    canPlaybackAudio: true,
    startAudio: vi.fn(async () => undefined),
  });
  // The hidden container the session attaches remote audio elements into (PageCallDeps.audioHost).
  const audioHost = document.createElement('div');
  // Every AudioContext the session made, newest last; `contextState` is the state a new one starts in.
  const contexts: FakeAudioContext[] = [];
  const audio = { contextState: 'running' as 'running' | 'suspended', noSinkId: false };

  const share = (on: boolean) => {
    room.localParticipant.permissions = { canPublish: true, canPublishSources: on ? [1, 2, 3, 4] : [2] };
    room.emit('participantPermissionsChanged', undefined, room.localParticipant);
  };

  let joinOptions: JoinCallOptions | null = null;
  const joinCall = vi.fn(async (opts: JoinCallOptions) => {
    joinOptions = opts;
    if (o.joinCallError) throw o.joinCallError;
    await manager.installEpoch(opts.epoch);
    return {
      room, manager,
      release: async () => {
        manager.dispose();
        await room.disconnect();
        order.push('worker.terminate');
        order.push('lock.release');
      },
    };
  });

  const join: CallJoinResult = {
    callId, groupId: GROUP, livekitUrl: 'wss://sfu.example/rtc', token: 'tok',
    iceServers: [[['turn:sfu.example:3478'], o.iceUsername ?? '1700003600:dev:1700000000', 'cred']],
    caps: [64_000, 2_500_000, 0], epoch: joinEpoch.toString(),
  };
  let refreshAnswer = { token: 'tok2', iceServers: [[['turn:sfu.example:3478'], '1700007200:dev:1700003300', 'cred2']] };
  const bridge = {
    onCallKeys: vi.fn((l: (id: string, k: CallKeys) => void) => {
      order.push('onCallKeys');
      listeners.add(l);
      return () => { listeners.delete(l); };
    }),
    call: vi.fn(async (cmd: Command) => {
      order.push(cmd.m);
      calls.push(cmd);
      switch (cmd.m) {
        case 'callJoin':
          pushKeys(callId, keysFor(joinEpoch));
          return join;
        case 'callShare':
          if (cmd.on) share(true);
          return null;
        case 'callRefresh':
          return refreshAnswer;
        case 'callStats':
          if (o.statsError) throw o.statsError;
          return null;
        default:
          return null;
      }
    }),
  };

  const gum = vi.fn(o.getUserMedia ?? (async () => ({
    getTracks: () => [{ kind: 'audio', stop: () => undefined }],
    getAudioTracks: () => [{ kind: 'audio', stop: () => undefined }],
    getVideoTracks: () => [{ kind: 'video', stop: () => undefined }],
  }) as unknown as MediaStream));
  const media = {
    getUserMedia: gum,
    enumerateDevices: vi.fn(async () => o.devices ?? [{ kind: 'audioinput', deviceId: 'default' } as MediaDeviceInfo]),
    getDisplayMedia: vi.fn(async () => ({
      getTracks: () => [{ kind: 'video', stop: () => undefined }],
      getAudioTracks: () => [],
      getVideoTracks: () => [{ kind: 'video', stop: () => undefined, addEventListener: () => undefined, removeEventListener: () => undefined }],
    }) as unknown as MediaStream),
  };

  const deps: PageCallDeps = {
    bridge,
    joinCall: joinCall as unknown as PageCallDeps['joinCall'],
    now: () => now,
    setTimer: (fn, ms) => { const id = nextTimer++; timers.set(id, { at: now + ms, fn }); return id; },
    clearTimer: (id) => { timers.delete(id as number); },
    media,
    audioHost: () => audioHost,
    audioContext: () => {
      const ctx = new FakeAudioContext();
      ctx.state = audio.contextState;
      if (audio.noSinkId) Object.defineProperty(ctx, 'setSinkId', { value: undefined });
      contexts.push(ctx);
      return ctx as unknown as AudioContext;
    },
  };
  const addRemote = (identity: string) => {
    const p = fakeRemote(identity);
    room.remoteParticipants.set(identity, p);
    room.emit('participantConnected', p);
    return p;
  };
  type Remote = ReturnType<typeof fakeRemote>;
  type Pub = { source: string; kind: string; trackSid: string; track?: FakeRemoteTrack };
  /** `p` publishes `source`, and this device is subscribed to it: the track is on the publication, and with `emit` the
   *  room says so (trackSubscribed). Without `emit` it was subscribed before anyone listened. */
  const subscribeTrack = (p: Remote, source: string, emit = true) => {
    const kind = source === 'camera' || source === 'screen_share' ? 'video' : 'audio';
    const trackSid = `TR_${p.identity.slice(0, 4)}_${source}`;
    const pub = (p.trackPublications.get(trackSid) as Pub | undefined) ?? { source, kind, trackSid };
    pub.track ??= fakeRemoteTrack(kind, trackSid);
    p.trackPublications.set(trackSid, pub);
    if (emit) room.emit('trackSubscribed', pub.track, pub, p);
    return { track: pub.track, pub };
  };
  /** The SFU stopped sending `pub` to this device (SpeakerPolicy’s exclusion, or the publisher’s unpublish). */
  const unsubscribeTrack = (p: Remote, pub: Pub) => {
    const track = pub.track;
    delete pub.track;
    room.emit('trackUnsubscribed', track, pub, p);
  };
  return {
    deps, order, calls, pushKeys, manager, room, localTracks, advance, verified, addRemote, share, timers, gum,
    audioHost, subscribeTrack, unsubscribeTrack, contexts, audio,
    get joinOptions() { return joinOptions; },
    setRefresh: (a: typeof refreshAnswer) => { refreshAnswer = a; },
    setNow: (t: number) => { now = t; },
  };
}

const opts: PageCallOptions = { instanceId: 'inst', input: '', output: '', mode: 'vad', noise: 'off', volumes: {} };

describe('the page call session (L-WEB-50)', () => {
  const open: PageCall[] = [];
  afterEach(async () => {
    for (const c of open.splice(0)) await c.leave('user').catch(() => undefined);
  });
  const start = async (f: ReturnType<typeof fakes>, o: Partial<PageCallOptions> = {}) => {
    const call = await startPageCall(f.deps, { channelId: CH, vdec: 'vp8' }, { ...opts, ...o });
    open.push(call);
    return call;
  };

  it('subscribes before callJoin, installs the pushed join key, then every later key, and none after leave()', async () => {
    const { deps, pushKeys, manager, order } = fakes({ joinEpoch: 1n });
    const call = await startPageCall(deps, { channelId: CH, vdec: 'vp8' }, opts);
    expect(order.slice(0, 2)).toEqual(['onCallKeys', 'callJoin']);
    expect(manager.installs.map((k) => [k.epoch, k.minEpoch])).toEqual([[1n, 1n]]);
    pushKeys(callId, keysFor(2n));
    expect(manager.installs.map((k) => k.epoch)).toEqual([1n, 2n]);
    await call.leave('user');
    pushKeys(callId, keysFor(3n));
    expect(manager.installs.map((k) => k.epoch)).toEqual([1n, 2n]);
  });

  it('leave("user") posts callLeave before it disconnects the room', async () => {
    const { deps, order } = fakes({ joinEpoch: 1n });
    const call = await startPageCall(deps, { channelId: CH, vdec: 'vp8' }, opts);
    order.length = 0;
    await call.leave('user');
    expect(order).toEqual(['callLeave', 'manager.dispose', 'room.disconnect', 'worker.terminate', 'lock.release']);
  });

  it('joins with the join key, the join epoch as minEpoch, the call group lock and the dilla room options', async () => {
    const f = fakes({ joinEpoch: 4n });
    await start(f, { output: 'spk' });
    const j = f.joinOptions!;
    expect(f.calls[0]).toEqual({ m: 'callJoin', channelId: CH, vdec: 'vp8' });
    expect(j.livekitUrl).toBe('wss://sfu.example/rtc');
    expect(j.token).toBe('tok');
    expect(j.lock).toEqual({ instanceId: 'inst', callGroupId: GROUP });
    expect(j.epoch.epoch).toBe(4n);
    expect(j.epoch.minEpoch).toBe(4n);
    // Fix round 1 (I1, M2): the session’s own AudioContext is the mixer.
    expect(f.contexts).toHaveLength(1);
    expect(j.roomOptions?.webAudioMix).toEqual({ audioContext: f.contexts[0] });
    expect(j.roomOptions?.publishDefaults?.audioPreset?.maxBitrate).toBe(64_000);
    expect(j.roomOptions?.audioOutput).toEqual({ deviceId: 'spk' });
    // The join copy is zero once joinCall settled.
    expect(zero(j.epoch.baseKey)).toBe(true);
  });

  it('the key copy is zero-filled once installEpoch settles, and a key for another call is zero-filled and never installed', async () => {
    const f = fakes();
    await start(f);
    f.pushKeys(callId, keysFor(2n));
    const copy = f.manager.installs[1].baseKey;
    expect(zero(copy)).toBe(false);
    await flush();
    expect(zero(copy)).toBe(true);
    const foreign = keysFor(9n);
    f.pushKeys('ff'.repeat(16), foreign);
    expect(f.manager.installs.map((k) => k.epoch)).toEqual([1n, 2n]);
    expect(zero(new Uint8Array(foreign.baseKey))).toBe(true);
  });

  it('leave("blocked") disconnects first and then posts callLeave', async () => {
    const f = fakes();
    const call = await start(f);
    f.order.length = 0;
    await call.leave('blocked');
    expect(f.order).toEqual(['manager.dispose', 'room.disconnect', 'worker.terminate', 'lock.release', 'callLeave']);
    expect(f.calls.at(-1)).toEqual({ m: 'callLeave', reason: 'user' });
    expect(call.state.phase).toBe('ended');
  });

  it('a denied microphone joins listen-only with mic "denied" and no publish', async () => {
    const f = fakes({ getUserMedia: async () => { throw Object.assign(new Error('no'), { name: 'NotAllowedError' }); } });
    const call = await start(f);
    expect(call.state.mic).toBe('denied');
    expect(call.state.phase).toBe('connected');
    expect(f.room.localParticipant.publishTrack).not.toHaveBeenCalled();
  });

  it('no microphone joins listen-only with mic "missing"', async () => {
    const f = fakes({ getUserMedia: async () => { throw Object.assign(new Error('no'), { name: 'NotFoundError' }); } });
    const call = await start(f);
    expect(call.state.mic).toBe('missing');
    expect(call.state.phase).toBe('connected');
    expect(f.room.localParticipant.publishTrack).not.toHaveBeenCalled();
    const g = fakes({ devices: [] });
    const call2 = await start(g);
    expect(call2.state.mic).toBe('missing');
    expect(g.room.localParticipant.publishTrack).not.toHaveBeenCalled();
    expect(g.gum).not.toHaveBeenCalled();
  });

  it('publishes the microphone with the instance caps', async () => {
    const f = fakes();
    const call = await start(f);
    expect(call.state.mic).toBe('ok');
    expect(f.room.localParticipant.publishTrack).toHaveBeenCalledTimes(1);
    const [, o] = f.room.localParticipant.publishTrack.mock.calls[0];
    expect(o).toMatchObject({ source: 'microphone', dtx: true, red: false, audioPreset: { maxBitrate: 64_000 } });
  });

  it('noise "on" attaches the RNNoise processor in the chosen mode', async () => {
    const f = fakes();
    const made: string[] = [];
    f.deps.createNoiseProcessor = (mode) => { made.push(mode); return { name: 'fake', setPttActive: vi.fn() } as never; };
    await start(f, { noise: 'on', mode: 'ptt' });
    expect(made).toEqual(['ptt']);
    expect(f.localTracks[0].setProcessor).toHaveBeenCalledTimes(1);
  });

  it('a tile is "unverified" for a room participant in no roster and "ok" once verifiedIdentities has it', async () => {
    const f = fakes();
    const call = await start(f);
    f.addRemote(BOB_DEV);
    f.addRemote(DEV_D);
    await f.advance(1_000);
    const tile = (d: string) => call.state.tiles.find((t) => t.deviceId === d)!;
    expect(tile(DEV_D).state).toBe('unverified');
    expect(tile(DEV_D).video).toBeNull();
    expect(tile(BOB_DEV).state).toBe('not-heard');
    expect(tile(BOB_DEV).userId).toBe(BOB);
    f.pushKeys(callId, keysFor(2n, [...BASE_ROSTER, { leaf: 3, deviceId: DEV_D, userId: ALICE_USER }]));
    f.verified.add(DEV_D);
    await f.advance(1_000);
    expect(tile(DEV_D).state).toBe('ok');
    expect(tile(DEV_D).userId).toBe(ALICE_USER);
    expect(tile(BOB_DEV).state).toBe('not-heard');
    // A roster member LiveKit has not shown yet is 'connecting'; one's own device is never a tile.
    expect(tile(CAROL_DEV).state).toBe('connecting');
    expect(call.state.tiles.some((t) => t.deviceId === ME)).toBe(false);
    void ALICE;
  });

  it('an ok tile carries its camera stream; an unverified one never does', async () => {
    const f = fakes();
    const call = await start(f);
    const bob = f.addRemote(BOB_DEV);
    const d = f.addRemote(DEV_D);
    const cam = { id: 'cam' };
    bob.trackPublications.set('v', { source: 'camera', track: { mediaStream: cam } });
    d.trackPublications.set('v', { source: 'camera', track: { mediaStream: { id: 'dcam' } } });
    f.verified.add(BOB_DEV);
    f.verified.add(DEV_D);
    await f.advance(1_000);
    expect(call.state.tiles.find((t) => t.deviceId === BOB_DEV)!.video).toBe(cam);
    expect(call.state.tiles.find((t) => t.deviceId === DEV_D)!.video).toBeNull();
  });

  it('setPaused (RV-3) stops sending and playing, installs no key, and restores on resume', async () => {
    const f = fakes();
    const call = await start(f, { volumes: { [BOB]: 150 } });
    const bob = f.addRemote(BOB_DEV);
    const carol = f.addRemote(CAROL_DEV);
    bob.trackPublications.set('v', { source: 'camera', track: { mediaStream: { id: 'cam' } } });
    f.verified.add(BOB_DEV);
    await call.setCamera(true);
    expect(call.state.camera).toBe(true);
    await f.advance(1_000);
    expect(call.state.tiles.find((t) => t.deviceId === BOB_DEV)!.video).not.toBeNull();
    const mic = f.localTracks[0];
    f.calls.length = 0;
    await call.setPaused(true);
    expect(mic.muted).toBe(true);
    expect(f.room.localParticipant.unpublishTrack).toHaveBeenCalledTimes(1);
    expect(f.calls).toContainEqual({ m: 'callShare', on: false });
    expect(call.state.camera).toBe(false);
    expect(bob.gains.microphone).toBe(0);
    expect(carol.gains.microphone).toBe(0);
    expect(call.state.tiles.every((t) => t.video === null && t.screen === null)).toBe(true);
    await f.advance(1_000);
    expect(call.state.tiles.every((t) => t.video === null)).toBe(true);
    const k2 = keysFor(2n);
    f.pushKeys(callId, k2);
    expect(f.manager.installs.map((k) => k.epoch)).toEqual([1n]);
    expect(zero(new Uint8Array(k2.baseKey))).toBe(true);
    f.pushKeys(callId, keysFor(3n));
    expect(f.manager.installs.map((k) => k.epoch)).toEqual([1n]);
    await call.setPaused(false);
    expect(f.manager.installs.map((k) => k.epoch)).toEqual([1n, 3n]);
    expect(bob.gains.microphone).toBe(1.5);
    expect(carol.gains.microphone).toBe(1);
    expect(mic.muted).toBe(false);
    expect(call.state.camera).toBe(false);
    expect(call.state.paused).toBe(false);
  });

  // WB security I1: the hold after a refused rekey drops the media keys, so nothing more is sent under the old
  // epoch; a key held from before the drop is wiped, and the next epoch's key installs when the hold ends.
  it('dropKeys clears every media key at once and wipes a held key; the next epoch installs on resume', async () => {
    const f = fakes();
    const call = await start(f);
    await call.setPaused(true);
    const held = keysFor(2n);
    f.pushKeys(callId, held);
    call.dropKeys();
    expect(f.manager.clearKeys).toHaveBeenCalledTimes(1);
    f.pushKeys(callId, keysFor(3n));
    expect(f.manager.installs.map((k) => k.epoch)).toEqual([1n]);
    await call.setPaused(false);
    expect(f.manager.installs.map((k) => k.epoch)).toEqual([1n, 3n]);
    await call.leave('user');
    call.dropKeys();
    expect(f.manager.clearKeys).toHaveBeenCalledTimes(1);
  });

  it('a muted person stays muted after resume, and camera or screen cannot start while paused', async () => {
    const f = fakes();
    const call = await start(f);
    call.setMuted(true);
    await call.setPaused(true);
    await expect(call.setCamera(true)).rejects.toMatchObject({ code: 'E_UNAVAILABLE' });
    await expect(call.setSharing(true)).rejects.toMatchObject({ code: 'E_UNAVAILABLE' });
    expect(f.calls.some((c) => c.m === 'callShare' && c.on)).toBe(false);
    await call.setPaused(false);
    expect(f.localTracks[0].muted).toBe(true);
    expect(call.state.muted).toBe(true);
  });

  it('deafen mutes every remote GainNode and sends voiceSelf flags 3; undeafen restores stored volumes', async () => {
    const f = fakes();
    const call = await start(f, { volumes: { [BOB]: 150 } });
    const bob = f.addRemote(BOB_DEV);
    const carol = f.addRemote(CAROL_DEV);
    await f.advance(1_000);
    expect(bob.gains.microphone).toBe(1.5);
    call.setDeafened(true);
    expect(bob.gains.microphone).toBe(0);
    expect(carol.gains.microphone).toBe(0);
    expect(f.calls.at(-1)).toEqual({ m: 'voiceSelf', callId, flags: 3 });
    expect(call.state.muted).toBe(true);
    expect(call.state.deafened).toBe(true);
    call.setDeafened(false);
    expect(bob.gains.microphone).toBe(1.5);
    expect(carol.gains.microphone).toBe(1);
    expect(call.state.muted).toBe(false);
    expect(f.calls.at(-1)).toEqual({ m: 'voiceSelf', callId, flags: 0 });
  });

  it('mute sends voiceSelf flags 1 after callJoin, never before, and mutes the mic track', async () => {
    const f = fakes();
    const call = await start(f);
    expect(f.calls.some((c) => c.m === 'voiceSelf')).toBe(false);
    call.setMuted(true);
    expect(f.calls.at(-1)).toEqual({ m: 'voiceSelf', callId, flags: 1 });
    expect(f.localTracks[0].muted).toBe(true);
    expect(f.calls.findIndex((c) => c.m === 'callJoin')).toBeLessThan(f.calls.findIndex((c) => c.m === 'voiceSelf'));
  });

  it('setVolume stores 0..200 and drives that person’s gain', async () => {
    const f = fakes();
    const call = await start(f);
    const bob = f.addRemote(BOB_DEV);
    await f.advance(1_000);
    call.setVolume(BOB, 50);
    expect(bob.gains.microphone).toBe(0.5);
    expect(bob.gains.screen_share_audio).toBe(0.5);
    expect(() => call.setVolume(BOB, 55)).toThrow(/E_INVALID/);
  });

  it('push to talk mutes the microphone unless the key is held', async () => {
    const f = fakes();
    const call = await start(f, { mode: 'ptt' });
    const mic = f.localTracks[0];
    expect(mic.muted).toBe(true);
    call.pushToTalk(true);
    expect(mic.muted).toBe(false);
    call.pushToTalk(false);
    expect(mic.muted).toBe(true);
    const g = fakes();
    const vad = await start(g);
    vad.pushToTalk(false);
    expect(g.localTracks[0].muted).toBe(false);
  });

  // Task-9 review I2: the input mode follows Settings → Voice during a call; push to talk closes the microphone at once.
  it('setMode("ptt") closes the microphone at once; the key then opens it; setMode("vad") reopens it', async () => {
    const f = fakes();
    const call = await start(f);
    const mic = f.localTracks[0];
    expect(mic.muted).toBe(false);
    call.setMode('ptt');
    expect(mic.muted).toBe(true);
    expect(call.state.mode).toBe('ptt');
    call.pushToTalk(true);
    expect(mic.muted).toBe(false);
    call.pushToTalk(false);
    call.setMode('vad');
    expect(mic.muted).toBe(false);
    expect(call.state.mode).toBe('vad');
    // A muted person stays muted across a mode change.
    call.setMuted(true);
    call.setMode('ptt');
    call.setMode('vad');
    expect(mic.muted).toBe(true);
  });

  it('with RNNoise built for voice activity, push to talk gates the track; built for push to talk, voice activity holds it open', async () => {
    const f = fakes();
    const made: { mode: string; ptt: boolean[] }[] = [];
    f.deps.createNoiseProcessor = (mode) => { const p = { mode, ptt: [] as boolean[] }; made.push(p); return { setPttActive: (a: boolean) => { p.ptt.push(a); } }; };
    const call = await start(f, { noise: 'on' });
    const mic = f.localTracks[0];
    call.setMode('ptt');
    expect(mic.muted).toBe(true);
    call.pushToTalk(true);
    expect(mic.muted).toBe(false);
    const g = fakes();
    const made2: boolean[] = [];
    g.deps.createNoiseProcessor = () => ({ setPttActive: (a: boolean) => { made2.push(a); } });
    const ptt = await start(g, { noise: 'on', mode: 'ptt' });
    ptt.setMode('vad');
    expect(made2.at(-1)).toBe(true);
    expect(g.localTracks[0].muted).toBe(false);
  });

  // Queued from the task-8b review (N2, N6): a pagehide while joinCall is still running.
  it('a pagehide while joinCall is pending zero-fills every key copy, installs nothing, releases the session and ends E_ABORTED', async () => {
    const f = fakes();
    const copies: Uint8Array[] = [];
    f.deps.copyKey = (buffer) => { const c = new Uint8Array(buffer.slice(0)); copies.push(c); return c; };
    let resolveJoin: () => void = () => undefined;
    const released = vi.fn(async () => undefined);
    f.deps.joinCall = vi.fn(() => new Promise((resolve) => {
      resolveJoin = () => resolve({ room: f.room, manager: f.manager, release: released });
    })) as unknown as PageCallDeps['joinCall'];
    const outcome = startPageCall(f.deps, { channelId: CH, vdec: 'vp8' }, opts).catch((e: unknown) => e);
    await flush();
    expect(f.deps.joinCall).toHaveBeenCalledTimes(1);
    // A newer key arrives while joinCall runs, and is held for after the join.
    const newer = keysFor(2n);
    const pushed = new Uint8Array(newer.baseKey);
    f.pushKeys(callId, newer);
    window.dispatchEvent(new Event('pagehide'));
    resolveJoin();
    expect(await outcome).toMatchObject({ code: 'E_ABORTED' });
    expect(copies.length).toBeGreaterThanOrEqual(2);
    expect(copies.every(zero)).toBe(true);
    expect(zero(pushed)).toBe(true);
    expect(f.manager.installEpoch).not.toHaveBeenCalled();
    expect(released).toHaveBeenCalled();
    expect(f.calls.filter((c) => c.m === 'callLeave')).toEqual([{ m: 'callLeave', reason: 'pagehide' }]);
  });

  it('refreshes ICE 300 s before the credential expiry the username carries', async () => {
    const f = fakes({ iceUsername: '1700003600:dev:1700000000', now: 1_700_000_000_000 });
    await start(f);
    await f.advance(3_300_000 - 1);
    expect(f.calls.some((c) => c.m === 'callRefresh')).toBe(false);
    await f.advance(1);
    expect(f.calls.filter((c) => c.m === 'callRefresh')).toHaveLength(1);
    expect(f.room.engine.rtcConfig.iceServers).toEqual([{ urls: ['turn:sfu.example:3478'], username: '1700007200:dev:1700003300', credential: 'cred2' }]);
    // The next refresh follows the new expiry: 1700007200 − 300 s.
    await f.advance(3_600_000 - 1);
    expect(f.calls.filter((c) => c.m === 'callRefresh')).toHaveLength(1);
    await f.advance(1);
    expect(f.calls.filter((c) => c.m === 'callRefresh')).toHaveLength(2);
  });

  it('sends one callStats report per 10 s while connected', async () => {
    const f = fakes({ statsError: Object.assign(new Error('E_RATE_LIMITED'), { code: 'E_RATE_LIMITED', status: 429 }) });
    const call = await start(f);
    await f.advance(30_000);
    expect(f.calls.filter((c) => c.m === 'callStats')).toHaveLength(3);
    expect(call.state.error).toBeNull();
    f.room.emit('reconnecting');
    expect(call.state.phase).toBe('reconnecting');
    await f.advance(10_000);
    expect(f.calls.filter((c) => c.m === 'callStats')).toHaveLength(3);
    f.room.emit('reconnected');
    expect(call.state.phase).toBe('connected');
    await f.advance(10_000);
    expect(f.calls.filter((c) => c.m === 'callStats')).toHaveLength(4);
    const report = f.calls.find((c) => c.m === 'callStats') as Extract<Command, { m: 'callStats' }>;
    expect(report.report).toHaveLength(6);
    expect(call.state.error).toBeNull();
  });

  it('E_CALL_IN_OTHER_TAB ends the attempt with that code and calls callLeave', async () => {
    const f = fakes({ joinCallError: new Error('E_CALL_IN_OTHER_TAB') });
    await expect(startPageCall(f.deps, { channelId: CH, vdec: 'vp8' }, opts)).rejects.toMatchObject({ code: 'E_CALL_IN_OTHER_TAB' });
    expect(f.calls).toContainEqual({ m: 'callLeave', reason: 'user' });
    expect(zero(f.joinOptions!.epoch.baseKey)).toBe(true);
    // No listener is left behind: a later key is never installed.
    f.pushKeys(callId, keysFor(2n));
    expect(f.manager.installs).toEqual([]);
  });

  it('asks for the microphone before callJoin and stops it when the join fails', async () => {
    const stop = vi.fn();
    const f = fakes({ joinCallError: new Error('E_CALL_IN_OTHER_TAB'),
      getUserMedia: async () => ({ getTracks: () => [], getAudioTracks: () => [{ kind: 'audio', stop }], getVideoTracks: () => [] }) as unknown as MediaStream });
    const asked: string[] = [];
    f.gum.mockImplementationOnce(async () => {
      asked.push(`gum after ${f.order.length} bridge steps`);
      return { getTracks: () => [], getAudioTracks: () => [{ kind: 'audio', stop }], getVideoTracks: () => [] } as unknown as MediaStream;
    });
    await expect(startPageCall(f.deps, { channelId: CH, vdec: 'vp8' }, opts)).rejects.toMatchObject({ code: 'E_CALL_IN_OTHER_TAB' });
    expect(asked).toEqual(['gum after 0 bridge steps']);
    expect(stop).toHaveBeenCalled();
  });

  it('pagehide during startup posts callLeave("pagehide"), releases the room and ends the attempt (review m1)', async () => {
    const f = fakes();
    let unblock: () => void = () => undefined;
    f.room.localParticipant.publishTrack.mockImplementationOnce(() => new Promise((resolve) => {
      unblock = () => resolve({ source: 'microphone', track: fakeLocalTrack('audio'), trackSid: 'TR_X' });
    }));
    const started = startPageCall(f.deps, { channelId: CH, vdec: 'vp8' }, opts);
    const outcome = started.catch((e: unknown) => e);
    await flush();
    expect(f.room.localParticipant.publishTrack).toHaveBeenCalledTimes(1);
    window.dispatchEvent(new Event('pagehide'));
    expect(f.calls).toContainEqual({ m: 'callLeave', reason: 'pagehide' });
    expect(f.room.disconnect).toHaveBeenCalled();
    expect(f.manager.dispose).toHaveBeenCalled();
    f.pushKeys(callId, keysFor(2n));
    expect(f.manager.installs.map((k) => k.epoch)).toEqual([1n]);
    unblock();
    expect(await outcome).toMatchObject({ code: 'E_ABORTED' });
    expect(f.order).toContain('lock.release');
    expect(f.calls.filter((c) => c.m === 'callLeave')).toHaveLength(1);
    expect(f.timers.size).toBe(0);
    // The listener is gone with the attempt.
    window.dispatchEvent(new Event('pagehide'));
    expect(f.calls.filter((c) => c.m === 'callLeave')).toHaveLength(1);
  });

  it('a failure after joinCall resolved tears the call down and posts callLeave (review m1)', async () => {
    const f = fakes();
    f.deps.createNoiseProcessor = () => { throw new Error('E_WASM: no worklet'); };
    await expect(startPageCall(f.deps, { channelId: CH, vdec: 'vp8' }, { ...opts, noise: 'on' })).rejects.toMatchObject({ code: 'E_WASM' });
    expect(f.order).toEqual(expect.arrayContaining(['manager.dispose', 'room.disconnect', 'worker.terminate', 'lock.release']));
    expect(f.order.indexOf('lock.release')).toBeLessThan(f.order.lastIndexOf('callLeave'));
    expect(f.calls.at(-1)).toEqual({ m: 'callLeave', reason: 'user' });
    f.pushKeys(callId, keysFor(2n));
    expect(f.manager.installs.map((k) => k.epoch)).toEqual([1n]);
    window.dispatchEvent(new Event('pagehide'));
    expect(f.calls.filter((c) => c.m === 'callLeave')).toHaveLength(1);
  });

  it('a microphone that cannot be published joins listen-only with mic "failed" and E_MIC_PUBLISH (review m4)', async () => {
    const f = fakes();
    f.room.localParticipant.publishTrack.mockImplementationOnce(async () => { throw new Error('publish timed out'); });
    const call = await start(f);
    expect(call.state.mic).toBe('failed');
    expect(call.state.error).toBe('E_MIC_PUBLISH');
    expect(call.state.phase).toBe('connected');
  });

  it('a refused callJoin rejects with its code, posts no callLeave, and leaves no key listener', async () => {
    const f = fakes();
    f.deps.bridge.call = vi.fn(async (cmd: Command) => {
      f.calls.push(cmd);
      if (cmd.m === 'callJoin') throw Object.assign(new Error('E_CALL_FULL'), { code: 'E_CALL_FULL' });
      return null;
    });
    await expect(startPageCall(f.deps, { channelId: CH, vdec: 'vp8' }, opts)).rejects.toMatchObject({ code: 'E_CALL_FULL' });
    expect(f.calls.map((c) => c.m)).toEqual(['callJoin']);
    expect(f.deps.joinCall).not.toHaveBeenCalled();
  });

  it('a join answer without its key fails closed with E_NO_EPOCH and leaves', async () => {
    const f = fakes({ joinEpoch: 2n });
    const original = f.deps.bridge.call;
    f.deps.bridge.call = vi.fn(async (cmd: Command) => {
      if (cmd.m === 'callJoin') {
        const r = (await original(cmd)) as CallJoinResult;
        return { ...r, epoch: '3' };
      }
      return original(cmd);
    });
    await expect(startPageCall(f.deps, { channelId: CH, vdec: 'vp8' }, opts)).rejects.toMatchObject({ code: 'E_NO_EPOCH' });
    expect(f.deps.joinCall).not.toHaveBeenCalled();
    expect(f.calls).toContainEqual({ m: 'callLeave', reason: 'user' });
  });

  it('pagehide posts callLeave("pagehide") and disconnects without awaiting the answer', async () => {
    const f = fakes();
    const call = await start(f);
    let settled = false;
    f.deps.bridge.call = vi.fn((cmd: Command) => {
      f.calls.push(cmd);
      return new Promise(() => undefined).finally(() => { settled = true; });
    });
    window.dispatchEvent(new Event('pagehide'));
    expect(f.calls).toContainEqual({ m: 'callLeave', reason: 'pagehide' });
    expect(f.room.disconnect).toHaveBeenCalled();
    expect(f.manager.dispose).toHaveBeenCalled();
    expect(settled).toBe(false);
    f.pushKeys(callId, keysFor(2n));
    expect(f.manager.installs.map((k) => k.epoch)).toEqual([1n]);
    expect(call.state.phase).toBe('ended');
  });

  it('camera: callShare on, then the permission, then the publish; off sends callShare off', async () => {
    const f = fakes();
    const call = await start(f);
    f.order.length = 0;
    f.room.localParticipant.publishTrack.mockClear();
    const permissionSeen: number[] = [];
    f.room.on('participantPermissionsChanged', () => permissionSeen.push(f.room.localParticipant.publishTrack.mock.calls.length));
    await call.setCamera(true);
    expect(f.order.indexOf('callShare')).toBe(0);
    expect(permissionSeen).toEqual([0]);
    expect(f.room.localParticipant.publishTrack).toHaveBeenCalledTimes(1);
    expect(f.room.localParticipant.publishTrack.mock.calls[0][1]).toMatchObject({ source: 'camera', videoCodec: 'vp8' });
    await call.setSharing(true);
    expect(f.calls.filter((c) => c.m === 'callShare')).toHaveLength(1);
    await call.setCamera(false);
    expect(f.calls.filter((c) => c.m === 'callShare')).toHaveLength(1);
    await call.setSharing(false);
    expect(f.calls.filter((c) => c.m === 'callShare').at(-1)).toEqual({ m: 'callShare', on: false });
    expect(call.state.camera).toBe(false);
    expect(call.state.sharing).toBe(false);
  });

  it('a share permission that never comes fails E_UNAVAILABLE after 10 s and sends callShare off', async () => {
    const f = fakes();
    const call = await start(f);
    f.deps.bridge.call = vi.fn(async (cmd: Command) => { f.calls.push(cmd); return null; });
    const p = call.setCamera(true);
    const caught = p.catch((e: unknown) => e);
    await flush();
    await f.advance(10_000);
    expect(await caught).toMatchObject({ code: 'E_UNAVAILABLE' });
    expect(f.calls.at(-1)).toEqual({ m: 'callShare', on: false });
    expect(call.state.camera).toBe(false);
  });

  it('an unexpected room disconnect ends the call and posts callLeave("lost") (WB client I3)', async () => {
    const f = fakes();
    const call = await start(f);
    f.room.emit('disconnected');
    await flush();
    expect(call.state.phase).toBe('ended');
    expect(call.state.error).toBe('E_DISCONNECTED');
    expect(f.calls).toContainEqual({ m: 'callLeave', reason: 'lost' });
    f.pushKeys(callId, keysFor(2n));
    expect(f.manager.installs.map((k) => k.epoch)).toEqual([1n]);
  });

  it('subscribe() reports state changes and leave() stops every timer and listener', async () => {
    const f = fakes();
    const call = await start(f);
    const seen: boolean[] = [];
    const off = call.subscribe(() => seen.push(call.state.muted));
    call.setMuted(true);
    off();
    call.setMuted(false);
    expect(seen).toEqual([true]);
    await call.leave('user');
    expect(f.timers.size).toBe(0);
    expect(f.room.count('participantPermissionsChanged')).toBe(0);
    await call.leave('user');
    expect(f.calls.filter((c) => c.m === 'callLeave')).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------------------------
// Whole-branch fix wave (wb-client.md I1, I2, I3, m2, m3).
// ---------------------------------------------------------------------------------------------

function videoTrack(): MediaStreamTrack & { enabled: boolean; stopped: boolean } {
  const t = { kind: 'video', enabled: true, stopped: false, stop() { t.stopped = true; }, addEventListener: () => undefined, removeEventListener: () => undefined };
  return t as unknown as MediaStreamTrack & { enabled: boolean; stopped: boolean };
}
const streamOf = (video: MediaStreamTrack) => ({ getTracks: () => [video], getAudioTracks: () => [], getVideoTracks: () => [video] }) as unknown as MediaStream;
const later = <T,>() => {
  let resolve: (v: T) => void = () => undefined;
  let reject: (e: unknown) => void = () => undefined;
  const promise = new Promise<T>((ok, no) => { resolve = ok; reject = no; });
  return { promise, resolve, reject };
};

describe('the whole-branch fix wave', () => {
  const open: PageCall[] = [];
  afterEach(async () => { for (const c of open.splice(0)) await c.leave('user').catch(() => undefined); });
  const start = async (f: ReturnType<typeof fakes>, o: Partial<PageCallOptions> = {}) => {
    const call = await startPageCall(f.deps, { channelId: CH, vdec: 'vp8' }, { ...opts, ...o });
    open.push(call);
    return call;
  };

  // I1: a join is cancellable from the page, the microphone prompt included.
  it('an abort while the microphone prompt is open ends the start at once; the late track is stopped; nothing is joined', async () => {
    const f = fakes();
    const mic = later<MediaStream>();
    const track = { kind: 'audio', stop: vi.fn() };
    f.gum.mockImplementationOnce(() => mic.promise);
    const abort = new AbortController();
    const outcome = startPageCall(f.deps, { channelId: CH, vdec: 'vp8' }, { ...opts, signal: abort.signal }).catch((e: unknown) => e);
    await flush();
    abort.abort();
    expect(await outcome).toMatchObject({ code: 'E_ABORTED' });
    expect(f.calls.some((c) => c.m === 'callJoin')).toBe(false);
    mic.resolve({ getTracks: () => [track], getAudioTracks: () => [track], getVideoTracks: () => [] } as unknown as MediaStream);
    await flush();
    expect(track.stop).toHaveBeenCalled();
  });

  it('an abort while callJoin is pending posts callLeave("user") at once, stops the microphone and ends E_ABORTED', async () => {
    const f = fakes();
    const stop = vi.fn();
    f.gum.mockImplementationOnce(async () => ({ getTracks: () => [], getAudioTracks: () => [{ kind: 'audio', stop }], getVideoTracks: () => [] }) as unknown as MediaStream);
    const answer = later<unknown>();
    const original = f.deps.bridge.call;
    f.deps.bridge.call = vi.fn((cmd: Command) => (cmd.m === 'callJoin' ? (f.calls.push(cmd), answer.promise) : original(cmd)));
    const abort = new AbortController();
    const outcome = startPageCall(f.deps, { channelId: CH, vdec: 'vp8' }, { ...opts, signal: abort.signal }).catch((e: unknown) => e);
    await flush();
    expect(f.calls.map((c) => c.m)).toEqual(['callJoin']);
    abort.abort();
    expect(f.calls).toContainEqual({ m: 'callLeave', reason: 'user' });
    expect(stop).toHaveBeenCalled();
    answer.reject(Object.assign(new Error('E_NO_CALL'), { code: 'E_NO_CALL' }));
    expect(await outcome).toMatchObject({ code: 'E_ABORTED' });
    expect(f.deps.joinCall).not.toHaveBeenCalled();
  });

  // I2: RV-3 says nothing is sent while paused. The camera and screen stop sending at once, even while a camera or
  // share operation holds the lane (the screen picker left open), and an operation that finishes during the pause
  // publishes nothing.
  it('a pause disables a published camera at once while the screen picker is open, and the share then publishes nothing', async () => {
    const f = fakes();
    const call = await start(f);
    const cam = videoTrack();
    f.gum.mockImplementationOnce(async () => streamOf(cam));
    await call.setCamera(true);
    expect(call.state.camera).toBe(true);
    const picker = later<MediaStream>();
    f.deps.media.getDisplayMedia = vi.fn(() => picker.promise);
    const sharing = call.setSharing(true).catch((e: unknown) => e);
    await flush();
    expect(f.deps.media.getDisplayMedia).toHaveBeenCalled();
    const paused = call.setPaused(true);
    expect(cam.enabled).toBe(false);
    const screen = videoTrack();
    picker.resolve(streamOf(screen));
    await paused;
    expect(await sharing).toMatchObject({ code: 'E_UNAVAILABLE' });
    expect(f.room.localParticipant.publishTrack.mock.calls.filter(([, o]) => o.source === 'screen_share')).toHaveLength(0);
    expect(screen.stopped).toBe(true);
    expect(cam.stopped).toBe(true);
    expect(call.state.camera).toBe(false);
    expect(call.state.sharing).toBe(false);
  });

  it('a camera whose publish was in flight when the pause came is unpublished and stopped', async () => {
    const f = fakes();
    const call = await start(f);
    f.share(true);
    const cam = videoTrack();
    f.gum.mockImplementationOnce(async () => streamOf(cam));
    const publish = later<unknown>();
    f.room.localParticipant.publishTrack.mockImplementationOnce(() => publish.promise as never);
    const camera = call.setCamera(true).catch((e: unknown) => e);
    await flush();
    void call.setPaused(true);
    publish.resolve({ source: 'camera', track: fakeLocalTrack('video'), trackSid: 'TR_C' });
    expect(await camera).toMatchObject({ code: 'E_UNAVAILABLE' });
    expect(f.room.localParticipant.unpublishTrack).toHaveBeenCalledWith(cam);
    expect(cam.stopped).toBe(true);
    expect(call.state.camera).toBe(false);
  });

  // I3: the session says why it ended on its own, and tells the worker it was lost.
  it.each([[5, 'E_CALL_ENDED'], [4, 'E_REMOVED'], [1, 'E_DISCONNECTED'], [undefined, 'E_DISCONNECTED']] as const)(
    'a disconnect with LiveKit reason %s ends the call with %s', async (reason, code) => {
      const f = fakes();
      const call = await start(f);
      f.room.emit('disconnected', reason);
      await flush();
      expect(call.state).toMatchObject({ phase: 'ended', error: code });
      expect(f.calls.filter((c) => c.m === 'callLeave')).toEqual([{ m: 'callLeave', reason: 'lost' }]);
    });

  // m2: the room's own end is heard from the moment joinCall resolves, not only after the microphone is published.
  it('a disconnect while the microphone is being published ends the start; it never reports connected', async () => {
    const f = fakes();
    const publish = later<unknown>();
    f.room.localParticipant.publishTrack.mockImplementationOnce(() => publish.promise as never);
    const outcome = startPageCall(f.deps, { channelId: CH, vdec: 'vp8' }, opts).catch((e: unknown) => e);
    await flush();
    f.room.emit('disconnected', 1);
    publish.resolve({ source: 'microphone', track: fakeLocalTrack('audio'), trackSid: 'TR_M' });
    const r = await outcome;
    expect(r).toMatchObject({ code: 'E_DISCONNECTED' });
    expect(f.calls).toContainEqual({ m: 'callLeave', reason: 'user' });
    expect(f.order).toContain('lock.release');
  });

  // m3: a leave while a share waits for the SFU's permission settles the waiting camera (no promise kept forever).
  it('a leave while a share waits for its permission settles setCamera', async () => {
    const f = fakes();
    const call = await start(f);
    f.deps.bridge.call = vi.fn(async (cmd: Command) => { f.calls.push(cmd); return null; });
    const camera = call.setCamera(true).then(() => 'resolved', (e: unknown) => e);
    await flush();
    await call.leave('user');
    await flush();
    expect(await Promise.race([camera, new Promise((r) => setTimeout(() => r('pending'), 50))])).toMatchObject({ code: 'E_UNAVAILABLE' });
    expect(f.room.count('participantPermissionsChanged')).toBe(0);
  });
});

// ---------------------------------------------------------------------------------------------
// Whole-branch fix wave 2 (review/wb-product-walk.md I3, M1, M4).
// ---------------------------------------------------------------------------------------------

describe('the product walk fixes', () => {
  const open: PageCall[] = [];
  afterEach(async () => { for (const c of open.splice(0)) await c.leave('user').catch(() => undefined); });
  const start = async (f: ReturnType<typeof fakes>, o: Partial<PageCallOptions> = {}) => {
    const call = await startPageCall(f.deps, { channelId: CH, vdec: 'vp8' }, { ...opts, ...o });
    open.push(call);
    return call;
  };
  const withViews = (f: ReturnType<typeof fakes>) => {
    f.deps.viewOf = (track) => ({ id: 'view', track }) as unknown as MediaStream;
    return f;
  };

  it('I3: the own camera and screen are in the state as local views, gone when they stop and at the leave', async () => {
    const f = withViews(fakes());
    const cam = videoTrack();
    const screenTrack = videoTrack();
    f.deps.media.getUserMedia = vi.fn(async (c: MediaStreamConstraints) => (c.video !== undefined && c.video !== false ? streamOf(cam) : {
      getTracks: () => [], getAudioTracks: () => [{ kind: 'audio', stop: () => undefined }], getVideoTracks: () => [] }) as unknown as MediaStream);
    f.deps.media.getDisplayMedia = vi.fn(async () => streamOf(screenTrack));
    const call = await start(f);
    expect(call.state.localCamera).toBeNull();
    await call.setCamera(true);
    expect((call.state.localCamera as unknown as { track: unknown }).track).toBe(cam);
    await call.setSharing(true);
    expect((call.state.localScreen as unknown as { track: unknown }).track).toBe(screenTrack);
    await call.setCamera(false);
    expect(call.state.localCamera).toBeNull();
    expect(call.state.localScreen).not.toBeNull();
    await call.leave('user');
    expect(call.state.localScreen).toBeNull();
  });

  describe('web3.8 V1: speaking follows the audio itself', () => {
    /** Fake levels: a meter per track, its RMS set by the test; every meter's close() is counted. */
    const meters = () => {
      const levels = new Map<unknown, number>();
      const made: Array<{ track: unknown; close: ReturnType<typeof vi.fn> }> = [];
      const create = vi.fn((_ctx: AudioContext, track: MediaStreamTrack) => {
        const close = vi.fn();
        made.push({ track, close });
        return { read: () => levels.get(track) ?? 0, close };
      });
      return { levels, made, create };
    };
    const withMeters = (f: ReturnType<typeof fakes>) => {
      const m = meters();
      f.deps.createLevelMeter = m.create;
      return m;
    };
    const ownTrack = (f: ReturnType<typeof fakes>) => f.localTracks[0].mediaStreamTrack;
    const tileOf = (call: PageCall, id: string) => call.state.tiles.find((t) => t.deviceId === id)!;
    const heard = (f: ReturnType<typeof fakes>, id = BOB_DEV) => {
      const p = f.addRemote(id);
      f.verified.add(id);
      const { track, pub } = f.subscribeTrack(p, 'microphone');
      return { p, track, pub };
    };

    it('M4: the own speaking comes on after 50 ms of level and goes off 300 ms after it ends', async () => {
      const f = fakes();
      const m = withMeters(f);
      const call = await start(f);
      expect(call.state.speaking).toBe(false);
      m.levels.set(ownTrack(f), 0.05);
      // The first sample that hears the level starts the run: 25 ms of it is not speaking, 50 ms is.
      await f.advance(25);
      expect(call.state.speaking).toBe(false);
      await f.advance(25);
      expect(call.state.speaking).toBe(false);
      await f.advance(25);
      expect(call.state.speaking).toBe(true);
      m.levels.set(ownTrack(f), 0);
      await f.advance(25);
      await f.advance(275);
      expect(call.state.speaking).toBe(true);
      await f.advance(25);
      expect(call.state.speaking).toBe(false);
    });

    it('M4: the SFU flag no longer decides the own speaking while a meter reads', async () => {
      const f = fakes();
      withMeters(f);
      const call = await start(f);
      (f.room.localParticipant as unknown as { isSpeaking: boolean }).isSpeaking = true;
      f.room.emit('activeSpeakersChanged', [f.room.localParticipant]);
      await f.advance(100);
      expect(call.state.speaking).toBe(false);
    });

    it('the own speaking is false whatever the level while muted, deafened, paused or push to talk is up', async () => {
      const f = fakes();
      const m = withMeters(f);
      const call = await start(f);
      m.levels.set(ownTrack(f), 0.2);
      await f.advance(100);
      expect(call.state.speaking).toBe(true);
      call.setMuted(true);
      expect(call.state.speaking).toBe(false);
      await f.advance(200);
      expect(call.state.speaking).toBe(false);
      expect(call.state.level).toBe(0);
      call.setMuted(false);
      await f.advance(100);
      expect(call.state.speaking).toBe(true);
      call.setDeafened(true);
      await f.advance(100);
      expect(call.state.speaking).toBe(false);
      call.setDeafened(false);
      call.setMuted(false);
      await f.advance(100);
      expect(call.state.speaking).toBe(true);
      await call.setPaused(true);
      expect(call.state.speaking).toBe(false); // at once, before the next sample
      await f.advance(100);
      expect(call.state.speaking).toBe(false);
      await call.setPaused(false);
      await f.advance(100);
      expect(call.state.speaking).toBe(true);
      call.setMode('ptt');
      await f.advance(100);
      expect(call.state.speaking).toBe(false);
      call.pushToTalk(true);
      await f.advance(100);
      expect(call.state.speaking).toBe(true);
      call.pushToTalk(false);
      await f.advance(50);
      expect(call.state.speaking).toBe(false);
    });

    it('a remote tile with an attached track follows its meter and ignores the SFU flag', async () => {
      const f = fakes();
      const m = withMeters(f);
      const call = await start(f);
      const { p, track } = heard(f);
      await f.advance(100);
      p.isSpeaking = true;
      f.room.emit('activeSpeakersChanged', [p]);
      expect(tileOf(call, BOB_DEV).speaking).toBe(false);
      m.levels.set(track.mst, 0.1);
      await f.advance(75);
      expect(tileOf(call, BOB_DEV).speaking).toBe(true);
      p.isSpeaking = false;
      await f.advance(100);
      expect(tileOf(call, BOB_DEV).speaking).toBe(true);
      m.levels.set(track.mst, 0);
      await f.advance(325);
      expect(tileOf(call, BOB_DEV).speaking).toBe(false);
    });

    it('a track that is not attached (deafened) falls back to the SFU flag; paused gives false for every tile', async () => {
      const f = fakes();
      const m = withMeters(f);
      const call = await start(f, { self: 'deafened' });
      const { p, track } = heard(f);
      expect(track.attach).not.toHaveBeenCalled();
      expect(m.made.filter((x) => x.track === track.mst)).toHaveLength(0);
      p.isSpeaking = true;
      f.room.emit('activeSpeakersChanged', [p]);
      expect(tileOf(call, BOB_DEV).speaking).toBe(true);
      await call.setPaused(true);
      expect(tileOf(call, BOB_DEV).speaking).toBe(false);
      await call.setPaused(false);
      p.isSpeaking = false;
      f.room.emit('activeSpeakersChanged', []);
      expect(tileOf(call, BOB_DEV).speaking).toBe(false);
    });

    it('a track attached before the volume went to 0 falls back to the SFU flag from then on', async () => {
      const f = fakes();
      const m = withMeters(f);
      const call = await start(f);
      const { p, track } = heard(f);
      m.levels.set(track.mst, 0.1);
      await f.advance(100);
      expect(tileOf(call, BOB_DEV).speaking).toBe(true);
      call.setVolume(BOB, 0);
      await f.advance(25);
      expect(tileOf(call, BOB_DEV).speaking).toBe(false);
      p.isSpeaking = true;
      f.room.emit('activeSpeakersChanged', [p]);
      expect(tileOf(call, BOB_DEV).speaking).toBe(true);
    });

    it('with no AudioContext both fall back to the SFU flags', async () => {
      const f = fakes();
      f.deps.audioContext = () => null;
      const m = withMeters(f);
      const call = await start(f);
      const { p } = heard(f);
      expect(m.create).not.toHaveBeenCalled();
      p.isSpeaking = true;
      (f.room.localParticipant as unknown as { isSpeaking: boolean }).isSpeaking = true;
      f.room.emit('activeSpeakersChanged', [p, f.room.localParticipant]);
      expect(tileOf(call, BOB_DEV).speaking).toBe(true);
      expect(call.state.speaking).toBe(true);
      call.setMuted(true);
      expect(call.state.speaking).toBe(false);
    });

    it('I1: with push to talk and the key up the own speaking is false whatever the level, also with a ptt processor', async () => {
      const f = fakes();
      const m = withMeters(f);
      f.deps.createNoiseProcessor = () => ({ setPttActive: vi.fn() });
      const call = await start(f, { mode: 'ptt', noise: 'on' });
      m.levels.set(ownTrack(f), 0.2);
      await f.advance(150);
      expect(call.state.speaking).toBe(false);
      expect(call.state.level).toBe(0);
      call.pushToTalk(true);
      await f.advance(150);
      expect(call.state.speaking).toBe(true);
      call.pushToTalk(false);
      expect(call.state.speaking).toBe(false); // at once, no 300 ms hold after the release
      await f.advance(150);
      expect(call.state.speaking).toBe(false);
    });

    it('I2: a suspended AudioContext falls back to the SFU flag', async () => {
      const f = fakes();
      const m = withMeters(f);
      const call = await start(f);
      const { p, track } = heard(f);
      m.levels.set(track.mst, 0.1);
      m.levels.set(ownTrack(f), 0.1);
      f.contexts[0].to('suspended');
      await f.advance(150);
      expect(tileOf(call, BOB_DEV).speaking).toBe(false);
      expect(call.state.speaking).toBe(false);
      p.isSpeaking = true;
      f.room.emit('activeSpeakersChanged', [p]);
      expect(tileOf(call, BOB_DEV).speaking).toBe(true);
    });

    it('m2: deafening silences the own speaking at once', async () => {
      const f = fakes();
      const m = withMeters(f);
      const call = await start(f);
      m.levels.set(ownTrack(f), 0.2);
      await f.advance(150);
      expect(call.state.speaking).toBe(true);
      call.setDeafened(true);
      expect(call.state.speaking).toBe(false);
    });

    it('m3: the own fallback (no context) is also false while push to talk is up', async () => {
      const f = fakes();
      f.deps.audioContext = () => null;
      const call = await start(f, { mode: 'ptt' });
      (f.room.localParticipant as unknown as { isSpeaking: boolean }).isSpeaking = true;
      f.room.emit('activeSpeakersChanged', [f.room.localParticipant]);
      expect(call.state.speaking).toBe(false);
      call.pushToTalk(true);
      f.room.emit('activeSpeakersChanged', [f.room.localParticipant]);
      expect(call.state.speaking).toBe(true);
    });

    it('m6: a remote meter that appears mid-call arms the sampler, and the last detach idles it', async () => {
      const f = fakes();
      const m = withMeters(f);
      f.deps.createLevelMeter = (ctx, track) => ((track as unknown) === ownTrack(f) ? null : m.create(ctx, track));
      const call = await start(f);
      const idle = f.timers.size;
      const { p, track, pub } = heard(f);
      expect(f.timers.size).toBe(idle + 1);
      m.levels.set(track.mst, 0.1);
      await f.advance(100);
      expect(tileOf(call, BOB_DEV).speaking).toBe(true);
      expect(p.isSpeaking).toBe(false);
      f.unsubscribeTrack(p, pub);
      await f.advance(25);
      expect(f.timers.size).toBe(idle);
    });

    it('m4: the sampler idles when no meter exists, and runs once one does', async () => {
      const f = fakes();
      f.deps.createLevelMeter = () => null;
      await start(f);
      const idle = f.timers.size;
      const g = fakes();
      withMeters(g);
      await start(g);
      expect(g.timers.size).toBe(idle + 1);
    });

    it('a meter that cannot be made means the fallback, never an error', async () => {
      const f = fakes();
      f.deps.createLevelMeter = () => null;
      const call = await start(f);
      const { p } = heard(f);
      p.isSpeaking = true;
      f.room.emit('activeSpeakersChanged', [p]);
      expect(tileOf(call, BOB_DEV).speaking).toBe(true);
      expect(call.state.error).toBeNull();
      const g = fakes();
      g.deps.createLevelMeter = () => { throw new Error('no analyser'); };
      const other = await start(g);
      expect(other.state.error).toBeNull();
      expect(other.state.phase).toBe('connected');
    });

    it('the level (0..12) comes from the own meter', async () => {
      const f = fakes();
      const m = withMeters(f);
      const call = await start(f);
      m.levels.set(ownTrack(f), 0.1);
      await f.advance(100);
      expect(call.state.level).toBe(5);
      m.levels.set(ownTrack(f), 0.9);
      await f.advance(100);
      expect(call.state.level).toBe(12);
    });

    it('a speaking flip is published at once, a level change at most every 100 ms', async () => {
      const f = fakes();
      const m = withMeters(f);
      const call = await start(f);
      const seen: Array<[boolean, number]> = [];
      call.subscribe(() => { seen.push([call.state.speaking, call.state.level]); });
      m.levels.set(ownTrack(f), 0.1);
      await f.advance(75);
      expect(seen.some(([s]) => s)).toBe(true);
      seen.length = 0;
      // The level wanders every tick; the state changes at most once per 100 ms.
      for (let i = 0; i < 8; i++) {
        m.levels.set(ownTrack(f), 0.1 + (i % 2 === 0 ? 0.02 : 0.04));
        await f.advance(25);
      }
      expect(seen.length).toBeGreaterThan(0);
      expect(seen.length).toBeLessThanOrEqual(2);
    });

    it('every meter is closed on detach and on leave("user"), and no timer is left after ended', async () => {
      const f = fakes();
      const m = withMeters(f);
      const call = await start(f);
      const bob = heard(f);
      const carol = heard(f, CAROL_DEV);
      const closed = (t: unknown) => m.made.find((x) => x.track === t)!.close;
      expect(closed(ownTrack(f))).not.toHaveBeenCalled();
      f.unsubscribeTrack(bob.p, bob.pub);
      expect(closed(bob.track.mst)).toHaveBeenCalledTimes(1);
      expect(closed(carol.track.mst)).not.toHaveBeenCalled();
      await call.leave('user');
      expect(closed(ownTrack(f))).toHaveBeenCalledTimes(1);
      expect(closed(carol.track.mst)).toHaveBeenCalledTimes(1);
      expect(f.timers.size).toBe(0);
    });

    it('every meter is closed when the room ends', async () => {
      const f = fakes();
      const m = withMeters(f);
      const call = await start(f);
      const bob = heard(f);
      f.room.emit('disconnected', 1);
      await f.advance(10);
      expect(call.state.phase).toBe('ended');
      expect(m.made.some((x) => x.track === bob.track.mst)).toBe(true);
      for (const x of m.made) expect(x.close).toHaveBeenCalledTimes(1);
      expect(f.timers.size).toBe(0);
    });

    it('the own meter is closed when a start fails after the publish', async () => {
      const f = fakes();
      const m = withMeters(f);
      (f.room as unknown as { state: string }).state = 'disconnected';
      await expect(startPageCall(f.deps, { channelId: CH, vdec: 'vp8' }, opts)).rejects.toMatchObject({ code: 'E_DISCONNECTED' });
      expect(m.made.length).toBeGreaterThan(0);
      for (const x of m.made) expect(x.close).toHaveBeenCalledTimes(1);
    });

    it('the own meter is replaced when the noise processor swaps the track', async () => {
      const f = fakes();
      const m = withMeters(f);
      const call = await start(f, { noise: 'on' });
      const first = m.made.length;
      const mic = f.localTracks[0] as FakeTrack & { stopProcessor?: () => Promise<void> };
      mic.stopProcessor = vi.fn(async () => undefined);
      await call.setNoise('off');
      expect(m.made.length).toBe(first + 1);
      expect(m.made[first - 1].close).toHaveBeenCalledTimes(1);
    });

    it('no level reaches the bridge', async () => {
      const f = fakes();
      const m = withMeters(f);
      await start(f);
      m.levels.set(ownTrack(f), 0.1);
      await f.advance(200);
      expect(JSON.stringify(f.calls)).not.toMatch(/rms|level|speaking/i);
    });
  });

  it('M1: noise suppression switches during the call', async () => {
    const f = fakes();
    const made: string[] = [];
    f.deps.createNoiseProcessor = (mode) => { made.push(mode); return { setPttActive: vi.fn() }; };
    const call = await start(f, { noise: 'on' });
    const mic = f.localTracks[0] as FakeTrack & { stopProcessor?: () => Promise<void> };
    mic.stopProcessor = vi.fn(async () => undefined);
    expect(mic.setProcessor).toHaveBeenCalledTimes(1);
    await call.setNoise('off');
    expect(mic.stopProcessor).toHaveBeenCalledTimes(1);
    await call.setNoise('off');
    expect(mic.stopProcessor).toHaveBeenCalledTimes(1);
    call.setMode('ptt');
    await call.setNoise('on');
    expect(mic.setProcessor).toHaveBeenCalledTimes(2);
    expect(made).toEqual(['vad', 'ptt']);
    expect(call.state.noise).toBe('on');
  });
});

describe('product walk M5: the own mute and deafen kept across a reload', () => {
  const open: PageCall[] = [];
  afterEach(async () => { for (const c of open.splice(0)) await c.leave('user').catch(() => undefined); });

  it('a start muted sends nothing from the microphone and says so to the others at once', async () => {
    const f = fakes();
    const call = await startPageCall(f.deps, { channelId: CH, vdec: 'vp8' }, { ...opts, self: 'muted' });
    open.push(call);
    expect(call.state).toMatchObject({ muted: true, deafened: false });
    expect(f.localTracks[0].muted).toBe(true);
    // The microphone track was already off when it was published: no frame goes out before the mute lands.
    expect((f.room.localParticipant.publishTrack.mock.calls[0][0] as unknown as { enabled?: boolean }).enabled).toBe(false);
    expect(f.calls).toContainEqual({ m: 'voiceSelf', callId, flags: 1 });
  });

  it('a start deafened plays nothing and is muted too', async () => {
    const f = fakes();
    const call = await startPageCall(f.deps, { channelId: CH, vdec: 'vp8' }, { ...opts, self: 'deafened' });
    open.push(call);
    const bob = f.addRemote(BOB_DEV);
    expect(call.state).toMatchObject({ muted: true, deafened: true });
    expect(f.localTracks[0].muted).toBe(true);
    expect(bob.gains.microphone).toBe(0);
    expect(f.calls).toContainEqual({ m: 'voiceSelf', callId, flags: 3 });
    // Undeafening keeps the microphone muted (fix round 3, m1: the kept mute is never lost to a reload).
    call.setDeafened(false);
    expect(call.state).toMatchObject({ muted: true, deafened: false });
  });
});

describe('re-review N-m1: a drop never takes the key that ends the hold', () => {
  const open: PageCall[] = [];
  afterEach(async () => { for (const c of open.splice(0)) await c.leave('user').catch(() => undefined); });

  it('a hold of epoch N drops nothing once the key of a newer epoch arrived; a drop of the held epoch clears', async () => {
    const f = fakes({ joinEpoch: 1n });
    const call = await startPageCall(f.deps, { channelId: CH, vdec: 'vp8' }, opts);
    open.push(call);
    f.pushKeys(callId, keysFor(2n));
    await flush();
    expect(f.manager.installs.map((k) => k.epoch)).toEqual([1n, 2n]);
    call.dropKeys(1n);
    expect(f.manager.clearKeys).not.toHaveBeenCalled();
    call.dropKeys(2n);
    expect(f.manager.clearKeys).toHaveBeenCalledTimes(1);
  });
});

describe('fix round 3 (wb-fix2-review-client I-1, m1, m2)', () => {
  const open: PageCall[] = [];
  afterEach(async () => { for (const c of open.splice(0)) await c.leave('user').catch(() => undefined); });

  it('I-1: noise off under push to talk keeps the microphone muted with the key up, before the processor stops', async () => {
    const f = fakes();
    f.deps.createNoiseProcessor = () => ({ setPttActive: vi.fn() });
    const call = await startPageCall(f.deps, { channelId: CH, vdec: 'vp8' }, { ...opts, mode: 'ptt', noise: 'on' });
    open.push(call);
    const mic = f.localTracks[0] as FakeTrack & { stopProcessor?: () => Promise<void> };
    // RNNoise built for push to talk gates the audio itself: the track is unmuted, the worklet holds it closed.
    expect(mic.muted).toBe(false);
    const order: string[] = [];
    const mute = mic.mute.bind(mic);
    mic.mute = () => { order.push('mute'); mute(); };
    mic.stopProcessor = vi.fn(async () => { order.push(`stop (muted ${String(mic.muted)})`); });
    await call.setNoise('off');
    expect(order).toEqual(['mute', 'stop (muted true)']);
    expect(mic.muted).toBe(true);
  });

  it('m1: a call started deafened stays muted when undeafened (the kept mute is not lost)', async () => {
    const f = fakes();
    const call = await startPageCall(f.deps, { channelId: CH, vdec: 'vp8' }, { ...opts, self: 'deafened' });
    open.push(call);
    call.setDeafened(false);
    expect(call.state).toMatchObject({ muted: true, deafened: false });
  });

  it('m2: noise on then off before the processor is set leaves no processor running', async () => {
    const f = fakes();
    let finish: () => void = () => undefined;
    f.deps.createNoiseProcessor = () => ({ setPttActive: vi.fn() });
    const call = await startPageCall(f.deps, { channelId: CH, vdec: 'vp8' }, { ...opts, noise: 'off' });
    open.push(call);
    const mic = f.localTracks[0] as FakeTrack & { stopProcessor?: () => Promise<void>; setProcessor: ReturnType<typeof vi.fn> };
    mic.setProcessor = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    mic.stopProcessor = vi.fn(async () => undefined);
    const on = call.setNoise('on');
    const off = call.setNoise('off');
    await flush();
    finish();
    await on;
    await off;
    expect(call.state.noise).toBe('off');
    expect(mic.setProcessor).toHaveBeenCalledTimes(1);
    expect(mic.stopProcessor).toHaveBeenCalledTimes(1);
  });
});

describe('web3.3: remote call audio plays (attach, gains, autoplay, detach)', () => {
  const open: PageCall[] = [];
  afterEach(async () => { for (const c of open.splice(0)) await c.leave('user').catch(() => undefined); });
  const start = async (f: ReturnType<typeof fakes>, o: Partial<PageCallOptions> = {}) => {
    const call = await startPageCall(f.deps, { channelId: CH, vdec: 'vp8' }, { ...opts, ...o });
    open.push(call);
    return call;
  };
  const elementsIn = (host: HTMLElement) => [...host.querySelectorAll('audio, video')];
  const orderOf = (fn: { mock: { invocationCallOrder: number[] } }) => fn.mock.invocationCallOrder;
  /** True when `p.setVolume(volume, source)` ran after `track.attach` (livekit applies a volume only to a gain node that exists). */
  const setAfterAttach = (p: ReturnType<typeof fakeRemote>, track: FakeRemoteTrack, volume: number, source = 'microphone') => {
    const attachedAt = orderOf(track.attach)[0];
    return attachedAt !== undefined
      && p.setVolume.mock.calls.some(([v, s], i) => v === volume && s === source && orderOf(p.setVolume)[i] > attachedAt);
  };

  it('a remote microphone that subscribes is attached once, into the audio host; a camera is not', async () => {
    const f = fakes();
    await start(f);
    const bob = f.addRemote(BOB_DEV);
    const { track } = f.subscribeTrack(bob, 'microphone');
    expect(track.attach).toHaveBeenCalledTimes(1);
    expect(elementsIn(f.audioHost)).toEqual([track.made[0]]);
    const cam = f.subscribeTrack(bob, 'camera');
    expect(cam.track.attach).not.toHaveBeenCalled();
    expect(elementsIn(f.audioHost)).toHaveLength(1);
  });

  it('screen-share audio is attached as the microphone is', async () => {
    const f = fakes();
    await start(f);
    const bob = f.addRemote(BOB_DEV);
    const { track } = f.subscribeTrack(bob, 'screen_share_audio');
    expect(track.attach).toHaveBeenCalledTimes(1);
    expect(elementsIn(f.audioHost)).toEqual([track.made[0]]);
  });

  it('Review Focus 1: a track subscribed before the listeners existed is attached once at connect, never twice', async () => {
    const f = fakes();
    const bob = fakeRemote(BOB_DEV);
    f.room.remoteParticipants.set(BOB_DEV, bob);
    const { track, pub } = f.subscribeTrack(bob, 'microphone', false);
    const call = await start(f);
    expect(call.state.phase).toBe('connected');
    expect(track.attach).toHaveBeenCalledTimes(1);
    expect(elementsIn(f.audioHost)).toHaveLength(1);
    // The room’s own trackSubscribed for the same track, late: still one element.
    f.room.emit('trackSubscribed', track, pub, bob);
    expect(track.attach).toHaveBeenCalledTimes(1);
    expect(elementsIn(f.audioHost)).toHaveLength(1);
  });

  it('Review Focus 1: a track subscribed while the join was still publishing the microphone is attached at connect', async () => {
    const f = fakes();
    const carol = fakeRemote(CAROL_DEV);
    let early: FakeRemoteTrack | null = null;
    const publish = f.room.localParticipant.publishTrack.getMockImplementation()!;
    f.room.localParticipant.publishTrack.mockImplementationOnce(async (track, o) => {
      f.room.remoteParticipants.set(CAROL_DEV, carol);
      early = f.subscribeTrack(carol, 'microphone').track; // heard by nobody yet
      return publish(track, o);
    });
    await start(f);
    expect(early).not.toBeNull();
    expect(early!.attach).toHaveBeenCalledTimes(1);
    expect(elementsIn(f.audioHost)).toHaveLength(1);
  });


  it('a per-person volume set before the attach is applied after it', async () => {
    const f = fakes();
    const call = await start(f);
    const bob = f.addRemote(BOB_DEV);
    call.setVolume(BOB, 50);
    bob.setVolume.mockClear();
    const { track } = f.subscribeTrack(bob, 'microphone');
    expect(setAfterAttach(bob, track, 0.5)).toBe(true);
  });

  it('a track attached by the connect sweep gets its gain after the attach', async () => {
    const f = fakes();
    const bob = fakeRemote(BOB_DEV);
    f.room.remoteParticipants.set(BOB_DEV, bob);
    const { track } = f.subscribeTrack(bob, 'microphone', false);
    await start(f, { volumes: { [BOB]: 50 } });
    expect(setAfterAttach(bob, track, 0.5)).toBe(true);
  });

  // Fix round 2 (Minor 3): the room’s canPlaybackAudio speaks only where the session has no AudioContext of its own.
  it('Review Focus 3: without a session context, the room holding audio back sets audioBlocked, at connect and on audioPlaybackChanged', async () => {
    const f = fakes();
    f.deps.audioContext = () => null;
    f.room.canPlaybackAudio = false;
    const call = await start(f);
    expect(call.state.audioBlocked).toBe(true);
    const g = fakes();
    g.deps.audioContext = () => null;
    const other = await start(g);
    expect(other.state.audioBlocked).toBe(false);
    const seen = vi.fn();
    other.subscribe(seen);
    g.room.canPlaybackAudio = false;
    g.room.emit('audioPlaybackChanged', false);
    expect(other.state.audioBlocked).toBe(true);
    expect(seen).toHaveBeenCalled();
    g.room.canPlaybackAudio = true;
    g.room.emit('audioPlaybackChanged', true);
    expect(other.state.audioBlocked).toBe(false);
  });

  it('without a session context, startAudio() asks the room to start audio, then reads canPlaybackAudio again', async () => {
    const f = fakes();
    f.deps.audioContext = () => null;
    f.room.canPlaybackAudio = false;
    const call = await start(f);
    f.room.startAudio.mockImplementation(async () => { f.room.canPlaybackAudio = true; });
    await call.startAudio();
    expect(f.room.startAudio).toHaveBeenCalledTimes(1);
    expect(call.state.audioBlocked).toBe(false);
  });

  it('without a session context, a refused startAudio() leaves audioBlocked true and does not throw', async () => {
    const f = fakes();
    f.deps.audioContext = () => null;
    f.room.canPlaybackAudio = false;
    const call = await start(f);
    f.room.startAudio.mockRejectedValue(new Error('NotAllowedError'));
    await expect(call.startAudio()).resolves.toBeUndefined();
    expect(call.state.audioBlocked).toBe(true);
  });

  it('Review Focus 5: trackUnsubscribed detaches and removes that element; the speaker coming back attaches once', async () => {
    const f = fakes();
    await start(f);
    const bob = f.addRemote(BOB_DEV);
    const carol = f.addRemote(CAROL_DEV);
    const first = f.subscribeTrack(bob, 'microphone');
    const kept = f.subscribeTrack(carol, 'microphone');
    const el = first.track.made[0];
    f.unsubscribeTrack(bob, first.pub);
    expect(first.track.detach).toHaveBeenCalledWith(el);
    expect(el.isConnected).toBe(false);
    expect(elementsIn(f.audioHost)).toEqual([kept.track.made[0]]);
    // SpeakerPolicy lets bob back in: a new subscription (heard twice), one new element.
    const again = f.subscribeTrack(bob, 'microphone');
    f.room.emit('trackSubscribed', again.track, again.pub, bob);
    expect(again.track.attach).toHaveBeenCalledTimes(1);
    expect(elementsIn(f.audioHost)).toHaveLength(2);
  });

  it('a participant who leaves leaves no element of theirs', async () => {
    const f = fakes();
    await start(f);
    const bob = f.addRemote(BOB_DEV);
    const { track } = f.subscribeTrack(bob, 'microphone');
    f.room.remoteParticipants.delete(BOB_DEV);
    f.room.emit('participantDisconnected', bob);
    expect(track.detach).toHaveBeenCalledWith(track.made[0]);
    expect(elementsIn(f.audioHost)).toEqual([]);
  });

  for (const reason of ['user', 'switch', 'pagehide', 'lost'] as const) {
    it(`Review Focus 4: leave('${reason}') detaches every attached track and empties the container`, async () => {
      const f = fakes();
      const call = await start(f);
      const bob = f.addRemote(BOB_DEV);
      const carol = f.addRemote(CAROL_DEV);
      const tracks = [f.subscribeTrack(bob, 'microphone').track, f.subscribeTrack(carol, 'microphone').track,
        f.subscribeTrack(bob, 'screen_share_audio').track];
      expect(elementsIn(f.audioHost)).toHaveLength(3);
      await call.leave(reason);
      expect(elementsIn(f.audioHost)).toEqual([]);
      for (const t of tracks) expect(t.detach).toHaveBeenCalledWith(t.made[0]);
      // Nothing is attached after the leave.
      f.subscribeTrack(fakeRemote(DEV_D), 'microphone');
      expect(elementsIn(f.audioHost)).toEqual([]);
    });
  }

  it('Review Focus 4: a second call after a leave starts from an empty container, one element per track', async () => {
    const f = fakes();
    const bob = fakeRemote(BOB_DEV);
    f.room.remoteParticipants.set(BOB_DEV, bob);
    const { track } = f.subscribeTrack(bob, 'microphone', false);
    const first = await start(f);
    expect(elementsIn(f.audioHost)).toHaveLength(1);
    await first.leave('switch');
    expect(elementsIn(f.audioHost)).toEqual([]);
    await start(f);
    expect(track.attach).toHaveBeenCalledTimes(2);
    expect(track.attached).toHaveLength(1);
    expect(elementsIn(f.audioHost)).toHaveLength(1);
  });

  it('the attached elements sit under aria-hidden and carry no controls', async () => {
    const f = fakes();
    await start(f);
    const bob = f.addRemote(BOB_DEV);
    const { track } = f.subscribeTrack(bob, 'microphone');
    const el = track.made[0];
    expect(el.controls).toBe(false);
    expect(el.getAttribute('aria-hidden')).toBe('true');
  });
});

describe('web3.3: the default audio host', () => {
  it('is one hidden, aria-hidden container on document.body, created on first use', async () => {
    const f = fakes();
    delete f.deps.audioHost;
    const call = await startPageCall(f.deps, { channelId: CH, vdec: 'vp8' }, opts);
    const bob = f.addRemote(BOB_DEV);
    const { track } = f.subscribeTrack(bob, 'microphone');
    const again = f.subscribeTrack(bob, 'screen_share_audio');
    const hosts = document.querySelectorAll('[data-dilla-call-audio]');
    expect(hosts).toHaveLength(1);
    const host = hosts[0] as HTMLElement;
    expect(host.parentElement).toBe(document.body);
    expect(host.hidden).toBe(true);
    expect(host.getAttribute('aria-hidden')).toBe('true');
    expect(track.made[0].parentElement).toBe(host);
    expect(again.track.made[0].parentElement).toBe(host);
    await call.leave('user');
    expect(host.children).toHaveLength(0);
  });
});

describe('web3.3 fix round 1: the session’s AudioContext (I1, M2), no blip while silent (I3), abandon (M3)', () => {
  const open: PageCall[] = [];
  afterEach(async () => { for (const c of open.splice(0)) await c.leave('user').catch(() => undefined); });
  const start = async (f: ReturnType<typeof fakes>, o: Partial<PageCallOptions> = {}) => {
    const call = await startPageCall(f.deps, { channelId: CH, vdec: 'vp8' }, { ...opts, ...o });
    open.push(call);
    return call;
  };
  const elementsIn = (host: HTMLElement) => [...host.querySelectorAll('audio, video')];
  /** The order of `track.attach` against the first later `p.setVolume(volume)`: attach first, then the volume. */
  const attachThenVolume = (p: ReturnType<typeof fakeRemote>, track: FakeRemoteTrack, volume: number) => {
    const at = track.attach.mock.invocationCallOrder[0];
    return at !== undefined && p.setVolume.mock.calls.some(([v, s], i) => v === volume && s === 'microphone'
      && p.setVolume.mock.invocationCallOrder[i] > at);
  };

  it('I1: the output device goes to the session’s AudioContext, where remote audio plays', async () => {
    const f = fakes();
    await start(f, { output: 'spk' });
    expect(f.contexts[0].setSinkId).toHaveBeenCalledWith('spk');
    const g = fakes();
    await start(g);
    expect(g.contexts[0].setSinkId).not.toHaveBeenCalled();
    // A browser whose AudioContext cannot choose an output (Firefox) joins all the same, on the system default.
    const h = fakes();
    h.audio.noSinkId = true;
    const call = await start(h, { output: 'spk' });
    expect(call.state.phase).toBe('connected');
  });

  it('I1: a refused setSinkId does not end the call', async () => {
    const f = fakes();
    f.deps.audioContext = () => {
      const ctx = new FakeAudioContext();
      ctx.setSinkId.mockRejectedValue(new Error('NotFoundError'));
      f.contexts.push(ctx);
      return ctx as unknown as AudioContext;
    };
    const call = await start(f, { output: 'gone' });
    await flush();
    expect(call.state.phase).toBe('connected');
  });

  it('V1: setOutput mid-call sends the new device to the session’s AudioContext', async () => {
    const f = fakes();
    const call = await start(f, { output: 'spk' });
    await call.setOutput('headset');
    expect(f.contexts[0].setSinkId).toHaveBeenLastCalledWith('headset');
    // '' is the system default, which setSinkId takes as it is.
    await call.setOutput('');
    expect(f.contexts[0].setSinkId).toHaveBeenLastCalledWith('');
  });

  it('V1: setOutput on a context that cannot choose an output (Firefox) is a no-op', async () => {
    const f = fakes();
    f.audio.noSinkId = true;
    const call = await start(f);
    await expect(call.setOutput('headset')).resolves.toBeUndefined();
    expect(call.state.phase).toBe('connected');
  });

  it('V1: a refused setOutput rejects, so the shell can say so, and the call goes on', async () => {
    const f = fakes();
    const call = await start(f);
    f.contexts[0].setSinkId.mockRejectedValueOnce(new Error('NotFoundError'));
    await expect(call.setOutput('gone')).rejects.toThrow('NotFoundError');
    expect(call.state.phase).toBe('connected');
  });

  it('V1: setOutput after the leave touches nothing', async () => {
    const f = fakes();
    const call = await start(f);
    await call.leave('user');
    f.contexts[0].setSinkId.mockClear();
    await call.setOutput('headset');
    expect(f.contexts[0].setSinkId).not.toHaveBeenCalled();
  });

  it('M2: audioBlocked follows the context: suspended at connect, running on statechange', async () => {
    const f = fakes();
    f.audio.contextState = 'suspended';
    const call = await start(f);
    expect(call.state.audioBlocked).toBe(true);
    const seen = vi.fn();
    call.subscribe(seen);
    f.contexts[0].to('running');
    expect(call.state.audioBlocked).toBe(false);
    expect(seen).toHaveBeenCalled();
    f.contexts[0].to('suspended');
    expect(call.state.audioBlocked).toBe(true);
  });

  it('M2: startAudio() resumes the context and starts the room’s audio within the press, before any await', async () => {
    const f = fakes();
    f.audio.contextState = 'suspended';
    const call = await start(f);
    const ctx = f.contexts[0];
    const pending = call.startAudio();
    // Both ran synchronously inside the click: nothing was awaited first.
    expect(ctx.resume).toHaveBeenCalledTimes(1);
    expect(f.room.startAudio).toHaveBeenCalledTimes(1);
    await pending;
    expect(call.state.audioBlocked).toBe(false);
  });

  it('M2: a context that will not resume leaves audioBlocked true and startAudio() does not throw', async () => {
    const f = fakes();
    f.audio.contextState = 'suspended';
    const call = await start(f);
    f.contexts[0].resume.mockRejectedValue(new Error('NotAllowedError'));
    await expect(call.startAudio()).resolves.toBeUndefined();
    expect(call.state.audioBlocked).toBe(true);
  });

  for (const reason of ['user', 'switch', 'pagehide', 'lost', 'blocked', 'removed'] as const) {
    it(`I1: leave('${reason}') closes the session’s AudioContext`, async () => {
      const f = fakes();
      const call = await start(f);
      await call.leave(reason);
      expect(f.contexts[0].close).toHaveBeenCalledTimes(1);
      expect(f.contexts[0].state).toBe('closed');
    });
  }

  it('I1: a failed start closes its AudioContext (joinCall failed, callJoin refused, an abort at the microphone prompt)', async () => {
    const f = fakes({ joinCallError: new Error('E_CALL_IN_OTHER_TAB') });
    await expect(startPageCall(f.deps, { channelId: CH, vdec: 'vp8' }, opts)).rejects.toThrow();
    expect(f.contexts.every((c) => c.state === 'closed')).toBe(true);
    const g = fakes();
    g.deps.bridge.call = vi.fn(async () => { throw Object.assign(new Error('E_FORBIDDEN'), { code: 'E_FORBIDDEN' }); });
    await expect(startPageCall(g.deps, { channelId: CH, vdec: 'vp8' }, opts)).rejects.toThrow();
    expect(g.contexts.every((c) => c.state === 'closed')).toBe(true);
    const h = fakes({ getUserMedia: () => new Promise<MediaStream>(() => undefined) });
    const abort = new AbortController();
    const started = startPageCall(h.deps, { channelId: CH, vdec: 'vp8' }, { ...opts, signal: abort.signal });
    await flush();
    abort.abort();
    await expect(started).rejects.toThrow(/E_ABORTED/);
    expect(h.contexts.every((c) => c.state === 'closed')).toBe(true);
  });

  it('I3: deafened, a newcomer is not attached; undeafen attaches it once, then sets its volume', async () => {
    const f = fakes();
    const call = await start(f);
    call.setDeafened(true);
    const bob = f.addRemote(BOB_DEV);
    const { track } = f.subscribeTrack(bob, 'microphone');
    expect(track.attach).not.toHaveBeenCalled();
    expect(elementsIn(f.audioHost)).toEqual([]);
    bob.setVolume.mockClear();
    call.setDeafened(false);
    expect(track.attach).toHaveBeenCalledTimes(1);
    expect(attachThenVolume(bob, track, 1)).toBe(true);
    expect(elementsIn(f.audioHost)).toHaveLength(1);
  });

  it('V2: state.audio counts the subscribed remote audio tracks (expected) and the attached ones', async () => {
    const f = fakes();
    const call = await start(f);
    expect(call.state.audio).toEqual({ attached: 0, expected: 0 });
    const seen = vi.fn();
    call.subscribe(() => { seen(call.state.audio); });
    const bob = f.addRemote(BOB_DEV);
    const mic = f.subscribeTrack(bob, 'microphone');
    expect(call.state.audio).toEqual({ attached: 1, expected: 1 });
    // A camera is not audio.
    f.subscribeTrack(bob, 'camera');
    expect(call.state.audio).toEqual({ attached: 1, expected: 1 });
    // Deafened: a new track is subscribed but held back, so it is expected and not attached; the one attached before
    // stays attached (its gain goes to 0).
    call.setDeafened(true);
    const screenAudio = f.subscribeTrack(bob, 'screen_share_audio');
    expect(call.state.audio).toEqual({ attached: 1, expected: 2 });
    call.setDeafened(false);
    expect(call.state.audio).toEqual({ attached: 2, expected: 2 });
    f.unsubscribeTrack(bob, screenAudio.pub);
    expect(call.state.audio).toEqual({ attached: 1, expected: 1 });
    f.unsubscribeTrack(bob, mic.pub);
    expect(call.state.audio).toEqual({ attached: 0, expected: 0 });
    expect(seen).toHaveBeenCalledWith({ attached: 1, expected: 2 });
  });

  it('V2: a pending track that leaves with its participant is no longer expected; the leave counts nothing', async () => {
    const f = fakes();
    const call = await start(f);
    call.setDeafened(true);
    const bob = f.addRemote(BOB_DEV);
    f.subscribeTrack(bob, 'microphone');
    expect(call.state.audio).toEqual({ attached: 0, expected: 1 });
    f.room.remoteParticipants.delete(BOB_DEV);
    f.room.emit('participantDisconnected', bob);
    expect(call.state.audio).toEqual({ attached: 0, expected: 0 });
    call.setDeafened(false);
    const carol = f.addRemote(BOB_DEV);
    f.subscribeTrack(carol, 'microphone');
    expect(call.state.audio).toEqual({ attached: 1, expected: 1 });
    await call.leave('user');
    expect(call.state.audio).toEqual({ attached: 0, expected: 0 });
  });

  it('I3: a per-person volume of 0 holds the attach back until it rises to 50', async () => {
    const f = fakes();
    const call = await start(f);
    call.setVolume(BOB, 0);
    const bob = f.addRemote(BOB_DEV);
    const { track } = f.subscribeTrack(bob, 'microphone');
    expect(track.attach).not.toHaveBeenCalled();
    bob.setVolume.mockClear();
    call.setVolume(BOB, 50);
    expect(track.attach).toHaveBeenCalledTimes(1);
    expect(attachThenVolume(bob, track, 0.5)).toBe(true);
  });

  it('I3: paused, a newcomer is not attached; the resume attaches it once', async () => {
    const f = fakes();
    const call = await start(f);
    await call.setPaused(true);
    const bob = f.addRemote(BOB_DEV);
    const { track } = f.subscribeTrack(bob, 'microphone');
    expect(track.attach).not.toHaveBeenCalled();
    bob.setVolume.mockClear();
    await call.setPaused(false);
    expect(track.attach).toHaveBeenCalledTimes(1);
    expect(attachThenVolume(bob, track, 1)).toBe(true);
  });

  it('I3: a SpeakerPolicy re-subscribe while deafened attaches nothing; one element once undeafened', async () => {
    const f = fakes();
    const call = await start(f);
    const bob = f.addRemote(BOB_DEV);
    const first = f.subscribeTrack(bob, 'microphone');
    expect(first.track.attach).toHaveBeenCalledTimes(1);
    call.setDeafened(true);
    f.unsubscribeTrack(bob, first.pub);
    expect(elementsIn(f.audioHost)).toEqual([]);
    const again = f.subscribeTrack(bob, 'microphone');
    expect(again.track.attach).not.toHaveBeenCalled();
    // Excluded again before the undeafen: nothing is left pending for it.
    f.unsubscribeTrack(bob, again.pub);
    const third = f.subscribeTrack(bob, 'microphone');
    call.setDeafened(false);
    expect(again.track.attach).not.toHaveBeenCalled();
    expect(third.track.attach).toHaveBeenCalledTimes(1);
    expect(elementsIn(f.audioHost)).toHaveLength(1);
  });

  it('I3: a call started deafened attaches nothing at connect; a pending track that leaves is never attached', async () => {
    const f = fakes();
    const bob = fakeRemote(BOB_DEV);
    f.room.remoteParticipants.set(BOB_DEV, bob);
    const { track } = f.subscribeTrack(bob, 'microphone', false);
    const call = await start(f, { self: 'deafened' });
    expect(track.attach).not.toHaveBeenCalled();
    f.room.remoteParticipants.delete(BOB_DEV);
    f.room.emit('participantDisconnected', bob);
    call.setDeafened(false);
    expect(track.attach).not.toHaveBeenCalled();
    await call.leave('user');
    expect(elementsIn(f.audioHost)).toEqual([]);
  });

  it('I3: the tile of an unattached (deafened) speaker still turns ok: verification is the media worker’s, not the element’s', async () => {
    const f = fakes();
    const call = await start(f);
    call.setDeafened(true);
    const bob = f.addRemote(BOB_DEV);
    f.subscribeTrack(bob, 'microphone');
    f.verified.add(BOB_DEV);
    await f.advance(1_000);
    expect(call.state.tiles.find((t) => t.deviceId === BOB_DEV)?.state).toBe('ok');
  });

  it('M3: a start that fails after the room listeners were registered unregisters them and attaches nothing', async () => {
    const f = fakes();
    const bob = fakeRemote(BOB_DEV);
    f.room.remoteParticipants.set(BOB_DEV, bob);
    const { track } = f.subscribeTrack(bob, 'microphone', false);
    const publish = f.room.localParticipant.publishTrack.getMockImplementation()!;
    f.room.localParticipant.publishTrack.mockImplementationOnce(async (t, o) => {
      const out = await publish(t, o);
      (f.room as unknown as { state: string }).state = 'disconnected';
      return out;
    });
    await expect(startPageCall(f.deps, { channelId: CH, vdec: 'vp8' }, opts)).rejects.toThrow(/E_DISCONNECTED/);
    for (const e of ['trackSubscribed', 'trackUnsubscribed', 'participantConnected', 'participantDisconnected',
      'activeSpeakersChanged', 'audioPlaybackChanged']) expect(f.room.count(e), e).toBe(0);
    f.room.emit('trackSubscribed', track, undefined, bob);
    expect(track.attach).not.toHaveBeenCalled();
    expect(elementsIn(f.audioHost)).toEqual([]);
    expect(f.contexts[0].state).toBe('closed');
  });
});

describe('web3.3 fix round 2: the passed context, newcomers before the roster, the lingering line, a failed attach', () => {
  const open: PageCall[] = [];
  afterEach(async () => { for (const c of open.splice(0)) await c.leave('user').catch(() => undefined); });
  const start = async (f: ReturnType<typeof fakes>, o: Partial<PageCallOptions> = {}) => {
    const call = await startPageCall(f.deps, { channelId: CH, vdec: 'vp8' }, { ...opts, ...o });
    open.push(call);
    return call;
  };
  const elementsIn = (host: HTMLElement) => [...host.querySelectorAll('audio, video')];

  it('Minor 1: a context passed in (made in the press) is the one used and closed; none of its own is made', async () => {
    const f = fakes();
    const passed = new FakeAudioContext();
    const call = await start(f, { audioContext: passed as unknown as AudioContext, output: 'spk' });
    expect(f.contexts).toHaveLength(0);
    expect(f.joinOptions?.roomOptions?.webAudioMix).toEqual({ audioContext: passed });
    expect(passed.setSinkId).toHaveBeenCalledWith('spk');
    await call.leave('user');
    expect(passed.close).toHaveBeenCalledTimes(1);
  });

  it('Minor 1: a passed context is closed by a start that fails', async () => {
    const f = fakes({ joinCallError: new Error('E_CALL_IN_OTHER_TAB') });
    const passed = new FakeAudioContext();
    await expect(startPageCall(f.deps, { channelId: CH, vdec: 'vp8' }, { ...opts, audioContext: passed as unknown as AudioContext }))
      .rejects.toThrow();
    expect(passed.state).toBe('closed');
  });

  it('Minor 2: a track subscribed before its device is in the roster waits; muted by its volume it never plays; at 50 it attaches once', async () => {
    const f = fakes();
    const call = await start(f, { volumes: { [ALICE_USER]: 0 } });
    const alice = f.addRemote(ALICE);
    const { track } = f.subscribeTrack(alice, 'microphone');
    // Not in the roster yet: its gain is unknown, so it is not attached at full gain.
    expect(track.attach).not.toHaveBeenCalled();
    f.pushKeys(callId, keysFor(2n, [...BASE_ROSTER, { leaf: 3, deviceId: ALICE, userId: ALICE_USER }]));
    await flush(); // the roster moves once the media worker holds the epoch’s key
    // In the roster at volume 0: still nothing.
    expect(track.attach).not.toHaveBeenCalled();
    alice.setVolume.mockClear();
    call.setVolume(ALICE_USER, 50);
    expect(track.attach).toHaveBeenCalledTimes(1);
    const at = track.attach.mock.invocationCallOrder[0];
    expect(alice.setVolume.mock.calls.some(([v, s], i) => v === 0.5 && s === 'microphone' && alice.setVolume.mock.invocationCallOrder[i] > at))
      .toBe(true);
  });

  it('Minor 2: a newcomer the roster maps later at full volume is attached by that roster change', async () => {
    const f = fakes();
    await start(f);
    const alice = f.addRemote(ALICE);
    const { track } = f.subscribeTrack(alice, 'microphone');
    expect(track.attach).not.toHaveBeenCalled();
    f.pushKeys(callId, keysFor(2n, [...BASE_ROSTER, { leaf: 3, deviceId: ALICE, userId: ALICE_USER }]));
    await flush(); // the roster moves once the media worker holds the epoch’s key
    expect(track.attach).toHaveBeenCalledTimes(1);
    expect(elementsIn(f.audioHost)).toHaveLength(1);
  });

  it('Minor 3: with a session context, the line goes once the context runs, whatever canPlaybackAudio still says', async () => {
    const f = fakes();
    f.audio.contextState = 'suspended';
    f.room.canPlaybackAudio = false;
    const call = await start(f);
    expect(call.state.audioBlocked).toBe(true);
    f.contexts[0].to('running');
    expect(call.state.audioBlocked).toBe(false);
    f.room.emit('audioPlaybackChanged', false);
    expect(call.state.audioBlocked).toBe(false);
  });

  it('Nit 1: no host yet, or an attach that throws, keeps the track pending; the next gain change attaches it once', async () => {
    const f = fakes();
    const host = f.audioHost;
    let hostReady = false;
    f.deps.audioHost = () => (hostReady ? host : null);
    const call = await start(f);
    const bob = f.addRemote(BOB_DEV);
    const { track } = f.subscribeTrack(bob, 'microphone');
    expect(track.attach).not.toHaveBeenCalled();
    hostReady = true;
    track.attach.mockImplementationOnce(() => { throw new Error('NotSupportedError'); });
    call.setVolume(BOB, 90);
    expect(track.attach).toHaveBeenCalledTimes(1);
    expect(elementsIn(host)).toEqual([]);
    call.setVolume(BOB, 80);
    expect(track.attach).toHaveBeenCalledTimes(2);
    expect(elementsIn(host)).toHaveLength(1);
    call.setVolume(BOB, 70);
    expect(track.attach).toHaveBeenCalledTimes(2);
  });
});
