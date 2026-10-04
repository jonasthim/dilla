import { EventEmitter } from 'events';
import type {
  BaseE2EEManager, EngineEvent, LocalTrack, Participant, ParticipantEvent, RemoteParticipant, RemoteTrack,
  RemoteTrackPublication, Room, RoomEvent,
} from 'livekit-client';
import type { DillaBlockOptions, DillaMediaStats, DillaTransformOptions, FromWorker, SlotId, ToWorker } from './protocol';
import { codecFromMime, isDeviceIdentity, kindMatchesSource, sourceToSlot } from './slots';
import { kidHex } from './worker/stats';

// livekit-client 2.22.3 event names as their string values, checked against the enums at compile time, so this
// module needs no runtime import of livekit-client (it is also loaded by Node unit tests).
const ROOM = {
  trackSubscribed: 'trackSubscribed',
  trackUnsubscribed: 'trackUnsubscribed',
  signalConnected: 'signalConnected',
  participantConnected: 'participantConnected',
  participantDisconnected: 'participantDisconnected',
  trackPublished: 'trackPublished',
} as const satisfies Record<string, `${RoomEvent}`>;
const LOCAL_SENDER_CREATED = 'localSenderCreated' satisfies `${ParticipantEvent}`;
const MEDIA_TRACK_ADDED = 'mediaTrackAdded' satisfies `${EngineEvent}`;

export const DATA_CHANNEL_ERROR = 'dilla: data-channel encryption is not supported; construct Room with e2ee:, not encryption:';
export const DATA_ERROR = 'dilla: data encryption is not supported';
/**
 * I2: how long the worker may take to load the wasm and answer `init` (a module worker blocked by CSP, a bad
 * bundler URL or a hung wasm fetch never answers). After it, `ready`, every pending installEpoch and every pending
 * stats() reject with E_WASM, so joinCall rejects and releases its Web Lock.
 */
export const INIT_TIMEOUT_MS = 15_000;

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
type AttachResult = 'ok' | 'blocked' | 'stopped';
const ATTACHED = Symbol('dilla-media-attached');
/** createEncodedStreams threw, or its streams never reached the worker: this sender or receiver stays unusable. */
const DEAD = 'dilla-media-dead' as const;
interface Attachable {
  [ATTACHED]?: string | typeof DEAD;
  createEncodedStreams?: () => { readable: ReadableStream; writable: WritableStream };
  transform?: unknown;
}
interface Pending<T> { resolve: (v: T) => void; reject: (e: Error) => void }

const isBlock = (o: DillaTransformOptions | DillaBlockOptions): o is DillaBlockOptions => 'block' in o;
const blockOf = (o: DillaTransformOptions | DillaBlockOptions): DillaBlockOptions => ({ dilla: 1, side: o.side, trackId: o.trackId, block: true });
const toError = (err: unknown): Error => (err instanceof Error ? err : new Error(String(err)));

function stopTrack(track: MediaStreamTrack | undefined): void {
  try {
    track?.stop();
  } catch {
    // an already-ended track; nothing to do
  }
}

export function createMediaWorker(): Worker {
  return new Worker(new URL('./worker/index.ts', import.meta.url), { type: 'module', name: 'dilla-media-worker' });
}

