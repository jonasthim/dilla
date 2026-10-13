// The page call session (L-WEB-50): it owns the LiveKit Room through @dilla/media’s joinCall, and the media keys
// through the key relay (keys.ts). Order matters at both ends:
// - join: subscribe onCallKeys, then send callJoin (the join key is a callKeys push posted just before callJoin’s
//   answer), then joinCall with that key and minEpoch = the join epoch;
// - leave: a person’s leave posts callLeave before the room disconnects; a block or removal stops media first and
//   posts callLeave after, because keys must stop before anything else then.
// No key byte reaches the state, a log or an error here: keys.ts holds the only copies and zero-fills them.
// This module is loaded only through load.ts (L-WEB-51), so livekit-client and RNNoise stay out of the entry chunk.
import type { CallJoinResult, CoreClient, IceServerTuple } from '@dilla/client-core';
import {
  chooseVideoCodec, decodeCaps, DillaRnnoiseProcessor, joinCall, micOptions, publishDefaults, refreshIceServers,
  screenAudioOptions, SpeakerPolicy, VoiceGate, type CallCaps, type CallSession, type JoinCallOptions,
} from '@dilla/media';
import { acquireCamera, acquireMic, acquireScreen, type CaptureMedia, type DisplayMedia } from './devices.ts';
import { createKeyRelay, toEpochKeys } from './keys.ts';
import { callStatsReport, connectionOf, mediaTotals, STATS_EVERY_MS, type MediaTotals } from './stats.ts';
import { gainOf, isVolume, type Volumes } from './volume.ts';

export { isVoiceSupported, localDecodeList } from '@dilla/media';
export { bindPushToTalk } from './ptt.ts';
export { volumesFromSettings } from './volume.ts';

export type TileState = 'connecting' | 'not-heard' | 'ok' | 'unverified';
export interface PageCallTile {
  deviceId: string;
  userId: string;
  state: TileState;
  speaking: boolean;
  /** Only for an 'ok' tile and never while paused: unverified media is never shown. */
  video: MediaStream | null;
  screen: MediaStream | null;
}
export interface PageCallState {
  phase: 'connecting' | 'connected' | 'reconnecting' | 'ended';
  muted: boolean;
  deafened: boolean;
  camera: boolean;
  sharing: boolean;
  paused: boolean;
  /** 'failed': a microphone exists but could not be published (E_MIC_PUBLISH); the call goes on listen-only. */
  mic: 'ok' | 'denied' | 'missing' | 'failed';
  tiles: PageCallTile[];
  /** The local input level, 0..12. */
  level: number;
  /** An E_ code, or null. */
  error: string | null;
}
export type LeaveReason = 'user' | 'pagehide' | 'switch' | 'blocked' | 'removed';
export interface PageCall {
  readonly state: PageCallState;
  subscribe(fn: () => void): () => void;
  setMuted(on: boolean): void;
  setDeafened(on: boolean): void;
  setCamera(on: boolean): Promise<void>;
  setSharing(on: boolean): Promise<void>;
  /** 0..200 in steps of 10. */
  setVolume(userId: string, volume: number): void;
  /** RV-3: driven by the call slice’s phase 'paused'. */
  setPaused(on: boolean): Promise<void>;
  pushToTalk(down: boolean): void;
  leave(reason: LeaveReason): Promise<void>;
}

/** What the session needs of an RNNoise processor; DillaRnnoiseProcessor by default. */
export interface NoiseProcessor { setPttActive(active: boolean): void }

export interface PageCallDeps {
  bridge: Pick<CoreClient, 'call' | 'onCallKeys'>;
  joinCall: (o: JoinCallOptions) => Promise<CallSession>;
  now(): number;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
  /** getDisplayMedia is needed only for a screen share. */
  media: CaptureMedia & Partial<DisplayMedia>;
  /** Defaults to a DillaRnnoiseProcessor in the given mode. */
  createNoiseProcessor?: (mode: 'vad' | 'ptt') => NoiseProcessor;
  /** Where pagehide is heard; the page’s window by default. */
  win?: Pick<Window, 'addEventListener' | 'removeEventListener'>;
}

