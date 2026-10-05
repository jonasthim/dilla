import type { EventEmitter } from 'events';
import { Room, type RoomConnectOptions, type RoomEvent, type RoomOptions, type TrackPublishDefaults } from 'livekit-client';
import { createMediaWorker, DillaE2EEManager, type EpochKeys } from './manager';
import { isVoiceSupported } from './support';
import { installDillaCodecPreferences } from './codec-preferences';

export type IceServerTuple = [urls: string[], username: string, credential: string];

export interface JoinCallOptions {
  livekitUrl: string;
  token: string;
  iceServers: IceServerTuple[];
  epoch: EpochKeys;
  lock: { instanceId: string; callGroupId: string };
  /** Only the CALLER_ROOM_OPTIONS keys are used; every other key is ignored (I1). */
  roomOptions?: Partial<RoomOptions>;
  /**
   * How long the media worker may take to load and answer init before the join fails with E_WASM.
   * Default INIT_TIMEOUT_MS (15 s). A slow device, or a development server that serves the worker
   * unbundled, needs longer: a 4-vCPU CI runner missed 15 s once. Values outside 1 s to 120 s are
   * ignored.
   */
  initTimeoutMs?: number;
}

export interface CallSession {
  room: Room;
  manager: DillaE2EEManager;
  release(): Promise<void>;
}

const E2EE_WAIT_MS = 10_000;
const STATUS_EVENT = 'participantEncryptionStatusChanged' satisfies `${RoomEvent}`;

/** interfaces.md c.2: the dilla publish defaults (DEV-08, DEV-09: RED and backup codecs off under E2EE anyway). */
export const ROOM_DEFAULTS: Partial<RoomOptions> = {
  adaptiveStream: false,
  dynacast: false,
  publishDefaults: {
    audioPreset: { maxBitrate: 64_000, priority: 'high' },
    dtx: true,
    red: false,
    forceStereo: false,
    videoCodec: 'vp8',
    simulcast: true,
    backupCodec: false,
  },
};

/**
 * I1 (task 17 review): the only RoomOptions a caller may set. Everything else is dilla's: `e2ee` and `encryption`
 * (Room.setupE2EE prefers `encryption` over `e2ee`, Room.ts:506-517, so either could replace the manager), `dynacast`
 * (multi-codec simulcast needs it), `frameMetadata` / `packetTrailer` (they append bytes to frames, Room.ts:539-543,
 * 2562-2563) and anything livekit-client adds later. Only the CALLER_PUBLISH_DEFAULTS keys of publishDefaults are
 * merged over ROOM_DEFAULTS', and `red`, `backupCodec` and `preConnectBuffer` are forced off after the merge (N1).
 */
export const CALLER_ROOM_OPTIONS = [
  'adaptiveStream', 'audioCaptureDefaults', 'videoCaptureDefaults', 'publishDefaults', 'audioOutput',
  'stopLocalTrackOnUnpublish', 'reconnectPolicy', 'disconnectOnPageLeave', 'webAudioMix', 'loggerName',
  'singlePeerConnection', 'dataStream',
] as const satisfies ReadonlyArray<keyof RoomOptions>;

/**
 * N1 (task 17 re-review): the only publishDefaults keys a caller may set, checked against livekit-client 2.22.3. Each
 * only shapes what the encoder produces before the sender transform encrypts it (bitrates, layers, codec choice, DTX,
 * stereo, degradation, stopping the mic on mute). Everything else is dropped:
 * - `preConnectBuffer` (forced false below): records the microphone with a MediaRecorder from capture and, once the
 *   SFU echoes TF_PRECONNECT_BUFFER and flags any participant as an agent, streams the recording over the data
 *   channel (LocalParticipant.ts:586-598, 1093-1095, 1385-1444; LocalTrack.ts:651-691), which dilla leaves
 *   unencrypted (OutgoingDataStreamManager.ts:97, 524): plaintext microphone audio outside every transform;
 * - `frameMetadata` / `packetTrailer`: frame metadata written by livekit's own transform worker
 *   (RTCEngine.ts:1058-1105, LocalParticipant.ts:1448-1479), never part of a dilla call;
 * - `red`, `backupCodec` (forced false below; DEV-08, DEV-09) and `backupCodecPolicy`, which only matters with backup
 *   codecs;
 * - any key livekit-client adds later.
 * The manager also refuses a pre-connect recorder or these options when they are passed per publish (attachSender).
 */
