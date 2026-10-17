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
import {
  analyserMeter, LEVEL_PUBLISH_MS, SPEAK_TICK_MS, SpeakingDetector, type LevelMeter,
} from './speaking.ts';
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
  /** The input mode in force (task-9 review I2: it follows Settings → Voice during a call). */
  mode: 'vad' | 'ptt';
  tiles: PageCallTile[];
  /** The local input level, 0..12. */
  level: number;
  /** Product walk M4: the SFU hears this device speaking (its own isSpeaking), never while muted or paused. */
  speaking: boolean;
  /** Product walk I3: what this device sends, for its own tile's self-view: the camera and the screen as local views
   *  (never a received stream), null while not sent. */
  localCamera: MediaStream | null;
  localScreen: MediaStream | null;
  /** Product walk M1: noise suppression in force; it follows Settings → Voice during the call. */
  noise: 'on' | 'off';
  /** web3.3: the browser holds call audio back (livekit’s canPlaybackAudio is false) until startAudio() is pressed. */
  audioBlocked: boolean;
  /** web3.4 V2: the remote audio tracks this device is subscribed to (expected: pending and attached) and those
   *  attached, so playing (attached stays the same while deafened or paused holds a new track back). */
  audio: { attached: number; expected: number };
  /**
   * An E_ code, or null. Once the phase is 'ended' because the room ended on its own (WB client I3): E_CALL_ENDED (the
   * room was closed: the call ended for everyone), E_REMOVED (the instance removed this device from the room) or
   * E_DISCONNECTED (the connection ended and LiveKit's reconnect gave up).
   */
  error: string | null;
}
/** 'lost' (WB client I3): the room ended on its own; media stops first and the worker hears callLeave 'lost'. */
export type LeaveReason = 'user' | 'pagehide' | 'switch' | 'blocked' | 'removed' | 'lost';
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
  /** WB security I1: the hold after a refused rekey (phase paused, not a changed identity): every media key goes at
   *  once, so nothing more is sent under the epoch the page held; the next epoch’s key installs on resume. */
  dropKeys(upTo?: bigint): void;
  pushToTalk(down: boolean): void;
  /** Switches the input mode during the call: push to talk closes the microphone at once, until the key is held. */
  setMode(mode: 'vad' | 'ptt'): void;
  /** Product walk M1: switches noise suppression during the call (the microphone's processor is set or stopped). */
  setNoise(noise: 'on' | 'off'): Promise<void>;
  /** web3.3: the "turn on audio" press: room.startAudio(), then canPlaybackAudio read again; a refusal never throws. */
  startAudio(): Promise<void>;
  /** web3.4 V1: moves the call's sound to output device `id` ('' is the system default) during the call. A no-op where
   *  the browser cannot choose an output, and after the leave; rejects when the browser refuses the device. */
  setOutput(id: string): Promise<void>;
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
  /** The key relay’s copy step (tests observe that every copy is zero-filled); a plain copy by default. */
  copyKey?: (buffer: ArrayBuffer) => Uint8Array;
  /** Where pagehide is heard; the page’s window by default. */
  win?: Pick<Window, 'addEventListener' | 'removeEventListener'>;
  /** Product walk I3: a local view of one sent track for the self-view; `new MediaStream([track])` by default (null where
   *  the browser has no MediaStream). */
  viewOf?: (track: MediaStreamTrack) => MediaStream | null;
  /** web3.3: the container remote audio elements are attached into; one hidden `<div data-dilla-call-audio>` on
   *  document.body by default (null where there is no document). */
  audioHost?: () => HTMLElement | null;
  /** Fix round 1 (I1, M2): the fallback maker of the call’s AudioContext, the mixer remote audio plays through
   *  (webAudioMix), used only when PageCallOptions.audioContext is absent; a new AudioContext by default (null where the
   *  browser has none). The session closes the context on every leave. */
  audioContext?: () => AudioContext | null;
  /** web3.8 V1: a level reader on one audio track in the call's context (an AnalyserNode, never connected to the
   *  destination); analyserMeter by default. Null means no local level: the SFU's speaker flag is the fallback. */
  createLevelMeter?(ctx: AudioContext, track: MediaStreamTrack): LevelMeter | null;
}

function defaultAudioContext(): AudioContext | null {
  if (typeof AudioContext === 'undefined') return null;
  try { return new AudioContext(); } catch { return null; }
}

