import { EventEmitter } from 'events';
import type {
  BaseE2EEManager, EngineEvent, LocalTrack, Participant, ParticipantEvent, RemoteParticipant, RemoteTrack,
  RemoteTrackPublication, Room, RoomEvent,
} from 'livekit-client';
import type { DillaMediaStats, DillaTransformOptions, FromWorker, SlotId, ToWorker } from './protocol';
import { codecFromMime, isDeviceIdentity, kindMatchesSource, sourceToSlot } from './slots';

// livekit-client 2.22.3 event names as their string values, checked against the enums at compile time, so this
// module needs no runtime import of livekit-client (it is also loaded by Node unit tests).
const ROOM = {
  trackSubscribed: 'trackSubscribed',
  trackUnsubscribed: 'trackUnsubscribed',
  signalConnected: 'signalConnected',
  participantConnected: 'participantConnected',
  trackPublished: 'trackPublished',
} as const satisfies Record<string, `${RoomEvent}`>;
const LOCAL_SENDER_CREATED = 'localSenderCreated' satisfies `${ParticipantEvent}`;
const MEDIA_TRACK_ADDED = 'mediaTrackAdded' satisfies `${EngineEvent}`;

export const DATA_CHANNEL_ERROR = 'dilla: data-channel encryption is not supported; construct Room with e2ee:, not encryption:';
export const DATA_ERROR = 'dilla: data encryption is not supported';

export interface EpochKeys {
  groupId: string;
  epoch: bigint;
  baseKey: Uint8Array;
  selfLeaf: number;
  minEpoch: bigint;
  roster: Array<{ leaf: number; deviceId: string }>;
}

type Log = (level: 'error' | 'warn' | 'info' | 'debug', msg: string) => void;
type Listenable = Pick<EventEmitter, 'on' | 'off'>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- EventEmitter's own listener type
type Listener = (...args: any[]) => void;
const ATTACHED = Symbol('dilla-media-attached');
interface Attachable {
  [ATTACHED]?: string;
  createEncodedStreams?: () => { readable: ReadableStream; writable: WritableStream };
  transform?: unknown;
}

export function createMediaWorker(): Worker {
  return new Worker(new URL('./worker/index.ts', import.meta.url), { type: 'module', name: 'dilla-media-worker' });
}

/**
 * The hardened E2EE manager (interfaces.md c.4). Room is built with `e2ee: { e2eeManager }` on purpose (G11):
 * that keeps data-channel encryption off and livekit-client's Safari < 17.2 simulcast guard on.
 * It speaks only dilla-media/1 to its worker: no enable/disable message exists, no key reaches the worker except
 * through installEpoch, and the SIF trailer is forwarded for classification only (DEV-12, DEV-13, DEV-14).
 */
export class DillaE2EEManager extends EventEmitter implements BaseE2EEManager {
  private readonly worker: Worker;
  private readonly log: Log;
  private readonly ready: Promise<void>;
  private room: Room | undefined;
  private readonly engines = new WeakSet<object>();
  private readonly unsubscribe: Array<() => void> = [];
  private localEnabled = false;
  private pendingLocalEnable = false;
  private epochSeen = false;
  private firstInstall = true;
  private disposed = false;
  private readonly rosters = new Map<bigint, Set<string>>();
  private readonly pendingInstalls = new Map<bigint, Array<{ resolve: () => void; reject: (e: Error) => void }>>();
  private readonly remoteStatus = new Map<string, boolean>();
  private readonly pendingStats = new Map<number, (s: DillaMediaStats) => void>();
  private nextStatsId = 1;

  constructor(worker: Worker, opts?: { log?: Log }) {
    super();
    this.worker = worker;
    this.log = opts?.log ?? (() => undefined);
    let ack: () => void = () => undefined;
    this.ready = new Promise<void>((resolve) => { ack = resolve; });
    worker.addEventListener('message', (e: MessageEvent<FromWorker>) => this.onWorkerMessage(e.data, ack));
    this.post({ kind: 'init', v: 1, logLevel: 'warn', wasmUrl: new URL('../wasm/dilla_core_wasm_bg.wasm', import.meta.url).href });
  }

  get isEnabled(): boolean {
    return this.localEnabled;
  }

  get isDataChannelEncryptionEnabled(): boolean {
    return false;
  }