/**
 * The hardened E2EE manager (interfaces.md c.4). Room is built with `e2ee: { e2eeManager }` on purpose (G11):
 * Room.setupE2EE (Room.ts:506-517) then sets isDataChannelEncryptionEnabled = false, which keeps data-channel
 * encryption off, and LocalParticipant keeps its Safari < 17.2 simulcast guard (it reads roomOptions.e2ee).
 * It speaks only dilla-media/1 to its worker: no enable/disable message exists, no key reaches the worker except
 * through installEpoch, and the SIF trailer is forwarded for classification only (DEV-12, DEV-13, DEV-14).
 *
 * Fail closed (task 17 fix round 1, C1): every sender and receiver this manager sees gets a transform that drops by
 * default. Where it cannot build options it attaches a blocking transform (DillaBlockOptions); where no transform can
 * be attached at all it stops the MediaStreamTrack. A sender that ends up blocked or stopped is reported through
 * `encryptionError` and unpublished in a microtask.
 *
 * `participantEncryptionStatusChanged` (the event name is fixed by livekit-client's BaseE2EEManager, and Room sets
 * room.isE2EEEnabled from it for the local participant only):
 * - local participant: true once an epoch is installed and E2EE is enabled; false again on dispose or when the
 *   worker fails;
 * - remote participant: true means only "this identity is a device in the roster of an installed epoch" (current
 *   or retained for 10 s). It does NOT mean that any of its frames were verified; a member whose frames are all
 *   dropped is still true. verifiedIdentities() reports the identities whose frames the worker authenticated.
 *   Entries are forgotten when the participant disconnects.
 */
export class DillaE2EEManager extends EventEmitter implements BaseE2EEManager {
  private readonly worker: Worker;
  private readonly log: Log;
  private readonly ready: Promise<void>;
  private ack: () => void = () => undefined;
  private failReady: (e: Error) => void = () => undefined;
  private initTimer: ReturnType<typeof setTimeout> | undefined;
  private failure: Error | null = null;
  private room: Room | undefined;
  private readonly engines = new WeakSet<object>();
  private readonly unsubscribe: Array<() => void> = [];
  private localEnabled = false;
  private pendingLocalEnable = false;
  private epochSeen = false;
  /** M1: the highest minEpoch of any install before the worker confirmed one; nothing below it is installed. */
  private minEpochFloor = -1n;
  private disposed = false;
  /** epoch → leaf → device identity, for the roster status and verifiedIdentities(). */
  private readonly rosters = new Map<bigint, Map<number, string>>();
  private readonly pendingInstalls = new Map<bigint, Array<Pending<void>>>();
  private readonly inRosterStatus = new Map<string, boolean>();
  private readonly pendingStats = new Map<number, Pending<DillaMediaStats>>();
  private readonly localTrackIds = new Set<string>();
  private nextStatsId = 1;

  constructor(worker: Worker, opts?: { log?: Log; initTimeoutMs?: number }) {
    super();
    this.worker = worker;
    this.log = opts?.log ?? (() => undefined);
    this.ready = new Promise<void>((resolve, reject) => {
      this.ack = resolve;
      this.failReady = reject;
    });
    this.ready.catch(() => undefined); // observed by installEpoch; never an unhandled rejection
    worker.addEventListener('message', (e: MessageEvent<FromWorker>) => this.onWorkerMessage(e.data));
    worker.addEventListener('error', (e: Event) => this.failWorker(`worker error: ${(e as ErrorEvent).message ?? 'unknown'}`));
    worker.addEventListener('messageerror', () => this.failWorker('a worker message could not be deserialised'));
    this.initTimer = setTimeout(() => this.failWorker('the worker did not answer init'), opts?.initTimeoutMs ?? INIT_TIMEOUT_MS);
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
    on(ROOM.participantDisconnected, (p: RemoteParticipant) => this.inRosterStatus.delete(p.identity));
    on(ROOM.trackPublished, (_pub: RemoteTrackPublication, p: RemoteParticipant) => this.updateRemote(p));
    const lp = room.localParticipant as unknown as Listenable;
    const onSender = (sender: RTCRtpSender, track: LocalTrack): void => this.attachSender(sender, track);
    lp.on(LOCAL_SENDER_CREATED, onSender);
    this.unsubscribe.push(() => lp.off(LOCAL_SENDER_CREATED, onSender));
  }