/** The default audio host: one hidden, aria-hidden container on document.body, made on first use. */
function defaultAudioHost(): HTMLElement | null {
  if (typeof document === 'undefined' || document.body === null) return null;
  let host = document.querySelector<HTMLElement>('div[data-dilla-call-audio]');
  if (host === null) {
    host = document.createElement('div');
    host.setAttribute('data-dilla-call-audio', '');
    host.hidden = true;
    host.setAttribute('aria-hidden', 'true');
    document.body.appendChild(host);
  }
  return host;
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
  /** WB client I1: aborting ends a start that has not connected yet, the microphone prompt included: callLeave is
   *  posted at once (the worker cancels its join), the microphone is stopped, and the start rejects with E_ABORTED. */
  signal?: AbortSignal;
  /** Product walk M5: this browser's own mute or deafen kept from its last call; the call starts in it, so a reload never
   *  reopens a microphone the person had muted. */
  self?: 'muted' | 'deafened' | null;
  /** Fix round 2 (Minor 1): the call’s AudioContext, made by the shell synchronously inside the person’s press (useCall’s
   *  join, before its first await), so the browser lets it run. From here on the session owns it and closes it on every
   *  way out. Absent: the session makes its own (PageCallDeps.audioContext), a fallback that may start suspended. */
  audioContext?: AudioContext | null;
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
  audioPlayback: 'audioPlaybackChanged',
} as const;

/** livekit DisconnectReason values the session reads (livekit protocol): PARTICIPANT_REMOVED, ROOM_DELETED, ROOM_CLOSED. */
const DISCONNECT = { participantRemoved: 4, roomDeleted: 5, roomClosed: 10 } as const;
/** Why a room ended on its own, as the session's error code (WB client I3). */
export function endCodeOf(reason: unknown): 'E_CALL_ENDED' | 'E_REMOVED' | 'E_DISCONNECTED' {
  if (reason === DISCONNECT.roomDeleted || reason === DISCONNECT.roomClosed) return 'E_CALL_ENDED';
  if (reason === DISCONNECT.participantRemoved) return 'E_REMOVED';
  return 'E_DISCONNECTED';
}