  set isDataChannelEncryptionEnabled(v: boolean) {
    if (v) throw new Error(DATA_CHANNEL_ERROR);
  }

  setup(room: Room): void {
    this.room = room;
    const r = room as unknown as Listenable;
    const on = (ev: string, fn: Listener): void => {
      r.on(ev, fn);
      this.unsubscribe.push(() => r.off(ev, fn));
    };
    on(ROOM.trackSubscribed, (track: RemoteTrack, pub: RemoteTrackPublication, p: RemoteParticipant) => this.mapTrack(track, pub, p));
    on(ROOM.trackUnsubscribed, (track: RemoteTrack) => this.post({ kind: 'detach', trackId: track.mediaStreamID }));
    on(ROOM.signalConnected, () => this.onSignalConnected());
    on(ROOM.participantConnected, (p: RemoteParticipant) => this.updateRemote(p));
    on(ROOM.trackPublished, (_pub: RemoteTrackPublication, p: RemoteParticipant) => this.updateRemote(p));
    const lp = room.localParticipant as unknown as Listenable;
    const onSender = (sender: RTCRtpSender, track: LocalTrack): void => this.attachSender(sender, track);
    lp.on(LOCAL_SENDER_CREATED, onSender);
    this.unsubscribe.push(() => lp.off(LOCAL_SENDER_CREATED, onSender));
  }

  setupEngine(engine: unknown): void {
    const e = engine as Listenable & object;
    if (this.engines.has(e)) return;
    this.engines.add(e);
    // Synchronous inside pc.ontrack in every Room state (RTCEngine.ts:646-651); TrackSubscribed is deferred and
    // is never the first attach (gap G3; SP-01 measured TrackSubscribed leaking a plaintext Firefox frame in
    // 3 of 6 runs and MediaTrackAdded leaking none).
    const onTrack = (track: MediaStreamTrack, _stream: MediaStream, receiver: RTCRtpReceiver): void => this.attachReceiver(track, receiver);
    e.on(MEDIA_TRACK_ADDED, onTrack);
    this.unsubscribe.push(() => e.off(MEDIA_TRACK_ADDED, onTrack));
  }

  setParticipantCryptorEnabled(enabled: boolean, participantIdentity: string): void {
    if (!enabled) {
      const err = new Error('E_E2EE_REQUIRED');
      this.emit('encryptionError', err, participantIdentity);
      throw err;
    }
    const room = this.room;
    if (room === undefined || participantIdentity !== room.localParticipant.identity || this.localEnabled) return;
    if (!this.epochSeen) {
      this.pendingLocalEnable = true;
      return;
    }
    this.enableLocal();
  }

  setSifTrailer(trailer: Uint8Array): void {
    // Classification only (DEV-13, SP-13): the worker drops a frame that ends in it before parsing any header.
    if (trailer?.length > 0) this.post({ kind: 'setSifTrailer', trailer: trailer.slice() });
  }

  async encryptData(_data: Uint8Array): Promise<never> {
    throw new Error(DATA_ERROR);
  }

  async handleEncryptedData(_payload: Uint8Array, _iv: Uint8Array, _participantIdentity: string, _keyIndex: number): Promise<never> {
    throw new Error('E_DATA_E2EE_UNSUPPORTED');
  }

  async installEpoch(k: EpochKeys): Promise<void> {
    if (this.disposed) throw new Error('E_NO_EPOCH: the manager is disposed');
    if (k.baseKey.length !== 16) throw new Error('E_BAD_OPTIONS: the base key is 16 bytes');
    if (!Number.isInteger(k.selfLeaf) || k.selfLeaf < 0 || k.selfLeaf > 0xffff) throw new Error('E_BAD_OPTIONS: leaf out of range');
    for (const r of k.roster) {
      if (!isDeviceIdentity(r.deviceId) || !Number.isInteger(r.leaf) || r.leaf < 0 || r.leaf > 0xffff) throw new Error('E_BAD_OPTIONS: roster entry');
    }
    // N1: a worker's first epoch must be one its device committed after the worker started (protocol/05 Sender uniqueness).
    if (this.firstInstall && k.epoch < k.minEpoch) throw new Error('E_NO_EPOCH: the first epoch predates this device’s join or resync commit');
    await this.ready;
    this.firstInstall = false;
    this.rosters.set(k.epoch, new Set(k.roster.map((r) => r.deviceId)));
    const baseKey = k.baseKey.slice();
    k.baseKey.fill(0);
    const done = new Promise<void>((resolve, reject) => {
      this.pendingInstalls.set(k.epoch, [...(this.pendingInstalls.get(k.epoch) ?? []), { resolve, reject }]);
    });
    this.post({ kind: 'installEpoch', groupId: k.groupId, epoch: k.epoch, baseKey, selfLeaf: k.selfLeaf, roster: k.roster.map((r) => ({ leaf: r.leaf, deviceId: r.deviceId })) }, [baseKey.buffer]);
    await done;
  }