export interface PageCallOptions {
  instanceId: string;
  /** Device ids; '' is the system default. */
  input: string;
  output: string;
  mode: 'vad' | 'ptt';
  noise: 'on' | 'off';
  /** user id → 0..200 (the voice.volume.<user> settings). */
  volumes: Volumes;
}

/** A refusal or failure of the session, by code only (copy maps codes, never error text). */
export class PageCallError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.name = 'PageCallError';
    this.code = code;
  }
}

const CODE = /^E_[A-Z0-9_]+/;
export function pageCallError(err: unknown): PageCallError {
  if (err instanceof PageCallError) return err;
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && CODE.test(code)) return new PageCallError(code);
  const fromMessage = err instanceof Error ? CODE.exec(err.message)?.[0] : undefined;
  return new PageCallError(fromMessage ?? 'E_INTERNAL');
}

/** The browser’s own dependencies, for the shell (task 9). */
export function browserDeps(bridge: PageCallDeps['bridge']): PageCallDeps {
  const md = navigator.mediaDevices;
  return {
    bridge,
    joinCall,
    now: () => Date.now(),
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    media: {
      getUserMedia: (c) => md.getUserMedia(c),
      enumerateDevices: () => md.enumerateDevices(),
      getDisplayMedia: (o) => md.getDisplayMedia(o),
    },
  };
}

type PublishOptions = ReturnType<typeof micOptions>;
type Source = NonNullable<PublishOptions['source']>;
const SOURCE = {
  microphone: 'microphone' as Source,
  camera: 'camera' as Source,
  screen: 'screen_share' as Source,
  screenAudio: 'screen_share_audio' as Source,
};
/** livekit TrackSource numbers in ParticipantPermission.canPublishSources. */
const PERMISSION: Record<'camera' | 'screen' | 'screenAudio', number> = { camera: 1, screen: 3, screenAudio: 4 };
const EV = {
  participantConnected: 'participantConnected',
  participantDisconnected: 'participantDisconnected',
  trackSubscribed: 'trackSubscribed',
  trackUnsubscribed: 'trackUnsubscribed',
  activeSpeakers: 'activeSpeakersChanged',
  reconnecting: 'reconnecting',
  reconnected: 'reconnected',
  disconnected: 'disconnected',
  permissions: 'participantPermissionsChanged',
} as const;

/** Tiles are polled for verifiedIdentities() every second. */
export const TILE_POLL_MS = 1_000;
/** ICE credentials are refreshed this long before the expiry their username carries (DEV-53). */
export const ICE_EARLY_MS = 300_000;
const ICE_RETRY_MS = 30_000;
/** How long a share waits for the SFU’s new permission. */
export const SHARE_WAIT_MS = 10_000;

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- livekit’s emitter listener type
type AnyListener = (...args: any[]) => void;
interface Events { on(e: string, f: AnyListener): unknown; off(e: string, f: AnyListener): unknown }
interface RemoteView {
  identity: string;
  isSpeaking: boolean;
  setVolume(volume: number, source?: Source): void;
  getTrackPublication(source: Source): { track?: { mediaStream?: MediaStream } } | undefined;
}
interface LocalPub { track?: { mute(): unknown; unmute(): unknown; setProcessor?(p: unknown): Promise<void> } }
interface Permissions { canPublish?: boolean; canPublishSources?: number[] }

/** The earliest expiry, in ms, among the TURN usernames (`<expiry seconds>:<…>`), or null. */
export function iceExpiryMs(list: IceServerTuple[]): number | null {
  let min: number | null = null;
  for (const [, username] of list) {
    const m = /^(\d{1,12}):/.exec(username);
    if (m) {
      const at = Number(m[1]) * 1000;
      if (min === null || at < min) min = at;
    }
  }
  return min;
}