/** `p`, or E_ABORTED once `signal` aborts first; `onLate` gets the value of a `p` that settles after the abort. */
function abortable<T>(p: Promise<T>, signal: AbortSignal | undefined, onLate: (v: T) => void): Promise<T> {
  if (signal === undefined) return p;
  if (signal.aborted) { void p.then(onLate, () => undefined); return Promise.reject(new PageCallError('E_ABORTED')); }
  return new Promise<T>((resolve, reject) => {
    let done = false;
    const onAbort = (): void => { if (done) return; done = true; reject(new PageCallError('E_ABORTED')); };
    signal.addEventListener('abort', onAbort, { once: true });
    p.then((v) => {
      signal.removeEventListener('abort', onAbort);
      if (done) { onLate(v); return; }
      done = true;
      resolve(v);
    }, (e: unknown) => {
      signal.removeEventListener('abort', onAbort);
      if (done) return;
      done = true;
      reject(e instanceof Error ? e : new PageCallError('E_INTERNAL'));
    });
  });
}

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
  trackPublications?: Map<string, { track?: unknown }>;
}
/** What the session needs of a subscribed remote track to play it (livekit’s RemoteAudioTrack). */
interface RemoteAudio {
  kind: string; attach(): HTMLMediaElement; detach(element: HTMLMediaElement): unknown;
  /** The decrypted track the element plays (livekit’s); web3.8 V1 reads its level when the element has no stream. */
  mediaStreamTrack?: MediaStreamTrack;
}
interface LocalPub { track?: { mute(): unknown; unmute(): unknown; setProcessor?(p: unknown): Promise<void>; stopProcessor?(): Promise<void> } }
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
  // The microphone prompt comes before the join, so the room never shows this device while the prompt is open. An abort
  // while it is open ends the start at once (WB client I1); a microphone granted after that is stopped.
  // Fix round 1 (I1, M2): the call’s own AudioContext. The shell makes it inside the person’s press (useCall’s join, before
  // its first await; fix round 2, Minor 1) and passes it in; only without one is it made here, after the shell’s awaits,
  // where Safari may start it suspended (audioBlocked then offers the press). livekit mixes remote audio into it
  // (webAudioMix) and never closes a context it did not make, so every way out of this call closes it here. The output
  // device is set on it: with webAudioMix the elements stay muted and everything plays through the context’s destination.
  const ctx = opts.audioContext !== undefined ? opts.audioContext : (deps.audioContext ?? defaultAudioContext)();
  let ctxClosed = false;
  // web3.8 V1: every level meter registers its close here, so every way out that closes the context closes them first.
  const meterClosers = new Set<() => void>();
  /** Makes a meter on `track` in the call's context, or null (no context, a refusal, a closed context): the SFU's flag
   *  is then the fallback. Never throws. The returned meter's close is idempotent and unregisters itself. */
  const makeMeter = (track: MediaStreamTrack | null | undefined): LevelMeter | null => {
    if (ctx === null || ctxClosed || track == null) return null;
    let made: LevelMeter | null;
    try { made = (deps.createLevelMeter ?? analyserMeter)(ctx, track); } catch { return null; }
    if (made === null) return null;
    const inner = made;
    let closed = false;
    const close = (): void => {
      if (closed) return;
      closed = true;
      meterClosers.delete(close);
      try { inner.close(); } catch { /* the node is gone with the context */ }
    };
    meterClosers.add(close);
    return { read: () => inner.read(), close };
  };
  const closeCtx = (): void => {
    if (ctx === null || ctxClosed) return;
    for (const close of [...meterClosers]) close();
    ctxClosed = true;
    try { void Promise.resolve(ctx.close()).catch(() => undefined); } catch { /* already closed */ }
  };
  /** Sends the call's sound to output device `id` ('' is the system default). Null where the context cannot choose an
   *  output (Firefox): the system default plays. web3.4 V1: also the mid-call switch (setOutput). */
  const setSink = ctx !== null && typeof (ctx as { setSinkId?: unknown }).setSinkId === 'function'
    ? async (id: string): Promise<void> => { await (ctx as unknown as { setSinkId(id: string): Promise<void> }).setSinkId(id); }
    : null;
  // A refused device at the start leaves the system default playing.
  if (setSink !== null && opts.output !== '') void setSink(opts.output).catch(() => undefined);
  let mic: Awaited<ReturnType<typeof acquireMic>>;
  try {
    mic = await abortable(acquireMic(deps.media, opts.input), opts.signal, (late) => { if ('track' in late) late.track.stop(); });
  } catch (err) {
    closeCtx();
    throw err;
  }
  if (opts.signal?.aborted === true) {
    if ('track' in mic) mic.track.stop();
    closeCtx();
    throw new PageCallError('E_ABORTED');
  }
  let roster = new Map<string, { userId: string; leaf: number }>();
  let selfLeaf = -1;
  let afterRoster: () => void = () => undefined;
  let installError: (code: string) => void = () => undefined;
  const relay = createKeyRelay({
    onRoster: (m, leaf) => { roster = new Map(m); selfLeaf = leaf; afterRoster(); },
    onInstallError: (code) => installError(code),
    ...(deps.copyKey !== undefined ? { copy: deps.copyKey } : {}),
  });
  // Subscribed before callJoin is sent: the join key is pushed just before callJoin’s answer.
  const unsubscribe = deps.bridge.onCallKeys(relay.listener);
  // pagehide is heard from here on (review m1). During startup it ends the attempt at once: no install afterwards,
  // callLeave('pagehide') posted, media released without waiting; once the call is up it becomes leave('pagehide').
  const win = deps.win ?? (typeof window === 'undefined' ? undefined : window);
  let aborted = false;
  let joinedSession: CallSession | null = null;
  const stopMic = (): void => { if ('track' in mic) mic.track.stop(); };
  /** A pagehide, or the page's abort (WB client I1), during startup: everything stops now, nothing waits. */
  const startupHide = (reason: 'pagehide' | 'user' = 'pagehide'): void => {
    if (aborted) return;
    aborted = true;
    relay.close();
    unsubscribe();
    win?.removeEventListener('pagehide', pageHide);
    opts.signal?.removeEventListener('abort', onAbort);
    void deps.bridge.call({ m: 'callLeave', reason }).catch(() => undefined);
    const live = joinedSession;
    if (live !== null) {
      try { live.manager.dispose(); } catch { /* released below */ }
      void Promise.resolve(live.room.disconnect()).catch(() => undefined);
      void live.release().catch(() => undefined);
    }
    stopMic();
    closeCtx();
  };
  let onPageHide: () => void = () => startupHide('pagehide');
  const pageHide = (): void => onPageHide();
  win?.addEventListener('pagehide', pageHide);
  // Until the call is up, the page's abort ends the start as a pagehide does, as the person's own leave.
  const onAbort = (): void => startupHide('user');
  opts.signal?.addEventListener('abort', onAbort, { once: true });
  /** Ends a failed start. After a pagehide everything is already torn down and the attempt ends E_ABORTED. */
  const abandon = async (err: unknown, posted: boolean): Promise<PageCallError> => {
    if (aborted) return new PageCallError('E_ABORTED');
    aborted = true;
    relay.close();
    unsubscribe();
    win?.removeEventListener('pagehide', pageHide);
    opts.signal?.removeEventListener('abort', onAbort);
    stopMic();
    const live = joinedSession;
    // Review M3: a failure after the room listeners were registered unregisters them and lets every attached track go.
    teardownRoom();
    detachEarly();
    closeCtx();
    // Keys stop first: media is released before the worker is told to leave.
    if (live !== null) await live.release().catch(() => undefined);
    if (posted) await deps.bridge.call({ m: 'callLeave', reason: 'user' }).catch(() => undefined);
    return pageCallError(err);
  };
  /** WB client m2: the room's own end, heard from the moment joinCall resolved; until the call is up it ends the start. */
  let endedBy: string | null = null;
  let detachEarly: () => void = () => undefined;
  let teardownRoom: () => void = () => undefined;
  const checkAborted = (): void => {
    if (aborted) throw new PageCallError('E_ABORTED');
    if (endedBy !== null) throw new PageCallError(endedBy);
  };

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
        webAudioMix: ctx !== null ? { audioContext: ctx } : true,
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
  // WB client m2: the room's end and its reconnects are heard from here on, not only once the microphone is published.
  let onRoomEnd: (reason: unknown) => void = (reason) => { endedBy ??= endCodeOf(reason); };
  let onRoomReconnecting: () => void = () => undefined;
  let onRoomReconnected: () => void = () => undefined;
  {
    const early = session.room as unknown as Events;
    const listeners: Array<[string, AnyListener]> = [
      [EV.disconnected, (reason: unknown) => onRoomEnd(reason)], [EV.reconnecting, () => onRoomReconnecting()],
      [EV.reconnected, () => onRoomReconnected()],
    ];
    for (const [e, f] of listeners) early.on(e, f);
    detachEarly = () => { for (const [e, f] of listeners) early.off(e, f); };
  }
  if (aborted) {
    // pagehide arrived while joinCall ran: what startupHide could not reach is released now.
    try { session.manager.dispose(); } catch { /* released below */ }
    void Promise.resolve(session.room.disconnect()).catch(() => undefined);
    await session.release().catch(() => undefined);
    closeCtx();
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
      identity: string; audioLevel?: number; isSpeaking?: boolean; permissions?: Permissions;
      publishTrack(track: MediaStreamTrack, o: PublishOptions): Promise<LocalPub>;
      unpublishTrack(track: MediaStreamTrack): Promise<unknown>;
    };
    const remotes = (): RemoteView[] => [...(room.remoteParticipants.values() as Iterable<unknown>)] as RemoteView[];

    let state: PageCallState = {
      phase: 'connecting', camera: false, sharing: false, paused: false,
      mic: 'ok', tiles: [], level: 0, error: null, mode: opts.mode, speaking: false, localCamera: null, localScreen: null,
      noise: opts.noise, muted: opts.self === 'muted' || opts.self === 'deafened', deafened: opts.self === 'deafened',
      audioBlocked: false, audio: { attached: 0, expected: 0 },
    };
    const viewOf = deps.viewOf ?? ((track: MediaStreamTrack) => (typeof MediaStream === 'undefined' ? null : new MediaStream([track])));
    const listeners = new Set<{ fn: () => void }>();
    const set = (patch: Partial<PageCallState>): void => {
      state = { ...state, ...patch };
      for (const l of [...listeners]) {
        try { l.fn(); } catch (err) { queueMicrotask(() => { throw err; }); }
      }
    };
    let ended = false;
    const volumes: Volumes = { ...opts.volumes };
    // Fix round 3 (m1): a call started deafened (voice.self) was muted before it, as far as anyone knows: an undeafen keeps
    // the microphone muted (privacy-safe), never opens it after a reload.
    let mutedBeforeDeafen = opts.self === 'deafened';
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
    // web3.8 V1: speaking from local levels. A meter's reading is trusted only while the context runs (a suspended one
    // reads silence); otherwise, and for every track without a meter, the SFU's flag is the fallback.
    const levelsLive = (): boolean => ctx !== null && ctx.state === 'running';
    let ownMeter: LevelMeter | null = null;
    const ownDetector = new SpeakingDetector();
    let ownOn = false;
    let ownRms = 0;
    /** The remote person's speaking from their attached tracks' meters, or null when none has a live meter and a gain. */
    const remoteLocal = (identity: string): boolean | null => {
      if (!levelsLive() || gainFor(identity) <= 0) return null;
      let any: boolean | null = null;
      for (const entry of playing.values()) {
        if (entry.identity !== identity || entry.meter === null) continue;
        any = (any ?? false) || entry.on;
      }
      return any;
    };
    const tiles = (): PageCallTile[] => {
      const out: PageCallTile[] = [];
      const inRoom = new Set<string>();
      for (const p of remotes()) {
        inRoom.add(p.identity);
        const r = roster.get(p.identity);
        const tileState: TileState = r === undefined ? 'unverified' : verified.has(p.identity) ? 'ok' : 'not-heard';
        const show = tileState === 'ok' && !state.paused;
        const speaking = !state.paused && (remoteLocal(p.identity) ?? p.isSpeaking === true);
        out.push({ deviceId: p.identity, userId: r?.userId ?? '', state: tileState, speaking,
          video: show ? streamOf(p, SOURCE.camera) : null, screen: show ? streamOf(p, SOURCE.screen) : null });
      }
      for (const [deviceId, r] of roster) {
        if (r.leaf === selfLeaf || deviceId === local.identity || inRoom.has(deviceId)) continue;
        out.push({ deviceId, userId: r.userId, state: 'connecting', speaking: false, video: null, screen: null });
      }
      return out;
    };
    // The own mic counts only while it is sending (micSending === true: not muted, deafened, paused, or push to talk up).
    const ownLocal = (): boolean => ownMeter !== null && levelsLive();
    const level = (): number => {
      if (state.muted || state.paused) return 0;
      if (ownLocal()) return micSending === true ? Math.max(0, Math.min(12, Math.round(ownRms * 48))) : 0;
      return Math.max(0, Math.min(12, Math.round((local.audioLevel ?? 0) * 12)));
    };
    const ownSpeaking = (): boolean => {
      if (ownLocal()) return micSending === true && ownOn;
      return local.isSpeaking === true && !state.muted && !state.deafened && !state.paused;
    };
    let lastSetAt = Number.NEGATIVE_INFINITY;
    const refresh = (): void => {
      if (ended) return;
      lastSetAt = deps.now();
      set({ tiles: tiles(), level: level(), speaking: ownSpeaking() });
    };
    const gainFor = (identity: string): number =>
      gainOf(roster.get(identity)?.userId ?? '', volumes, { deafened: state.deafened, paused: state.paused });
    /** The gains of every remote person; first, the held-back tracks whose gain rose above 0 are attached (fix round 1,
     *  I3), so each new gain node takes its gain at once. */
    const applyGains = (): void => {
      attachPending();
      for (const p of remotes()) {
        const g = gainFor(p.identity);
        p.setVolume(g, SOURCE.microphone);
        p.setVolume(g, SOURCE.screenAudio);
      }
    };
    afterRoster = () => { if (!ended) { applyGains(); refresh(); } };

    // web3.3: livekit plays a remote audio track only once it is attached. With webAudioMix, attach() is also what routes
    // it through the room’s AudioContext and its gain node: a setVolume before the attach has no gain node to act on (and
    // a 0 is not re-applied by the attach), so applyGains runs after every attach. One element per track, in the hidden
    // audio host; each is detached and removed on unsubscribe, on the participant’s leave and on every leave of the call.
    // Fix round 1 (I3): attach makes a gain node at 1, and a later setVolume(0) only ramps it down (a 100 ms time
    // constant), so a track whose gain is 0 (deafened, paused, or a volume of 0) is not attached at all: it waits in
    // `pending` until its gain rises (applyGains). Decryption and the tile’s verification are the receiver’s media
    // worker’s, so an unattached track still turns its tile ok.
    const audioHost = deps.audioHost ?? defaultAudioHost;
    const playing = new Map<RemoteAudio, {
      el: HTMLMediaElement; identity: string; meter: LevelMeter | null; detector: SpeakingDetector; on: boolean;
    }>();
    const pending = new Map<RemoteAudio, string>();
    /** Takes a subscribed remote audio track in: it is attached by the next applyGains once its gain is above 0. A no-op
     *  for a track already attached, for video, and after the end. */
    const queueAudio = (track: unknown, identity: string): void => {
      const t = track as RemoteAudio | null | undefined;
      if (ended || t == null || t.kind !== 'audio' || playing.has(t)) return;
      pending.set(t, identity);
    };
    /** Fix round 2 (Minor 2): a device not in the roster yet has no known gain (its user, and so its volume, is unknown):
     *  it waits, and the roster change that names it (afterRoster → applyGains) attaches it. Nit 1: a track leaves
     *  `pending` only once it is attached; no host yet, or an attach that throws, keeps it for the next applyGains. */
    const attachPending = (): void => {
      for (const [t, identity] of [...pending]) {
        if (!roster.has(identity) || gainFor(identity) <= 0) continue;
        if (attachAudio(t, identity)) pending.delete(t);
      }
      countAudio();
    };
    /** web3.4 V2: state.audio follows `pending` and `playing`, said only on a change. A queued track is counted by the
     *  applyGains that follows every queueAudio (onSubscribed, the sweep at connect). */
    const countAudio = (): void => {
      const attached = playing.size;
      const expected = attached + pending.size;
      if (state.audio.attached !== attached || state.audio.expected !== expected) set({ audio: { attached, expected } });
    };
    const attachAudio = (t: RemoteAudio, identity: string): boolean => {
      if (playing.has(t)) return true;
      if (ended) return false;
      const host = audioHost();
      if (host === null) return false;
      let el: HTMLMediaElement;
      try { el = t.attach(); } catch { return false; }
      el.controls = false;
      el.tabIndex = -1;
      el.setAttribute('aria-hidden', 'true');
      host.appendChild(el);
      // web3.8 V1: the level is read from the element's own (decrypted, played) track; Chromium routes WebRTC audio to
      // WebAudio only through the element livekit attached. A failure to make a meter is the fallback, never an error.
      let tap: MediaStreamTrack | undefined;
      try { tap = (el.srcObject as MediaStream | null)?.getAudioTracks()[0] ?? t.mediaStreamTrack; } catch { tap = t.mediaStreamTrack; }
      playing.set(t, { el, identity, meter: makeMeter(tap), detector: new SpeakingDetector(), on: false });
      return true;
    };
    const detachAudio = (track: unknown): void => {
      const t = track as RemoteAudio;
      pending.delete(t);
      const entry = playing.get(t);
      if (entry !== undefined) {
        playing.delete(t);
        entry.meter?.close();
        try { t.detach(entry.el); } catch { /* the element is removed all the same */ }
        entry.el.remove();
      }
      countAudio();
    };
    /** Every attached or held-back track, or those of one participant. */
    const detachAudioOf = (identity?: string): void => {
      for (const [t, id] of [...pending]) if (identity === undefined || id === identity) pending.delete(t);
      for (const [t, entry] of [...playing]) if (identity === undefined || entry.identity === identity) detachAudio(t);
      countAudio();
    };
    /** Review Focus 1: tracks subscribed before the listeners existed (while joinCall or the publish was in flight). */
    const sweepAudio = (): void => {
      for (const p of remotes()) for (const pub of p.trackPublications?.values() ?? []) queueAudio(pub.track, p.identity);
    };
    /** Fix round 1 (M2): call audio is held back while the session’s context is not running. Fix round 2 (Minor 3): the
     *  context alone decides when there is one (the room’s canPlaybackAudio lags it); the room’s flag only without one. */
    const playbackBlocked = (): boolean => (ctx !== null ? ctx.state !== 'running'
      : (room as unknown as { canPlaybackAudio?: boolean }).canPlaybackAudio === false);

    // ---- the microphone
    const gate = new VoiceGate({ mode: opts.mode === 'ptt' ? 'ptt' : 'open' });
    // The mode in force, and the mode an RNNoise processor was built in: a processor built for push to talk gates the
    // audio itself (held open while voice activity is in force); otherwise push to talk mutes the track.
    let mode: 'vad' | 'ptt' = opts.mode;
    let processorMode: 'vad' | 'ptt' = opts.mode;
    let micPub: LocalPub | null = null;
    let micTrack: MediaStreamTrack | null = null;
    let processor: NoiseProcessor | null = null;
    let micSending: boolean | null = null;
    /** Sets an RNNoise processor on the microphone in the mode in force; a failure goes on without it. */
    const startNoise = async (): Promise<void> => {
      const track = micPub?.track;
      if (!track?.setProcessor || processor !== null) return;
      processorMode = mode;
      const made = (deps.createNoiseProcessor ?? ((m) => new DillaRnnoiseProcessor({ mode: m })))(processorMode);
      try {
        await track.setProcessor(made);
        processor = made;
      } catch {
        processor = null; // the microphone goes on without noise suppression
      }
    };
    const applyMic = (): void => {
      const track = micPub?.track;
      if (!track) return;
      // With RNNoise, its worklet gates push to talk; without it, the track itself is muted while the key is up.
      const pttOpen = mode !== 'ptt' || (processor !== null && processorMode === 'ptt') || gate.update(0, deps.now());
      const send = !ended && !state.muted && !state.deafened && !state.paused && pttOpen;
      if (send === micSending) return;
      micSending = send;
      void Promise.resolve(send ? track.unmute() : track.mute()).catch(() => undefined);
    };
    /** web3.8 V1: the own meter reads the track livekit publishes (the processed one, when a processor is set); it is made
     *  again whenever that track changes. No microphone, or a refusal, leaves the SFU's flag as the fallback. */
    const restartOwnMeter = (): void => {
      ownMeter?.close();
      ownMeter = null;
      ownDetector.reset();
      ownOn = false;
      ownRms = 0;
      if (!ended) ownMeter = makeMeter((micPub?.track as { mediaStreamTrack?: MediaStreamTrack } | undefined)?.mediaStreamTrack);
    };
    if ('track' in mic) {
      micTrack = mic.track;
      // Product walk M5: a start muted sends no frame before the mute lands (LiveKit's unmute enables it again).
      if (state.muted) mic.track.enabled = false;
      try {
        micPub = await local.publishTrack(mic.track, micOptions(caps));
      } catch {
        mic.track.stop();
        micTrack = null;
        state = { ...state, mic: 'failed', error: 'E_MIC_PUBLISH' };
      }
      if (micPub !== null) restartOwnMeter();
      checkAborted();
      if (opts.noise === 'on') {
        await startNoise();
        restartOwnMeter();
        checkAborted();
      }
    } else {
      state = { ...state, mic: mic.mic };
    }
    applyMic();

    // ---- sharing: callShare on, then the SFU’s permission, then the publish; callShare off once nothing is shared
    let shareOn = false;
    /** The settle of a share waiting for the SFU's permission (WB client m3): a leave settles it with false. */
    let waitingShare: ((ok: boolean) => void) | null = null;
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
      waitingShare = settle;
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
        if (waitingShare === settle) waitingShare = null;
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
      set({ camera: false, localCamera: null });
      await local.unpublishTrack(c.track).catch(() => undefined);
      c.track.stop();
    };
    const stopScreen = async (): Promise<void> => {
      const s = screen;
      if (s === null) return;
      screen = null;
      set({ sharing: false, localScreen: null });
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
      // WB client I2: a pause (or the end) that came while the publish was in flight: nothing stays published.
      if (ended || state.paused) {
        await local.unpublishTrack(track).catch(() => undefined);
        track.stop();
        await shareOffIfIdle();
        throw new PageCallError('E_UNAVAILABLE');
      }
      camera = { track };
      set({ camera: true, localCamera: viewOf(track) });
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
      // WB client I2: a pause (or the end) that came while the publish was in flight: nothing stays published.
      if (ended || state.paused) {
        await local.unpublishTrack(tracks.video).catch(() => undefined);
        if (tracks.audio !== null) await local.unpublishTrack(tracks.audio).catch(() => undefined);
        tracks.video.stop();
        tracks.audio?.stop();
        await shareOffIfIdle();
        throw new PageCallError('E_UNAVAILABLE');
      }
      // The browser’s own "stop sharing" ends the video track.
      const onEnded = (): void => { void setSharing(false).catch(() => undefined); };
      tracks.video.addEventListener('ended', onEnded);
      screen = { ...tracks, onEnded };
      set({ sharing: true, localScreen: viewOf(tracks.video) });
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
    // WB client I3: a room that ends on its own says why (state.error) and tells the worker it was lost.
    onRoomReconnecting = () => { if (!ended) set({ phase: 'reconnecting' }); };
    onRoomReconnected = () => { if (!ended) set({ phase: 'connected' }); };
    onRoomEnd = (reason) => {
      if (ended) return;
      set({ error: endCodeOf(reason) });
      void leave('lost');
    };
    const onSubscribed = (track: unknown, _pub: unknown, participant: unknown): void => {
      if (ended) return;
      queueAudio(track, (participant as RemoteView | undefined)?.identity ?? '');
      onPeople(); // applyGains attaches it (unless its gain is 0), then the new gain node takes the person’s volume
    };
    const onUnsubscribed = (track: unknown): void => { detachAudio(track); if (!ended) onPeople(); };
    const onLeft = (participant: unknown): void => {
      const identity = (participant as RemoteView | undefined)?.identity;
      if (typeof identity === 'string') detachAudioOf(identity);
      if (!ended) onPeople();
    };
    const onPlayback = (): void => { if (!ended) set({ audioBlocked: playbackBlocked() }); };
    const roomListeners: Array<[string, AnyListener]> = [
      [EV.participantConnected, onPeople], [EV.participantDisconnected, onLeft], [EV.trackSubscribed, onSubscribed],
      [EV.trackUnsubscribed, onUnsubscribed], [EV.activeSpeakers, onSpeakers], [EV.audioPlayback, onPlayback],
    ];
    for (const [e, f] of roomListeners) events.on(e, f);
    ctx?.addEventListener('statechange', onPlayback);
    const policy = new SpeakerPolicy(room);
    // Review M3: what a failed start (abandon) or a leave undoes of the room: its listeners, the policy, the audio.
    teardownRoom = () => {
      for (const [e, f] of roomListeners) events.off(e, f);
      ctx?.removeEventListener('statechange', onPlayback);
      detachAudioOf();
      try { policy.dispose(); } catch { /* the room is going away */ }
    };
    onPageHide = () => { void leave('pagehide'); };

    // ---- leave
    let leaving: Promise<void> | null = null;
    const stopEverything = (): void => {
      ended = true;
      relay.close();
      unsubscribe();
      for (const h of [...timers]) cancel(h);
      teardownRoom();
      detachEarly();
      win?.removeEventListener('pagehide', pageHide);
      opts.signal?.removeEventListener('abort', onAbort);
      waitingShare?.(false);
      closeCtx();
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
      const post = (r: 'user' | 'pagehide' | 'switch' | 'lost') => deps.bridge.call({ m: 'callLeave', reason: r }).then(() => undefined, () => undefined);
      const releaseAll = () => release().catch(() => undefined).finally(stopCaptures);
      if (reason === 'pagehide') {
        // The page is going away: nothing here may wait. callLeave is posted, then media stops in this same task.
        void post('pagehide');
        try { manager.dispose(); } catch { /* released below */ }
        void Promise.resolve(room.disconnect()).catch(() => undefined);
        leaving = releaseAll();
      } else if (reason === 'blocked' || reason === 'removed' || reason === 'lost') {
        // Keys must stop before anything else: media first, then the worker’s leave.
        leaving = releaseAll().then(() => post(reason === 'lost' ? 'lost' : 'user'));
      } else {
        const posted = post(reason);
        leaving = releaseAll().then(() => posted);
      }
      set({ phase: 'ended', camera: false, sharing: false, tiles: [], level: 0, speaking: false, localCamera: null, localScreen: null });
      return leaving;
    };

    // ---- web3.8 V1: the sampler. One timer reads every meter each SPEAK_TICK_MS and feeds its detector. A speaking flip
    // (own or remote) reaches the state at once; a level change only every LEVEL_PUBLISH_MS. Nothing here leaves the page.
    const sample = (): void => {
      if (ended) return;
      const now = deps.now();
      let flipped = false;
      if (ownMeter !== null && levelsLive()) {
        if (micSending === true) {
          ownRms = ownMeter.read();
          const on = ownDetector.update(ownRms, now);
          if (on !== ownOn) flipped = true;
          ownOn = on;
        } else {
          if (ownOn) flipped = true;
          ownRms = 0;
          ownDetector.reset();
          ownOn = false;
        }
      }
      if (levelsLive()) {
        for (const entry of playing.values()) {
          if (entry.meter === null) continue;
          const on = gainFor(entry.identity) > 0 && !state.paused ? entry.detector.update(entry.meter.read(), now) : false;
          if (on !== entry.on) flipped = true;
          entry.on = on;
          if (!on && (gainFor(entry.identity) <= 0 || state.paused)) entry.detector.reset();
        }
      }
      if (flipped || (level() !== state.level && now - lastSetAt >= LEVEL_PUBLISH_MS)) refresh();
      later(sample, SPEAK_TICK_MS);
    };

    // ---- connected (WB client m2: only while the room is still up)
    checkAborted();
    if ((room as unknown as { state?: string }).state === 'disconnected') throw new PageCallError('E_DISCONNECTED');
    opts.signal?.removeEventListener('abort', onAbort);
    sweepAudio();
    applyGains();
    state = { ...state, phase: 'connected', tiles: tiles(), audioBlocked: playbackBlocked() };
    // Product walk M5: a call started muted or deafened says so to the others at once.
    if (state.muted || state.deafened) sendSelf();
    later(poll, TILE_POLL_MS);
    later(sample, SPEAK_TICK_MS);
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
        // With a local meter the own mic starts silent after an unmute (the detector needs its 50 ms again); without one
        // the SFU's flag is the fallback.
        patch.speaking = ownLocal() ? false : local.isSpeaking === true && !on && !state.paused;
        if (on) { ownDetector.reset(); ownOn = false; ownRms = 0; }
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
        // WB client I2: a camera or screen goes quiet at once, before any queued camera or share operation (the lane may
        // be held by the screen picker or a permission prompt); the lane then unpublishes and stops them.
        if (on) for (const track of [camera?.track, screen?.video, screen?.audio]) if (track) track.enabled = false;
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
      dropKeys(upTo) {
        if (ended) return;
        // Re-review N-m1: the hold names the epoch whose key it drops; a newer epoch's key that arrived first (it ends the
        // hold) is kept, so the drop never silences the call it was meant to resume.
        const newest = relay.newestEpoch();
        if (upTo !== undefined && newest !== null && newest > upTo) return;
        relay.dropHeld();
        try { manager.clearKeys(); } catch { /* a failed or disposed manager holds no keys */ }
      },
      pushToTalk(down) {
        if (ended || mode !== 'ptt') return;
        gate.setPtt(down);
        if (processorMode === 'ptt') processor?.setPttActive(down);
        applyMic();
      },
      setMode(next) {
        if (ended || next === mode) return;
        mode = next;
        gate.setMode(next === 'ptt' ? 'ptt' : 'open');
        gate.setPtt(false);
        // A processor built for push to talk is held open under voice activity and closed again for push to talk.
        if (processorMode === 'ptt') processor?.setPttActive(next !== 'ptt');
        set({ mode: next });
        applyMic();
      },
      // Fix round 3 (m2): one switch at a time (the camera and screen lane), so a quick on-then-off never leaves a
      // processor set after the setting says off.
      setNoise: (next) => inLane(async () => {
        if (ended || next === state.noise) return;
        set({ noise: next });
        const track = micPub?.track;
        if (next === 'on') {
          await startNoise();
        } else if (processor !== null) {
          processor = null;
          // Fix round 3 (I-1): the push-to-talk gate decides before the processor goes, so the raw microphone LiveKit
          // swaps in stays muted with the key up (a processor built for push to talk held the track open itself).
          applyMic();
          await Promise.resolve(track?.stopProcessor?.()).catch(() => undefined);
        }
        restartOwnMeter(); // the processor swaps the published track
        applyMic();
      }),
      // Fix round 1 (M2): both run synchronously inside the "turn on audio" press (the dock’s button, the user activation
      // the browser asks for); nothing is awaited before them. A refusal leaves the line on offer. (The context itself is
      // made in the join's press, by useCall; see PageCallOptions.audioContext.)
      startAudio() {
        if (ended) return Promise.resolve();
        const tries: unknown[] = [];
        try { if (ctx !== null) tries.push(ctx.resume()); } catch { /* still held back */ }
        try { tries.push(room.startAudio()); } catch { /* still held back */ }
        return Promise.allSettled(tries).then(() => { if (!ended) set({ audioBlocked: playbackBlocked() }); });
      },
      // web3.4 V1: Settings → Voice's output during the call. With webAudioMix everything plays through the context's
      // destination, so the context's sink is the one to move. A refusal rejects (the shell says so); the call goes on
      // where it played before.
      setOutput(id) {
        if (ended || setSink === null) return Promise.resolve();
        return setSink(id);
      },
      leave,
    };
  } catch (err) {
    // Anything that fails after joinCall resolved tears the call down: no install, media released, then callLeave.
    throw await abandon(err, true);
  }
}