export const CALLER_PUBLISH_DEFAULTS = [
  'videoEncoding', 'screenShareEncoding', 'videoCodec', 'audioPreset', 'dtx', 'forceStereo', 'simulcast',
  'scalabilityMode', 'degradationPreference', 'videoSimulcastLayers', 'screenShareSimulcastLayers', 'stopMicTrackOnMute',
] as const satisfies ReadonlyArray<keyof TrackPublishDefaults>;

function pick<T extends object>(from: T | undefined, keys: ReadonlyArray<keyof T>): Partial<T> {
  const out: Partial<T> = {};
  if (from === undefined || from === null) return out;
  for (const key of keys) if (Object.hasOwn(from, key) && from[key] !== undefined) out[key] = from[key];
  return out;
}

/** The RoomOptions joinCall builds Room with: ROOM_DEFAULTS, the caller's allowed keys, then the forced values. */
export function dillaRoomOptions(manager: DillaE2EEManager, caller: Partial<RoomOptions> = {}): RoomOptions {
  const allowed = pick(caller, CALLER_ROOM_OPTIONS);
  return {
    ...ROOM_DEFAULTS,
    ...allowed,
    publishDefaults: {
      ...ROOM_DEFAULTS.publishDefaults,
      ...pick(allowed.publishDefaults, CALLER_PUBLISH_DEFAULTS),
      red: false,
      backupCodec: false,
      preConnectBuffer: false,
    },
    dynacast: false,
    // e2ee: (the deprecated key) on purpose (G11, DEV-11): with `encryption` absent Room.setupE2EE sets
    // isDataChannelEncryptionEnabled = false (Room.ts:509-515), and LocalParticipant keeps its Safari < 17.2
    // simulcast guard, which reads roomOptions.e2ee. No caller key can reach it: `encryption` is not whitelisted.
    e2ee: { e2eeManager: manager },
  };
}

/**
 * I1: Room must use exactly this manager. Room.hasE2EESetup (Room.ts:247-249) is true when a manager was set up, and
 * Room hands that manager to its engine (Room.ts:374, 613; RTCEngine.ts:162 `e2eeManager`), so the engine's manager
 * must be ours; anything else and the join is refused.
 */
export function assertDillaManager(room: Room, manager: DillaE2EEManager): void {
  const engine = (room as unknown as { engine?: { e2eeManager?: unknown } }).engine;
  if (!room.hasE2EESetup || engine?.e2eeManager !== manager) {
    throw new Error('E_E2EE_REQUIRED: the Room does not use the dilla E2EE manager');
  }
}

export function toRtcIceServers(list: IceServerTuple[]): RTCIceServer[] {
  return list.map(([urls, username, credential]) => ({ urls, username, credential }));
}

async function acquireMediaLock(name: string): Promise<(() => void) | null> {
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => { release = resolve; });
  return new Promise((resolve, reject) => {
    navigator.locks
      .request(name, { mode: 'exclusive', ifAvailable: true }, async (lock) => {
        if (lock === null) {
          resolve(null);
          return;
        }
        resolve(release);
        await held;
      })
      .catch(reject);
  });
}

function waitForLocalEncryption(room: Room): Promise<void> {
  if (room.isE2EEEnabled) return Promise.resolve();
  const r = room as unknown as Pick<EventEmitter, 'on' | 'off'>;
  return new Promise((resolve, reject) => {
    const onStatus = (enabled: boolean, participant: unknown): void => {
      if (!enabled || participant !== room.localParticipant) return;
      clearTimeout(timer);
      r.off(STATUS_EVENT, onStatus);
      resolve();
    };
    const timer = setTimeout(() => {
      r.off(STATUS_EVENT, onStatus);
      reject(new Error('E_E2EE_REQUIRED: the local participant never became encrypted'));
    }, E2EE_WAIT_MS);
    r.on(STATUS_EVENT, onStatus);
  });
}