export async function startPageCall(deps: PageCallDeps, target: { channelId: string; vdec: string }, opts: PageCallOptions): Promise<PageCall> {
  // The microphone prompt comes before the join, so the room never shows this device while the prompt is open.
  const mic = await acquireMic(deps.media, opts.input);
  let roster = new Map<string, { userId: string; leaf: number }>();
  let selfLeaf = -1;
  let afterRoster: () => void = () => undefined;
  let installError: (code: string) => void = () => undefined;
  const relay = createKeyRelay({
    onRoster: (m, leaf) => { roster = new Map(m); selfLeaf = leaf; afterRoster(); },
    onInstallError: (code) => installError(code),
  });
  // Subscribed before callJoin is sent: the join key is pushed just before callJoin’s answer.
  const unsubscribe = deps.bridge.onCallKeys(relay.listener);
  // pagehide is heard from here on (review m1). During startup it ends the attempt at once: no install afterwards,
  // callLeave('pagehide') posted, media released without waiting; once the call is up it becomes leave('pagehide').
  const win = deps.win ?? (typeof window === 'undefined' ? undefined : window);
  let aborted = false;
  let joinedSession: CallSession | null = null;
  const stopMic = (): void => { if ('track' in mic) mic.track.stop(); };
  const startupHide = (): void => {
    if (aborted) return;
    aborted = true;
    relay.close();
    unsubscribe();
    win?.removeEventListener('pagehide', pageHide);
    void deps.bridge.call({ m: 'callLeave', reason: 'pagehide' }).catch(() => undefined);
    const live = joinedSession;
    if (live !== null) {
      try { live.manager.dispose(); } catch { /* released below */ }
      void Promise.resolve(live.room.disconnect()).catch(() => undefined);
      void live.release().catch(() => undefined);
    }
    stopMic();
  };
  let onPageHide: () => void = startupHide;
  const pageHide = (): void => onPageHide();
  win?.addEventListener('pagehide', pageHide);
  /** Ends a failed start. After a pagehide everything is already torn down and the attempt ends E_ABORTED. */
  const abandon = async (err: unknown, posted: boolean): Promise<PageCallError> => {
    if (aborted) return new PageCallError('E_ABORTED');
    aborted = true;
    relay.close();
    unsubscribe();
    win?.removeEventListener('pagehide', pageHide);
    stopMic();
    const live = joinedSession;
    // Keys stop first: media is released before the worker is told to leave.
    if (live !== null) await live.release().catch(() => undefined);
    if (posted) await deps.bridge.call({ m: 'callLeave', reason: 'user' }).catch(() => undefined);
    return pageCallError(err);
  };
  const checkAborted = (): void => { if (aborted) throw new PageCallError('E_ABORTED'); };

  let join: CallJoinResult;
  try {
    join = (await deps.bridge.call({ m: 'callJoin', channelId: target.channelId, vdec: target.vdec })) as CallJoinResult;
  } catch (err) {
    throw await abandon(err, false);
  }
  if (aborted) throw new PageCallError('E_ABORTED');
  let joinEpoch: bigint;
  let caps: CallCaps;
  try {
    joinEpoch = BigInt(join.epoch);
    caps = decodeCaps(join.caps);
  } catch (err) {
    throw await abandon(err instanceof SyntaxError ? new PageCallError('E_NO_EPOCH') : err, true);
  }
  const joinKey = relay.takeJoin(join.callId, joinEpoch);
  if (joinKey === null) throw await abandon(new PageCallError('E_NO_EPOCH'), true);

  let session: CallSession | null = null;
  let joinError: unknown = null;
  try {
    session = await deps.joinCall({
      livekitUrl: join.livekitUrl,
      token: join.token,
      iceServers: join.iceServers,
      epoch: toEpochKeys(joinKey, joinEpoch),
      lock: { instanceId: opts.instanceId, callGroupId: join.groupId },
      roomOptions: {
        webAudioMix: true,
        publishDefaults: publishDefaults(caps),
        ...(opts.output !== '' ? { audioOutput: { deviceId: opts.output } } : {}),
      },
    });
  } catch (err) {
    joinError = err;
  } finally {
    joinKey.baseKey.fill(0);
  }
  if (session === null) throw await abandon(joinError ?? new PageCallError('E_INTERNAL'), true);
  joinedSession = session;
  if (aborted) {
    // pagehide arrived while joinCall ran: what startupHide could not reach is released now.
    try { session.manager.dispose(); } catch { /* released below */ }
    void Promise.resolve(session.room.disconnect()).catch(() => undefined);
    await session.release().catch(() => undefined);
    throw new PageCallError('E_ABORTED');
  }
  // Only the call id outlives the start; the token and TURN credentials stay with joinCall (review m5).
  const callIdHex = join.callId;
  const firstIce = join.iceServers;

  const joined = session;
  const { room, manager } = joined;
  const release = (): Promise<void> => joined.release();
  try {
    relay.attach(manager);
    const events = room as unknown as Events;
    const local = room.localParticipant as unknown as Events & {
      identity: string; audioLevel?: number; permissions?: Permissions;
      publishTrack(track: MediaStreamTrack, o: PublishOptions): Promise<LocalPub>;
      unpublishTrack(track: MediaStreamTrack): Promise<unknown>;
    };
    const remotes = (): RemoteView[] => [...(room.remoteParticipants.values() as Iterable<unknown>)] as RemoteView[];

    let state: PageCallState = {
      phase: 'connecting', muted: false, deafened: false, camera: false, sharing: false, paused: false,
      mic: 'ok', tiles: [], level: 0, error: null,
    };
    const listeners = new Set<{ fn: () => void }>();
    const set = (patch: Partial<PageCallState>): void => {
      state = { ...state, ...patch };
      for (const l of [...listeners]) {
        try { l.fn(); } catch (err) { queueMicrotask(() => { throw err; }); }
      }
    };
    let ended = false;
    const volumes: Volumes = { ...opts.volumes };
    let mutedBeforeDeafen = false;
    let verified = new Set<string>();
    const timers = new Set<unknown>();
    const later = (fn: () => void, ms: number): unknown => {
      const h = deps.setTimer(() => { timers.delete(h); fn(); }, ms);
      timers.add(h);
      return h;
    };
    const cancel = (h: unknown): void => { if (timers.delete(h)) deps.clearTimer(h); };
    installError = (code) => { if (!ended) set({ error: code }); };

    // ---- tiles and remote audio
    const streamOf = (p: RemoteView, source: Source): MediaStream | null => p.getTrackPublication(source)?.track?.mediaStream ?? null;
    const tiles = (): PageCallTile[] => {
      const out: PageCallTile[] = [];
      const inRoom = new Set<string>();
      for (const p of remotes()) {
        inRoom.add(p.identity);
        const r = roster.get(p.identity);
        const tileState: TileState = r === undefined ? 'unverified' : verified.has(p.identity) ? 'ok' : 'not-heard';
        const show = tileState === 'ok' && !state.paused;
        out.push({ deviceId: p.identity, userId: r?.userId ?? '', state: tileState, speaking: p.isSpeaking === true,
          video: show ? streamOf(p, SOURCE.camera) : null, screen: show ? streamOf(p, SOURCE.screen) : null });
      }
      for (const [deviceId, r] of roster) {
        if (r.leaf === selfLeaf || deviceId === local.identity || inRoom.has(deviceId)) continue;
        out.push({ deviceId, userId: r.userId, state: 'connecting', speaking: false, video: null, screen: null });
      }
      return out;
    };
    const level = (): number => (state.muted || state.paused ? 0 : Math.max(0, Math.min(12, Math.round((local.audioLevel ?? 0) * 12))));
    const refresh = (): void => { if (!ended) set({ tiles: tiles(), level: level() }); };
    const applyGains = (): void => {
      for (const p of remotes()) {
        const g = gainOf(roster.get(p.identity)?.userId ?? '', volumes, { deafened: state.deafened, paused: state.paused });
        p.setVolume(g, SOURCE.microphone);
        p.setVolume(g, SOURCE.screenAudio);
      }
    };
    afterRoster = () => { if (!ended) { applyGains(); refresh(); } };

    // ---- the microphone
    const gate = new VoiceGate({ mode: opts.mode === 'ptt' ? 'ptt' : 'open' });
    let micPub: LocalPub | null = null;
    let micTrack: MediaStreamTrack | null = null;
    let processor: NoiseProcessor | null = null;
    let micSending: boolean | null = null;
    const applyMic = (): void => {
      const track = micPub?.track;
      if (!track) return;
      // With RNNoise, its worklet gates push to talk; without it, the track itself is muted while the key is up.
      const pttOpen = opts.mode !== 'ptt' || processor !== null || gate.update(0, deps.now());
      const send = !ended && !state.muted && !state.deafened && !state.paused && pttOpen;
      if (send === micSending) return;
      micSending = send;
      void Promise.resolve(send ? track.unmute() : track.mute()).catch(() => undefined);
    };
    if ('track' in mic) {
      micTrack = mic.track;
      try {
        micPub = await local.publishTrack(mic.track, micOptions(caps));
      } catch {
        mic.track.stop();
        micTrack = null;
        state = { ...state, mic: 'failed', error: 'E_MIC_PUBLISH' };
      }
      checkAborted();
      if (micPub?.track?.setProcessor && opts.noise === 'on') {
        const made = (deps.createNoiseProcessor ?? ((mode) => new DillaRnnoiseProcessor({ mode })))(opts.mode);
        try {
          await micPub.track.setProcessor(made);
          processor = made;
        } catch {
          processor = null; // the microphone goes on without noise suppression
        }
        checkAborted();
      }
    } else {
      state = { ...state, mic: mic.mic };
    }
    applyMic();

    // ---- sharing: callShare on, then the SFU’s permission, then the publish; callShare off once nothing is shared
    let shareOn = false;
    let camera: { track: MediaStreamTrack } | null = null;
    let screen: { video: MediaStreamTrack; audio: MediaStreamTrack | null; onEnded: () => void } | null = null;
    const permitted = (what: keyof typeof PERMISSION): boolean => {
      const p = local.permissions;
      if (!p || p.canPublish === false) return false;
      const list = p.canPublishSources ?? [];
      return list.length === 0 || list.includes(PERMISSION[what]);
    };
    const ensureShare = async (what: 'camera' | 'screen'): Promise<void> => {
      if (shareOn && permitted(what)) return;
      let settle: (ok: boolean) => void = () => undefined;
      const granted = new Promise<boolean>((resolve) => { settle = resolve; });
      const onPermissions = (_prev: unknown, participant: unknown): void => {
        if (participant === room.localParticipant && permitted(what)) settle(true);
      };
      events.on(EV.permissions, onPermissions);
      const timer = later(() => settle(false), SHARE_WAIT_MS);
      try {
        shareOn = true;
        await deps.bridge.call({ m: 'callShare', on: true });
        if (permitted(what)) settle(true);
        if (!(await granted)) throw new PageCallError('E_UNAVAILABLE');
      } catch (err) {
        await shareOffIfIdle();
        throw pageCallError(err);
      } finally {
        events.off(EV.permissions, onPermissions);
        cancel(timer);
      }
    };
    const shareOffIfIdle = async (): Promise<void> => {
      if (camera !== null || screen !== null || !shareOn) return;
      shareOn = false;
      await deps.bridge.call({ m: 'callShare', on: false }).catch(() => undefined);
    };
    const stopCamera = async (): Promise<void> => {
      const c = camera;
      if (c === null) return;
      camera = null;
      set({ camera: false });
      await local.unpublishTrack(c.track).catch(() => undefined);
      c.track.stop();
    };
    const stopScreen = async (): Promise<void> => {
      const s = screen;
      if (s === null) return;
      screen = null;
      set({ sharing: false });
      s.video.removeEventListener('ended', s.onEnded);
      await local.unpublishTrack(s.video).catch(() => undefined);
      if (s.audio) await local.unpublishTrack(s.audio).catch(() => undefined);
      s.video.stop();
      s.audio?.stop();
    };
    /** Camera and screen changes run one at a time. */
    let lane: Promise<unknown> = Promise.resolve();
    const inLane = <T>(fn: () => Promise<T>): Promise<T> => {
      const run = lane.then(fn, fn);
      lane = run.catch(() => undefined);
      return run;
    };
    const usable = (): void => { if (ended || state.paused) throw new PageCallError('E_UNAVAILABLE'); };

    const setCamera = (on: boolean): Promise<void> => inLane(async () => {
      if (!on) { await stopCamera(); await shareOffIfIdle(); return; }
      usable();
      if (camera !== null) return;
      await ensureShare('camera');
      let track: MediaStreamTrack;
      try {
        usable();
        track = await acquireCamera(deps.media);
      } catch (err) {
        await shareOffIfIdle();
        throw pageCallError(err);
      }
      try {
        usable();
        await local.publishTrack(track, { source: SOURCE.camera, videoCodec: chooseVideoCodec(room, caps) });
      } catch (err) {
        track.stop();
        await shareOffIfIdle();
        throw pageCallError(err);
      }
      camera = { track };
      set({ camera: true });
    });

    const setSharing = (on: boolean): Promise<void> => inLane(async () => {
      if (!on) { await stopScreen(); await shareOffIfIdle(); return; }
      usable();
      if (screen !== null) return;
      const getDisplayMedia = deps.media.getDisplayMedia?.bind(deps.media);
      if (!getDisplayMedia) throw new PageCallError('E_UNAVAILABLE');
      await ensureShare('screen');
      let tracks: { video: MediaStreamTrack; audio: MediaStreamTrack | null };
      try {
        usable();
        tracks = await acquireScreen({ getDisplayMedia });
      } catch (err) {
        await shareOffIfIdle();
        throw pageCallError(err);
      }
      try {
        usable();
        await local.publishTrack(tracks.video, { source: SOURCE.screen });
        if (tracks.audio !== null && permitted('screenAudio')) await local.publishTrack(tracks.audio, screenAudioOptions(caps));
        else tracks.audio?.stop();
      } catch (err) {
        await local.unpublishTrack(tracks.video).catch(() => undefined);
        tracks.video.stop();
        tracks.audio?.stop();
        await shareOffIfIdle();
        throw pageCallError(err);
      }
      // The browser’s own "stop sharing" ends the video track.
      const onEnded = (): void => { void setSharing(false).catch(() => undefined); };
      tracks.video.addEventListener('ended', onEnded);
      screen = { ...tracks, onEnded };
      set({ sharing: true });
    });

    // ---- self flags, sent only after callJoin (the PageCall exists only once it answered)
    const sendSelf = (): void => {
      const flags = (state.muted ? 1 : 0) | (state.deafened ? 2 : 0);
      void deps.bridge.call({ m: 'voiceSelf', callId: callIdHex, flags }).catch(() => undefined);
    };

    // ---- timers: tiles, stats, ICE
    const poll = (): void => {
      if (ended) return;
      void manager.verifiedIdentities().then((v) => { verified = v; }, () => undefined).finally(() => {
        if (ended) return;
        refresh();
        later(poll, TILE_POLL_MS);
      });
    };
    let totals: MediaTotals = { sent: 0, failed: 0 };
    const reportStats = async (): Promise<void> => {
      const publisher = (room.engine as unknown as { pcManager?: { publisher?: { getStats?: () => Promise<RTCStatsReport> | undefined } } } | undefined)?.pcManager?.publisher;
      const [rtc, media] = await Promise.all([
        Promise.resolve(publisher?.getStats?.()).catch(() => undefined),
        manager.stats().catch(() => null),
      ]);
      if (ended || state.phase !== 'connected') return;
      const next = callStatsReport(connectionOf(rtc), mediaTotals(media), totals);
      totals = next.totals;
      await deps.bridge.call({ m: 'callStats', report: next.report });
    };
    const statsTick = (): void => {
      if (ended) return;
      if (state.phase === 'connected') void reportStats().catch(() => undefined); // a 429 or a 404 is not the person’s problem
      later(statsTick, STATS_EVERY_MS);
    };
    const scheduleIce = (list: IceServerTuple[], retry = false): void => {
      if (ended) return;
      const expiry = iceExpiryMs(list);
      if (expiry === null && !retry) return;
      const delay = retry || expiry === null ? ICE_RETRY_MS : Math.max(ICE_RETRY_MS, expiry - ICE_EARLY_MS - deps.now());
      later(() => { void refreshIce(list); }, delay);
    };
    const refreshIce = async (current: IceServerTuple[]): Promise<void> => {
      try {
        const answer = (await deps.bridge.call({ m: 'callRefresh' })) as { token: string; iceServers: IceServerTuple[] };
        if (ended) return;
        refreshIceServers(room, answer.iceServers);
        scheduleIce(answer.iceServers);
      } catch {
        scheduleIce(current, true);
      }
    };

    // ---- room events
    const onPeople = (): void => { applyGains(); refresh(); };
    const onSpeakers = (): void => refresh();
    const onReconnecting = (): void => { if (!ended) set({ phase: 'reconnecting' }); };
    const onReconnected = (): void => { if (!ended) set({ phase: 'connected' }); };
    const onDisconnected = (): void => { if (!ended) void leave('removed'); };
    const roomListeners: Array<[string, AnyListener]> = [
      [EV.participantConnected, onPeople], [EV.participantDisconnected, onPeople], [EV.trackSubscribed, onPeople],
      [EV.trackUnsubscribed, onPeople], [EV.activeSpeakers, onSpeakers], [EV.reconnecting, onReconnecting],
      [EV.reconnected, onReconnected], [EV.disconnected, onDisconnected],
    ];
    for (const [e, f] of roomListeners) events.on(e, f);
    const policy = new SpeakerPolicy(room);
    onPageHide = () => { void leave('pagehide'); };

    // ---- leave
    let leaving: Promise<void> | null = null;
    const stopEverything = (): void => {
      ended = true;
      relay.close();
      unsubscribe();
      for (const h of [...timers]) cancel(h);
      for (const [e, f] of roomListeners) events.off(e, f);
      win?.removeEventListener('pagehide', pageHide);
      try { policy.dispose(); } catch { /* the room is going away */ }
    };
    const stopCaptures = (): void => {
      micTrack?.stop();
      camera?.track.stop();
      screen?.video.stop();
      screen?.audio?.stop();
      camera = null;
      screen = null;
    };
    const leave = (reason: LeaveReason): Promise<void> => {
      if (leaving !== null) return leaving;
      stopEverything();
      const post = (r: 'user' | 'pagehide' | 'switch') => deps.bridge.call({ m: 'callLeave', reason: r }).then(() => undefined, () => undefined);
      const releaseAll = () => release().catch(() => undefined).finally(stopCaptures);
      if (reason === 'pagehide') {
        // The page is going away: nothing here may wait. callLeave is posted, then media stops in this same task.
        void post('pagehide');
        try { manager.dispose(); } catch { /* released below */ }
        void Promise.resolve(room.disconnect()).catch(() => undefined);
        leaving = releaseAll();
      } else if (reason === 'blocked' || reason === 'removed') {
        // Keys must stop before anything else: media first, then the worker’s leave.
        leaving = releaseAll().then(() => post('user'));
      } else {
        const posted = post(reason);
        leaving = releaseAll().then(() => posted);
      }
      set({ phase: 'ended', camera: false, sharing: false, tiles: [], level: 0 });
      return leaving;
    };

    // ---- connected
    applyGains();
    state = { ...state, phase: 'connected', tiles: tiles() };
    later(poll, TILE_POLL_MS);
    later(statsTick, STATS_EVERY_MS);
    scheduleIce(firstIce);

    return {
      get state() { return state; },
      subscribe(fn) {
        const entry = { fn };
        listeners.add(entry);
        return () => { listeners.delete(entry); };
      },
      setMuted(on) {
        if (ended) return;
        const patch: Partial<PageCallState> = { muted: on };
        if (!on && state.deafened) patch.deafened = false;
        set(patch);
        applyMic();
        applyGains();
        sendSelf();
      },
      setDeafened(on) {
        if (ended || on === state.deafened) return;
        if (on) {
          mutedBeforeDeafen = state.muted;
          set({ deafened: true, muted: true });
        } else {
          set({ deafened: false, muted: mutedBeforeDeafen });
        }
        applyMic();
        applyGains();
        sendSelf();
      },
      setCamera,
      setSharing,
      setVolume(userId, volume) {
        if (!isVolume(volume)) throw new PageCallError('E_INVALID_REQUEST');
        volumes[userId] = volume;
        if (!ended) applyGains();
      },
      async setPaused(on) {
        if (ended || on === state.paused) return;
        relay.setPaused(on);
        set({ paused: on });
        applyMic();
        applyGains();
        refresh();
        if (on) {
          // RV-3: nothing is sent while paused; camera and screen stay off after the pause until turned on again.
          await inLane(async () => {
            await stopCamera();
            await stopScreen();
            await shareOffIfIdle();
          });
        }
      },
      pushToTalk(down) {
        if (ended || opts.mode !== 'ptt') return;
        gate.setPtt(down);
        processor?.setPttActive(down);
        applyMic();
      },
      leave,
    };
  } catch (err) {
    // Anything that fails after joinCall resolved tears the call down: no install, media released, then callLeave.
    throw await abandon(err, true);
  }
}