  stats(): Promise<DillaMediaStats> {
    const id = this.nextStatsId++;
    return new Promise((resolve) => {
      this.pendingStats.set(id, resolve);
      this.post({ kind: 'stats', id });
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.post({ kind: 'clearKeys' });
    for (const u of this.unsubscribe.splice(0)) u();
    this.removeAllListeners();
  }

  private onWorkerMessage(m: FromWorker, ack: () => void): void {
    switch (m.kind) {
      case 'initAck':
        ack();
        return;
      case 'epochInstalled':
        this.epochSeen = true;
        for (const p of this.pendingInstalls.get(m.epoch) ?? []) p.resolve();
        this.pendingInstalls.delete(m.epoch);
        if (this.pendingLocalEnable) {
          this.pendingLocalEnable = false;
          this.enableLocal();
        }
        this.refreshRemoteStatus();
        return;
      case 'epochRetired':
        this.rosters.delete(m.epoch);
        this.refreshRemoteStatus();
        return;
      case 'stats': {
        const resolve = this.pendingStats.get(m.id);
        this.pendingStats.delete(m.id);
        resolve?.(m.data);
        return;
      }
      case 'seqExhausted':
        this.log('warn', `sequence space exhausted on slot ${m.slot} layer ${m.layer}; an MLS Update is needed`);
        return;
      case 'rekeyNeeded':
        this.emit('rekeyNeeded', m.reason);
        return;
      case 'error':
        this.log('warn', `${m.code}${m.trackId === undefined ? '' : ` on ${m.trackId}`}`);
        if (m.code === 'E_WASM') {
          for (const list of this.pendingInstalls.values()) for (const p of list) p.reject(new Error('E_WASM'));
          this.pendingInstalls.clear();
        }
        if (m.code === 'E_NO_EPOCH' || m.code === 'E_BAD_OPTIONS' || m.code === 'E_WASM') this.emit('encryptionError', new Error(m.code), m.participantIdentity);
        return;
      case 'log':
        this.log(m.level, m.msg);
        return;
      case 'attached':
        this.log('debug', `attached ${m.side} ${m.trackId}`);
        return;
    }
  }

  private onSignalConnected(): void {
    const room = this.room;
    if (room === undefined) return;
    const lp = room.localParticipant;
    // setE2EEEnabled(true) before connect() skips the manager (identity ''), so the manager enables itself here.
    if (!lp.isE2EEEnabled) {
      this.emit('encryptionError', new Error('E_E2EE_REQUIRED'), lp.identity);
      return;
    }
    this.setParticipantCryptorEnabled(true, lp.identity);
  }

  private enableLocal(): void {
    const room = this.room;
    if (room === undefined || this.localEnabled) return;
    this.localEnabled = true;
    this.emit('participantEncryptionStatusChanged', true, room.localParticipant);
  }

  private attachReceiver(track: MediaStreamTrack, receiver: RTCRtpReceiver): void {
    const audio = track.kind === 'audio';
    // Early attach: identity, slot and flag are unknown until TrackSubscribed maps the track; the worker holds
    // every frame of an unmapped track and never renders it.
    this.attach(receiver as unknown as Attachable, {
      dilla: 1, side: 'decode', trackId: track.id, participantIdentity: '', slot: audio ? 0 : 1, codec: audio ? 'opus' : 'vp8',
    });
  }

  private attachSender(sender: RTCRtpSender, track: LocalTrack): void {
    const room = this.room;
    if (room === undefined) return;
    const kind: string = track.kind; // Track.Kind is a string enum; compare its value, not the enum
    let slot: SlotId;
    try {
      slot = sourceToSlot(track.source);
    } catch (err) {
      this.fail(err, room.localParticipant.identity);
      return;
    }
    const audio = kind === 'audio';
    const codec = audio ? 'opus' : codecFromMime(`video/${(track as unknown as { codec?: string }).codec ?? 'vp8'}`, 'video');
    if (codec === null) {
      this.fail(new Error('E_BAD_OPTIONS: unsupported video codec'), room.localParticipant.identity);
      return;
    }
    this.attach(sender as unknown as Attachable, {
      dilla: 1, side: 'encode', trackId: track.mediaStreamID, participantIdentity: room.localParticipant.identity, slot, codec,
    });
  }

  private attach(rtp: Attachable, opts: DillaTransformOptions): void {
    const previous = rtp[ATTACHED];
    // SP-01 (task 14, measured): on Chromium the PC carries encodedInsertableStreams: true and createEncodedStreams
    // is livekit-client's own path; RTCRtpScriptTransform where createEncodedStreams does not exist (Firefox,
    // Safari). Receivers are reused routinely (30 MediaTrackAdded re-deliveries per Chromium run), so a reused
    // sender or receiver is re-pointed with retarget: createEncodedStreams works once per sender/receiver.
    if (typeof rtp.createEncodedStreams === 'function') {
      if (previous !== undefined) {
        this.post({ kind: 'retarget', data: { previousTrackId: previous, ...opts } });
      } else {
        const { readable, writable } = rtp.createEncodedStreams();
        this.post({ kind: 'attach', data: { ...opts, readable, writable } }, [readable, writable]);
      }
    } else {
      const Transform = (globalThis as { RTCRtpScriptTransform?: new (worker: Worker, options: unknown) => unknown }).RTCRtpScriptTransform;
      if (Transform === undefined) {
        this.fail(new Error('E_E2EE_REQUIRED: no transform API'), opts.participantIdentity);
        return;
      }
      rtp.transform = new Transform(this.worker, opts); // a reused receiver simply takes a new transform
    }
    rtp[ATTACHED] = opts.trackId;
  }

  private mapTrack(track: RemoteTrack, pub: RemoteTrackPublication, participant: RemoteParticipant): void {
    const trackKind: string = track.kind; // Track.Kind is a string enum
    const kind = trackKind === 'audio' ? 'audio' : 'video';
    const identity = participant.identity;
    let slot: SlotId;
    try {
      slot = sourceToSlot(pub.source);
    } catch (err) {
      this.fail(err, identity);
      return;
    }
    const codec = kind === 'audio' ? 'opus' : codecFromMime(pub.trackInfo?.mimeType, 'video');
    if (codec === null) {
      this.fail(new Error(`E_BAD_OPTIONS: unsupported codec ${pub.trackInfo?.mimeType ?? 'unknown'}`), identity);
      return;
    }
    if (!kindMatchesSource(kind, pub.source) || !isDeviceIdentity(identity)) {
      // Unverified stream: the worker drops it (slotMismatch / senderMismatch); the UI learns it here.
      this.emit('encryptionError', new Error('E_BAD_OPTIONS: unverified stream'), identity);
    }
    const encryption = (pub.trackInfo?.encryption ?? 0) as 0 | 1 | 2;
    this.post({ kind: 'mapTrack', trackId: track.mediaStreamID, participantIdentity: identity, slot, codec, encryption });
  }

  private inRoster(identity: string): boolean {
    if (!isDeviceIdentity(identity)) return false;
    for (const set of this.rosters.values()) if (set.has(identity)) return true;
    return false;
  }

  private updateRemote(p: Participant): void {
    const v = this.inRoster(p.identity);
    if (this.remoteStatus.get(p.identity) === v) return;
    this.remoteStatus.set(p.identity, v);
    this.emit('participantEncryptionStatusChanged', v, p);
  }

  private refreshRemoteStatus(): void {
    const room = this.room;
    if (room === undefined) return;
    for (const p of room.remoteParticipants.values()) this.updateRemote(p);
  }

  private fail(err: unknown, identity: string): void {
    const e = err instanceof Error ? err : new Error(String(err));
    this.log('error', e.message);
    this.emit('encryptionError', e, identity);
  }

  private post(m: ToWorker, transfer: Transferable[] = []): void {
    this.worker.postMessage(m, transfer);
  }
}