/**
 * DEV-27: lock → (caller: external commit or own-leaf resync → processed epoch) → installEpoch acked →
 * setE2EEEnabled(true) → connect(url, jwt, { rtcConfig: { iceServers, bundlePolicy: 'max-bundle' } }) →
 * the manager self-enables on SignalConnected → resolve, so every publish happens with room.isE2EEEnabled true.
 *
 * The caller owns the HTTP side of a call (protocol/09 Voice as shipped by tasks 10–13): the token from
 * POST /v1/channels/{id}/calls carries the base grant only, so before publishing a camera or screen the caller
 * POSTs /v1/calls/{call_id}/share after every fresh start and publishes once ParticipantPermissionsChanged shows
 * the source; a 403 from /rtc means "start the call again", a 503 E_UNAVAILABLE or 429 E_RATE_LIMITED means retry
 * after retry_after_ms; a call whose group was closed (room_finished) needs a fresh call group; and fresh
 * ice_servers come from a new start, handed in through refreshIceServers.
 */
/** The caller's worker init timeout when it is a whole number of milliseconds from 1 s to 120 s. */
function initTimeout(ms: number | undefined): number | undefined {
  return typeof ms === 'number' && Number.isInteger(ms) && ms >= 1_000 && ms <= 120_000 ? ms : undefined;
}

export async function joinCall(o: JoinCallOptions): Promise<CallSession> {
  const support = isVoiceSupported();
  if (!support.ok) throw new Error(`E_E2EE_REQUIRED: ${support.reason}`);
  // N2: one sender instance per (device, call group). Exclusive, ifAvailable, never steal.
  const releaseLock = await acquireMediaLock(`dilla-media:${o.lock.instanceId}:${o.lock.callGroupId}`);
  if (releaseLock === null) throw new Error('E_CALL_IN_OTHER_TAB');
  const worker = createMediaWorker();
  const manager = new DillaE2EEManager(worker, { initTimeoutMs: initTimeout(o.initTimeoutMs) });
  let room: Room | undefined;
  let restorePeerConnection: (() => void) | undefined;
  // N2 (task 17 re-review): every step runs, whatever an earlier one threw; the first error is rethrown at the end.
  // dispose clears the keys first, disconnect stops publishing, terminate ends the worker (and with it every
  // transform), and the Web Lock is released last so a second tab cannot start while this one still sends.
  const release = async (): Promise<void> => {
    let first: unknown = null;
    let failed = false;
    const step = async (fn: () => unknown): Promise<void> => {
      try {
        await fn();
      } catch (err) {
        if (!failed) first = err;
        failed = true;
      }
    };
    try {
      await step(() => manager.dispose());
      await step(() => room?.disconnect());
      await step(() => worker.terminate());
    } finally {
      restorePeerConnection?.();
      releaseLock();
    }
    if (failed) throw first;
  };
  try {
    // Rejects with E_WASM when the worker errors or never answers init (INIT_TIMEOUT_MS): the catch below then
    // disposes, terminates the worker and releases the Web Lock (I2).
    await manager.installEpoch(o.epoch);
    if (typeof globalThis.RTCPeerConnection !== 'undefined') restorePeerConnection = installDillaCodecPreferences();
    room = new Room(dillaRoomOptions(manager, o.roomOptions));
    assertDillaManager(room, manager);
    await room.setE2EEEnabled(true);
    const connectOptions: RoomConnectOptions = {
      autoSubscribe: true,
      maxRetries: 1,
      peerConnectionTimeout: 15_000,
      websocketTimeout: 15_000,
      rtcConfig: { iceServers: toRtcIceServers(o.iceServers), bundlePolicy: 'max-bundle' },
    };
    await room.connect(o.livekitUrl, o.token, connectOptions);
    await waitForLocalEncryption(room);
    return { room, manager, release };
  } catch (err) {
    await release().catch(() => undefined);
    throw err;
  }
}

/**
 * DEV-53: refresh TURN credentials before their TTL without reconnecting. room.engine.rtcConfig is the only live
 * swap: livekit-client 2.22.3 applies it to both PeerConnections on the next signal resume
 * (RTCEngine.ts:1484-1486, pcManager.updateConfiguration) and builds new PeerConnections from it on a full
 * reconnect.
 */
export function refreshIceServers(room: Room, iceServers: IceServerTuple[]): void {
  const engine = room.engine as unknown as { rtcConfig: RTCConfiguration };
  engine.rtcConfig = { ...engine.rtcConfig, iceServers: toRtcIceServers(iceServers) };
}