  setupEngine(engine: unknown): void {
    const e = engine as Listenable & Pick<EventEmitter, 'prependListener'> & object;
    if (this.engines.has(e)) return;
    this.engines.add(e);
    // MediaTrackAdded is emitted synchronously inside pc.ontrack in every Room state (RTCEngine.ts:646-651);
    // TrackSubscribed is deferred and is never the first attach (gap G3; SP-01 measured TrackSubscribed leaking a
    // plaintext Firefox frame in 3 of 6 runs and MediaTrackAdded leaking none). Room registers its own
    // MediaTrackAdded listener when it creates the engine (Room.ts:612-628), before it calls setupEngine
    // (Room.ts:534-535, 763-764), and that listener emits TrackSubscribed synchronously (Room.ts:1595, 1703). RTCEngine
    // is a Node `events` emitter (RTCEngine.ts:140), so prependListener puts this attach first: the transform exists
    // before anything else learns of the track.
    const onTrack = (track: MediaStreamTrack, _stream: MediaStream, receiver: RTCRtpReceiver): void => this.attachReceiver(track, receiver);
    e.prependListener(MEDIA_TRACK_ADDED, onTrack);
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
    if (!this.epochSeen || this.failure !== null || this.disposed) {
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
    this.assertUsable();
    if (k.baseKey.length !== 16) throw new Error('E_BAD_OPTIONS: the base key is 16 bytes');
    if (!Number.isInteger(k.selfLeaf) || k.selfLeaf < 0 || k.selfLeaf > 0xffff) throw new Error('E_BAD_OPTIONS: leaf out of range');
    for (const r of k.roster) {
      if (!isDeviceIdentity(r.deviceId) || !Number.isInteger(r.leaf) || r.leaf < 0 || r.leaf > 0xffff) throw new Error('E_BAD_OPTIONS: roster entry');
    }
    // N1: a worker's first epoch must be one its device committed after the worker started (protocol/05 Sender
    // uniqueness). Until the worker confirms an install (epochInstalled), every install is held to the highest
    // minEpoch seen so far, so a failed first install cannot let an older epoch become the worker's first (M1).
    if (!this.epochSeen) {
      if (k.minEpoch > this.minEpochFloor) this.minEpochFloor = k.minEpoch;
      if (k.epoch < this.minEpochFloor) throw new Error('E_NO_EPOCH: the first epoch predates this device’s join or resync commit');
    }
    await this.ready;
    this.assertUsable();
    const roster = new Map<number, string>();
    for (const r of k.roster) roster.set(r.leaf, r.deviceId);
    const baseKey = k.baseKey.slice();
    k.baseKey.fill(0);
    const done = new Promise<void>((resolve, reject) => {
      this.pendingInstalls.set(k.epoch, [...(this.pendingInstalls.get(k.epoch) ?? []), { resolve, reject }]);
    });
    this.post({ kind: 'installEpoch', groupId: k.groupId, epoch: k.epoch, baseKey, selfLeaf: k.selfLeaf, roster: k.roster.map((r) => ({ leaf: r.leaf, deviceId: r.deviceId })) }, [baseKey.buffer]);
    await done;
    this.rosters.set(k.epoch, roster);
    this.refreshRemoteStatus();
  }

  stats(): Promise<DillaMediaStats> {
    try {
      this.assertUsable();
    } catch (err) {
      return Promise.reject(toError(err));
    }
    const id = this.nextStatsId++;
    return new Promise((resolve, reject) => {
      this.pendingStats.set(id, { resolve, reject });
      this.post({ kind: 'stats', id });
    });
  }

  /**
   * M3: the identities, among the rosters this manager holds, whose frames the worker has authenticated at least
   * once (stats.decrypted is counted per KID only after AEAD verification). This, not the roster status event, is
   * the "verified" signal.
   */
  async verifiedIdentities(): Promise<Set<string>> {
    const s = await this.stats();
    const out = new Set<string>();
    for (const [epoch, roster] of this.rosters) {
      for (const [leaf, device] of roster) if ((s.decrypted[kidHex(leaf, epoch)] ?? 0) > 0) out.add(device);
    }
    return out;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    clearTimeout(this.initTimer);
    this.settleAll(new Error('E_NO_EPOCH: the manager is disposed'));
    this.setLocalStatus(false);
    this.post({ kind: 'clearKeys' });
    for (const u of this.unsubscribe.splice(0)) u();
    this.removeAllListeners();
  }

  private assertUsable(): void {
    if (this.disposed) throw new Error('E_NO_EPOCH: the manager is disposed');
    if (this.failure !== null) throw this.failure;
  }

  /** Rejects `ready`, every pending install and every pending stats request with `err`. */
  private settleAll(err: Error): void {
    this.failReady(err);
    for (const list of this.pendingInstalls.values()) for (const p of list) p.reject(err);
    this.pendingInstalls.clear();
    for (const p of this.pendingStats.values()) p.reject(err);
    this.pendingStats.clear();
  }

  /** I2: the worker cannot serve this call any more (load error, deserialisation error, init timeout, no wasm). */
  private failWorker(reason: string): void {
    if (this.failure !== null || this.disposed) return;
    clearTimeout(this.initTimer);
    const err = new Error(`E_WASM: ${reason}`);
    this.failure = err;
    this.log('error', err.message);
    this.settleAll(err);
    this.setLocalStatus(false);
    this.emit('encryptionError', err, this.room?.localParticipant.identity);
  }

  private onWorkerMessage(m: FromWorker): void {
    switch (m.kind) {
      case 'initAck':
        clearTimeout(this.initTimer);
        if (this.failure === null && !this.disposed) this.ack();
        return;
      case 'epochInstalled':
        this.epochSeen = true;
        for (const p of this.pendingInstalls.get(m.epoch) ?? []) p.resolve();
        this.pendingInstalls.delete(m.epoch);
        if (this.pendingLocalEnable) {
          this.pendingLocalEnable = false;
          this.enableLocal();
        }
        return;
      case 'epochRetired':
        this.rosters.delete(m.epoch);
        this.refreshRemoteStatus();
        return;
      case 'stats': {
        const p = this.pendingStats.get(m.id);
        this.pendingStats.delete(m.id);
        p?.resolve(m.data);
        return;
      }
      case 'seqExhausted':
        this.log('warn', `sequence space exhausted on slot ${m.slot} layer ${m.layer}; an MLS Update is needed`);
        return;
      case 'rekeyNeeded':
        this.emit('rekeyNeeded', m.reason);
        return;
      case 'error':
        this.onWorkerError(m);
        return;
      case 'log':
        this.log(m.level, m.msg);
        return;
      case 'attached':
        this.log('debug', `attached ${m.side} ${m.trackId}`);
        return;
    }
  }

  private onWorkerError(m: Extract<FromWorker, { kind: 'error' }>): void {
    this.log('warn', `${m.code}${m.trackId === undefined ? '' : ` on ${m.trackId}`}`);
    if (m.code === 'E_WASM' && m.epoch !== undefined) {
      // M2: an install failure names its epoch; only that epoch's installs fail.
      const err = new Error(`E_WASM: installing epoch ${m.epoch} failed`);
      for (const p of this.pendingInstalls.get(m.epoch) ?? []) p.reject(err);
      this.pendingInstalls.delete(m.epoch);
      this.emit('encryptionError', err, m.participantIdentity);
      return;
    }
    if (m.code === 'E_WASM' && m.trackId === undefined) {
      this.failWorker('the worker has no cipher');
      return;
    }
    // A local track whose frames have no prefix rule (a codec the SFU forced) sends nothing: the UI must know.
    const localCodec = m.code === 'unsupportedCodec' && m.trackId !== undefined && this.localTrackIds.has(m.trackId);
    if (m.code === 'E_NO_EPOCH' || m.code === 'E_BAD_OPTIONS' || m.code === 'E_WASM' || localCodec) {
      this.emit('encryptionError', new Error(m.code), m.participantIdentity);
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
    if (this.failure !== null || this.disposed) return;
    this.setLocalStatus(true);
  }

  private setLocalStatus(v: boolean): void {
    const room = this.room;
    if (room === undefined || this.localEnabled === v) return;
    this.localEnabled = v;
    this.emit('participantEncryptionStatusChanged', v, room.localParticipant);
  }

  private attachReceiver(track: MediaStreamTrack, receiver: RTCRtpReceiver): void {
    try {
      const audio = track.kind === 'audio';
      // Early attach: identity, slot and flag are unknown until TrackSubscribed maps the track; the worker holds
      // every frame of an unmapped track and never renders it.
      const result = this.attach(receiver as unknown as Attachable, {
        dilla: 1, side: 'decode', trackId: track.id, participantIdentity: '', slot: audio ? 0 : 1, codec: audio ? 'opus' : 'vp8',
      }, track);
      if (result !== 'ok') this.fail(new Error(`E_E2EE_REQUIRED: receiver ${track.id} ${result}`), undefined);
    } catch (err) {
      stopTrack(track);
      this.fail(err, undefined);
    }
  }

  private attachSender(sender: RTCRtpSender, track: LocalTrack): void {
    const room = this.room;
    const identity = room?.localParticipant.identity ?? '';
    const media = (track as unknown as { mediaStreamTrack?: MediaStreamTrack }).mediaStreamTrack;
    let failure: Error | null = null;
    let result: AttachResult = 'stopped';
    try {
      this.localTrackIds.add(track.mediaStreamID);
      const kindValue: string = track.kind; // Track.Kind is a string enum; compare its value, not the enum
      const kind = kindValue === 'audio' ? 'audio' : 'video';
      let opts: DillaTransformOptions | DillaBlockOptions;
      try {
        const refused = this.refusePublishFeatures(track);
        if (refused !== null) throw new Error(`E_E2EE_REQUIRED: ${refused} sends media outside the transform`);
        const slot: SlotId = sourceToSlot(track.source);
        if (!kindMatchesSource(kind, track.source)) throw new Error(`E_BAD_OPTIONS: a ${kind} track cannot be published as ${track.source}`);
        // The codec here is informational: the worker encrypts every frame under the rule of the frame's own codec
        // and drops a frame whose codec has none (C1 step 2). track.codec is a label the SFU can choose
        // (LocalParticipant.ts:1052-1060, RTCEngine.ts:1123), so nothing is decided from it.
        const label = (track as unknown as { codec?: string }).codec;
        const codec = kind === 'audio' ? 'opus' : (codecFromMime(`video/${label ?? 'vp8'}`, 'video') ?? 'vp8');
        opts = { dilla: 1, side: 'encode', trackId: track.mediaStreamID, participantIdentity: identity, slot, codec };
      } catch (err) {
        failure = toError(err);
        opts = { dilla: 1, side: 'encode', trackId: track.mediaStreamID, block: true };
      }
      result = this.attach(sender as unknown as Attachable, opts, media);
    } catch (err) {
      failure ??= toError(err);
      stopTrack(media);
      result = 'stopped';
    }
    if (failure === null && result === 'ok') return;
    // The block (or the stopped track) is in place: only now report and unpublish. livekit undoes
    // replaceTrack(null) and track.enabled (LocalTrack.ts:213,412; RemoteTrack.ts:35), so unpublishing is the
    // lever; it awaits the pending publish itself (LocalParticipant.ts:1578-1587).
    this.fail(failure ?? new Error(`E_E2EE_REQUIRED: sender ${track.mediaStreamID} ${result}`), identity);
    queueMicrotask(() => this.unpublish(track, media));
  }

  /**
   * N1 (task 17 re-review): what livekit-client could send outside the encoded-frame transform for this track.
   * - A pre-connect recorder (`hasPreConnectBuffer`, LocalTrack.ts:42-44): livekit starts it from
   *   publishDefaults or per-call options (LocalParticipant.ts:586-598) and, after negotiation, streams the
   *   recording to any participant the SFU flags as an agent over the unencrypted data channel
   *   (LocalParticipant.ts:1385-1444). LocalSenderCreated is emitted inside negotiate() (:1244), and publish() reads
   *   the recording only after negotiate() resolves (:1318 or :1348, then :1389), so stopping the recorder here
   *   leaves getPreConnectBuffer() undefined at :1389 and nothing is streamed. The recording held so far is
   *   cancelled (discarded), never read.
   * - `preConnectBuffer`, `frameMetadata` or `packetTrailer` requested in this track's publish options (a video
   *   track carries them as `publishOptions`, LocalParticipant.ts:1241-1243) or in the live room defaults (an app
   *   that mutated room.options after joinCall built it).
   * Returns the refused feature, after stopping the recorder, or null.
   */
  private refusePublishFeatures(track: LocalTrack): string | null {
    const t = track as unknown as {
      hasPreConnectBuffer?: boolean;
      getPreConnectBuffer?: () => ReadableStream<Uint8Array> | undefined;
      stopPreConnectBuffer?: () => void;
      publishOptions?: Record<string, unknown>;
    };
    if (t.hasPreConnectBuffer === true) {
      try {
        t.getPreConnectBuffer?.()?.cancel('dilla: no pre-connect buffer').catch(() => undefined);
      } catch {
        // a locked stream: stopping the recorder below closes it
      }
      try {
        t.stopPreConnectBuffer?.();
      } catch (err) {
        this.log('error', `stopPreConnectBuffer ${track.mediaStreamID}: ${toError(err).message}`);
      }
      return 'a pre-connect buffer';
    }
    const roomDefaults = (this.room?.localParticipant as unknown as { roomOptions?: { publishDefaults?: Record<string, unknown> } } | undefined)
      ?.roomOptions?.publishDefaults;
    for (const opts of [t.publishOptions, roomDefaults]) {
      if (opts === undefined || opts === null) continue;
      if (opts.preConnectBuffer) return 'a pre-connect buffer';
      if (opts.frameMetadata !== undefined || opts.packetTrailer !== undefined) return 'frame metadata';
    }
    return null;
  }

  private unpublish(track: LocalTrack, media: MediaStreamTrack | undefined): void {
    const lp = this.room?.localParticipant;
    if (lp === undefined) {
      stopTrack(media);
      return;
    }
    Promise.resolve()
      .then(() => lp.unpublishTrack(track))
      .catch((err: unknown) => {
        this.log('warn', `unpublish ${track.mediaStreamID}: ${toError(err).message}`);
        stopTrack(media);
      });
  }

  /**
   * Attaches `opts` (or a block) to a sender or receiver and never leaves it bare: 'ok' is a working dilla
   * transform, 'blocked' a transform that drops every frame, 'stopped' means no transform could be attached and the
   * MediaStreamTrack was stopped.
   */
  private attach(rtp: Attachable, opts: DillaTransformOptions | DillaBlockOptions, media: MediaStreamTrack | undefined): AttachResult {
    try {
      // SP-01 (task 14, measured): on Chromium the PC carries encodedInsertableStreams: true and createEncodedStreams
      // is livekit-client's own path; RTCRtpScriptTransform where createEncodedStreams does not exist (Firefox,
      // Safari). Receivers are reused routinely (30 MediaTrackAdded re-deliveries per Chromium run), so a reused
      // sender or receiver is re-pointed with retarget: createEncodedStreams works once per sender/receiver.
      return typeof rtp.createEncodedStreams === 'function' ? this.attachStreams(rtp, opts, media) : this.attachScript(rtp, opts, media);
    } catch (err) {
      this.log('error', `attach ${opts.trackId}: ${toError(err).message}`);
      stopTrack(media);
      return 'stopped';
    }
  }

  private attachStreams(rtp: Attachable, opts: DillaTransformOptions | DillaBlockOptions, media: MediaStreamTrack | undefined): AttachResult {
    const previous = rtp[ATTACHED];
    if (previous === DEAD) {
      stopTrack(media);
      return 'stopped';
    }
    if (previous !== undefined) {
      this.post({ kind: 'retarget', data: { previousTrackId: previous, ...opts } });
      rtp[ATTACHED] = opts.trackId;
      return isBlock(opts) ? 'blocked' : 'ok';
    }
    let streams: { readable: ReadableStream; writable: WritableStream };
    try {
      streams = (rtp.createEncodedStreams as () => { readable: ReadableStream; writable: WritableStream })();
    } catch (err) {
      // Measured (task 17 review): with livekit's forced encodedInsertableStreams flag a sender whose streams were
      // never created sends 0 bytes and a receiver decodes 0 frames; the track is stopped as well.
      rtp[ATTACHED] = DEAD;
      this.log('error', `createEncodedStreams ${opts.trackId}: ${toError(err).message}`);
      stopTrack(media);
      return 'stopped';
    }
    const { readable, writable } = streams;
    try {
      this.post({ kind: 'attach', data: { ...opts, readable, writable } }, [readable, writable]);
    } catch (err) {
      // The pair never reached the worker: read and discard every frame here, so nothing is ever written.
      rtp[ATTACHED] = DEAD;
      this.log('error', `attach ${opts.trackId}: ${toError(err).message}`);
      readable.pipeTo(new WritableStream()).catch(() => undefined);
      stopTrack(media);
      return 'stopped';
    }
    rtp[ATTACHED] = opts.trackId;
    return isBlock(opts) ? 'blocked' : 'ok';
  }

  private attachScript(rtp: Attachable, opts: DillaTransformOptions | DillaBlockOptions, media: MediaStreamTrack | undefined): AttachResult {
    const Transform = (globalThis as { RTCRtpScriptTransform?: new (worker: Worker, options: unknown) => unknown }).RTCRtpScriptTransform;
    if (Transform === undefined) {
      // No transform API at all (joinCall's isVoiceSupported gate refuses such a browser; this covers a manager
      // used without it): a sender must not publish and a receiver must not render.
      stopTrack(media);
      return 'stopped';
    }
    try {
      rtp.transform = new Transform(this.worker, opts); // a reused sender or receiver simply takes a new transform
      rtp[ATTACHED] = opts.trackId;
      return isBlock(opts) ? 'blocked' : 'ok';
    } catch (err) {
      this.log('error', `RTCRtpScriptTransform ${opts.trackId}: ${toError(err).message}`);
    }
    if (!isBlock(opts)) {
      try {
        rtp.transform = new Transform(this.worker, blockOf(opts));
        rtp[ATTACHED] = opts.trackId;
        return 'blocked';
      } catch (err) {
        this.log('error', `blocking RTCRtpScriptTransform ${opts.trackId}: ${toError(err).message}`);
      }
    }
    stopTrack(media);
    return 'stopped';
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
      return; // never mapped: the worker holds every frame of the track, then drops it
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
    for (const roster of this.rosters.values()) for (const device of roster.values()) if (device === identity) return true;
    return false;
  }

  private updateRemote(p: Participant): void {
    const v = this.inRoster(p.identity);
    if (this.inRosterStatus.get(p.identity) === v) return;
    this.inRosterStatus.set(p.identity, v);
    this.emit('participantEncryptionStatusChanged', v, p);
  }

  private refreshRemoteStatus(): void {
    const room = this.room;
    if (room === undefined) return;
    for (const p of room.remoteParticipants.values()) this.updateRemote(p);
  }

  private fail(err: unknown, identity: string | undefined): void {
    const e = toError(err);
    this.log('error', e.message);
    this.emit('encryptionError', e, identity);
  }

  private post(m: ToWorker, transfer: Transferable[] = []): void {
    this.worker.postMessage(m, transfer);
  }
}
