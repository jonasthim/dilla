import type { EventEmitter } from 'events';
import { Room, type RoomConnectOptions, type RoomEvent, type RoomOptions } from 'livekit-client';
import { createMediaWorker, DillaE2EEManager, type EpochKeys } from './manager';
import { isVoiceSupported } from './support';

export type IceServerTuple = [urls: string[], username: string, credential: string];

export interface JoinCallOptions {
  livekitUrl: string;
  token: string;
  iceServers: IceServerTuple[];
  epoch: EpochKeys;
  lock: { instanceId: string; callGroupId: string };
  roomOptions?: Partial<RoomOptions>;
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
export async function joinCall(o: JoinCallOptions): Promise<CallSession> {
  const support = isVoiceSupported();
  if (!support.ok) throw new Error(`E_E2EE_REQUIRED: ${support.reason}`);
  // N2: one sender instance per (device, call group). Exclusive, ifAvailable, never steal.
  const releaseLock = await acquireMediaLock(`dilla-media:${o.lock.instanceId}:${o.lock.callGroupId}`);
  if (releaseLock === null) throw new Error('E_CALL_IN_OTHER_TAB');
  const worker = createMediaWorker();
  const manager = new DillaE2EEManager(worker);
  let room: Room | undefined;
  const release = async (): Promise<void> => {
    manager.dispose();
    try {
      await room?.disconnect();
    } finally {
      worker.terminate();
      releaseLock();
    }
  };
  try {
    await manager.installEpoch(o.epoch);
    // e2ee: (deprecated key) on purpose, last, so roomOptions cannot replace the manager (G11).
    room = new Room({ ...ROOM_DEFAULTS, ...o.roomOptions, e2ee: { e2eeManager: manager } });
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
