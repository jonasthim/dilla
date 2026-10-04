import type { DillaMediaStats, DillaTransformOptions, DropReason, FromWorker, MediaCodec, ToWorker } from '../protocol';
import { CODEC_NUMBER, codecFromMime, codecKind, hexToBytes, isDeviceIdentity, slotKind } from '../slots';
import { LayerAllocator } from './layers';
import { PendingQueue } from './pending';
import { hasSifSuffix } from './sif';
import { kidHex, newStats, peekKidHex } from './stats';

export interface EncodedFrameLike {
  data: ArrayBuffer;
  readonly type?: 'key' | 'delta' | 'empty';
  getMetadata(): { synchronizationSource?: number; spatialIndex?: number; mimeType?: string };
}
export interface FrameSink { enqueue(frame: EncodedFrameLike): void }
export interface SenderLike {
  encrypt(codec: number, slot: number, layer: number, frame: Uint8Array): Uint8Array;
  rekey(baseKey: Uint8Array, leafIndex: number, epoch: bigint): void;
  exhausted(): boolean;
  free(): void;
}
export interface ReceiverLike {
  install_epoch(epoch: bigint, baseKey: Uint8Array, rosterLeaves: Uint32Array, rosterDevices: Uint8Array, ownLeaf: number, nowMs: number): void;
  expire(nowMs: number): void;
  decrypt(codec: number, frame: Uint8Array, expectedDevice: Uint8Array, expectedSlot: number, nowMs: number): Uint8Array;
  free(): void;
}
export interface CryptoFactory {
  newSender(baseKey: Uint8Array, leafIndex: number, epoch: bigint, minEpoch: bigint): SenderLike;
  newReceiver(): ReceiverLike;
}
export interface TrackHandle {
  trackId: string;
  opts: DillaTransformOptions;
  mapped: boolean;
  sink: FrameSink;
  requestKeyFrame?: () => Promise<unknown>;
  fifo: PendingQueue<EncodedFrameLike>;
  stoppedEpoch: bigint | null;
  lastKeyFrameRequest: number;
  /** SP-02: a decrypt-related video drop happened and no decrypted key frame has been enqueued since. */
  awaitingKeyFrame: boolean;
}

export const RETENTION_MS = 10_000; // protocol/05 Rotation: every epoch superseded < 10 s ago is kept
// SP-02 (task 15, measured): after a decrypt-related video drop, sendKeyFrameRequest() is repeated at most every
// 500 ms (LiveKit's layer-0 PLI throttle) until a decrypted key frame is enqueued on the track. A single request
// sent < 500 ms after another receiver's PLI is dropped by the SFU and recovery fell back to ~2.5 s; repeating
// recovered at p50 536 ms.
export const KEY_FRAME_REQUEST_INTERVAL_MS = 500;
const ERROR_INTERVAL_MS = 1_000; // c.6: errors are posted at most once per second per (code, trackId)
// livekit-client 2.22.3 emits TrackSubscribed from Room's own MediaTrackAdded listener, which runs before the
// manager's, so a mapTrack can precede its attach (measured in Chromium, task 17). Mappings are kept per track id
// until detached; the bound only stops a stream of never-attached ids from growing the map.
const MAX_MAPPINGS = 512;
// Drops after which a video decoder stalls until a key frame; never sif or noneFlagged (SP-02 decision 2).
const KEY_FRAME_REASONS: ReadonlySet<DropReason> = new Set<DropReason>(['bufferTimeout', 'unknownKid', 'aeadFail', 'expiredKid', 'parse']);

type ErrorCode = DropReason | 'E_NO_EPOCH' | 'E_BAD_OPTIONS' | 'E_WASM';
type Mapping = Pick<Extract<ToWorker, { kind: 'mapTrack' }>, 'participantIdentity' | 'slot' | 'codec' | 'encryption'>;
type Outcome = 'ok' | 'hold' | DropReason;

export function dropReasonOf(code: string): DropReason {
  switch (code) {
    case 'E_SFRAME_AUTH': return 'aeadFail';
    case 'E_SFRAME_LEAF_NOT_IN_EPOCH': return 'foreignLeaf';
    case 'E_SFRAME_SENDER_MISMATCH': return 'senderMismatch';
    case 'E_SFRAME_OWN_KID': return 'ownKid';
    case 'E_SFRAME_SLOT_MISMATCH': return 'slotMismatch';
    case 'E_SFRAME_REPLAY': return 'replay';
    case 'E_SFRAME_STALE_EPOCH': return 'expiredKid';
    case 'E_SFRAME_UNKNOWN_KID': return 'unknownKid';
    case 'E_SFRAME_NO_VCL_NAL': return 'noVclNal';
    case 'E_SFRAME_UNSUPPORTED_CODEC': return 'unsupportedCodec';
    // TRUNCATED_HEADER, NON_MINIMAL_HEADER, NON_CANONICAL_KID, TRUNCATED_FRAME, MALFORMED_PREFIX,
    // NON_CANONICAL_SPS, LAYER_RANGE, LEAF_RANGE and anything unexpected: the frame could not be read as
    // dilla-sframe/1.
    default: return 'parse';
  }
}

const errorCode = (err: unknown): string => (err instanceof Error ? err.message : String(err));

function toArrayBuffer(u8: Uint8Array): ArrayBuffer {
  return u8.byteOffset === 0 && u8.byteLength === u8.buffer.byteLength ? (u8.buffer as ArrayBuffer) : (u8.slice().buffer as ArrayBuffer);
}

/** Every frame a dilla call carries goes through here; nothing is ever passed through unencrypted. */
export class Pipeline {
  readonly stats: DillaMediaStats = newStats();
  private readonly tracks = new Map<string, TrackHandle>();
  private readonly mappings = new Map<string, Mapping>();
  private receiver: ReceiverLike;
  private sender: SenderLike | null = null;
  private senderEpoch: bigint | null = null;
  private minNextSenderEpoch = 0n; // N1 across clearKeys: never a second counter space under a used KID
  private selfLeaf = -1;
  private readonly epochs: Array<{ epoch: bigint; leaves: number[]; supersededAt: number | null }> = [];
  private sif = new Uint8Array(0);
  private readonly layers = new LayerAllocator();
  private readonly layerSpaceReported = new Set<string>();
  private readonly lastError = new Map<string, number>();
  private readonly deps: { crypto: CryptoFactory; post: (m: FromWorker) => void; now: () => number };

  constructor(deps: { crypto: CryptoFactory; post: (m: FromWorker) => void; now: () => number }) {
    this.deps = deps;
    this.receiver = deps.crypto.newReceiver();
    (globalThis as { __dillaMediaStats?: DillaMediaStats }).__dillaMediaStats = this.stats;
  }

  handle(m: Exclude<ToWorker, { kind: 'init' } | { kind: 'attach' }>): void {
    switch (m.kind) {
      case 'installEpoch': this.installEpoch(m); return;
      case 'clearKeys': this.clearKeys(); return;
      case 'setSifTrailer':
        if (m.trailer.length > 0) {
          this.sif = m.trailer.slice(); // replace, never append (SP-13)
          this.stats.sifTrailerLen = this.sif.length;
        }
        return;
      case 'retarget': {
        const { previousTrackId, ...opts } = m.data;
        this.retarget(previousTrackId, opts);
        return;
      }
      case 'mapTrack': this.mapTrack(m); return;
      case 'detach': this.detach(m.trackId); return;
      case 'stats': this.deps.post({ kind: 'stats', id: m.id, data: this.stats }); return;
    }
  }

  addTrack(opts: DillaTransformOptions, sink: FrameSink, requestKeyFrame?: () => Promise<unknown>): TrackHandle {
    const h: TrackHandle = {
      trackId: opts.trackId, opts, mapped: isMapped(opts), sink, requestKeyFrame,
      fifo: new PendingQueue(), stoppedEpoch: null, lastKeyFrameRequest: Number.NEGATIVE_INFINITY, awaitingKeyFrame: false,
    };
    this.applyMapping(h);
    this.tracks.set(opts.trackId, h);
    this.deps.post({ kind: 'attached', trackId: opts.trackId, side: opts.side });
    return h;
  }

  frame(h: TrackHandle, frame: EncodedFrameLike): void {
    if (h.opts.side === 'encode') {
      const out = this.encode(h, frame);
      if (out !== null) h.sink.enqueue(out);
      return;
    }
    this.decode(h, frame);
  }

  tick(): void {
    const now = this.deps.now();
    this.receiver.expire(now);
    for (let i = this.epochs.length - 1; i >= 0; i--) {
      const e = this.epochs[i];
      if (e.supersededAt !== null && now - e.supersededAt >= RETENTION_MS) {
        this.epochs.splice(i, 1);
        this.deps.post({ kind: 'epochRetired', epoch: e.epoch });
      }
    }
    this.refreshEpochStats();
    for (const h of this.tracks.values()) {
      if (h.opts.side !== 'decode') continue;
      if (h.fifo.length > 0) this.drain(h);
      if (h.awaitingKeyFrame) this.requestKeyFrameIfDue(h);
    }
  }

  private encode(h: TrackHandle, frame: EncodedFrameLike): EncodedFrameLike | null {
    const sender = this.sender;
    const epoch = this.senderEpoch;
    if (sender === null || epoch === null) {
      this.error('E_NO_EPOCH', h.trackId);
      return null;
    }
    if (h.stoppedEpoch === epoch) return null;
    const meta = frame.getMetadata();
    const audio = slotKind(h.opts.slot) === 'audio';
    const codec: MediaCodec = audio ? 'opus' : (codecFromMime(meta.mimeType, 'video') ?? h.opts.codec);
    const kid = (BigInt(this.selfLeaf) << 8n) | (epoch & 0xffn);
    let layer = 0;
    if (!audio) {
      const l = this.layers.layerFor(kid, h.opts.slot, meta.synchronizationSource, meta.spatialIndex);
      if (l === null) {
        const key = `${kid}:${h.opts.slot}`;
        if (!this.layerSpaceReported.has(key)) {
          this.layerSpaceReported.add(key);
          this.deps.post({ kind: 'rekeyNeeded', reason: 'layerSpace' });
        }
        return null;
      }
      layer = l;
    }
    let out: Uint8Array;
    try {
      out = sender.encrypt(CODEC_NUMBER[codec], h.opts.slot, layer, new Uint8Array(frame.data));
    } catch (err) {
      const code = errorCode(err);
      if (code === 'E_SFRAME_COUNTER_EXHAUSTED') {
        h.stoppedEpoch = epoch;
        this.deps.post({ kind: 'seqExhausted', slot: h.opts.slot, layer });
        this.deps.post({ kind: 'rekeyNeeded', reason: 'seqExhausted' });
      } else {
        this.log('warn', `encrypt ${h.trackId}: ${code}`);
      }
      return null;
    }
    frame.data = toArrayBuffer(out);
    const row = (this.stats.encrypted[kidHex(this.selfLeaf, epoch)] ??= { 0: 0, 1: 0, 2: 0, 3: 0 });
    row[h.opts.slot] += 1;
    return frame;
  }

  private decode(h: TrackHandle, frame: EncodedFrameLike): void {
    if (hasSifSuffix(new Uint8Array(frame.data), this.sif)) {
      this.drop(h, 'sif');
      return;
    }
    if (h.fifo.length > 0) {
      this.hold(h, frame);
      this.drain(h);
      return;
    }
    const outcome = this.process(h, frame);
    if (outcome === 'ok') this.deliver(h, frame);
    else if (outcome === 'hold') this.hold(h, frame);
    else this.drop(h, outcome);
  }

  private process(h: TrackHandle, frame: EncodedFrameLike): Outcome {
    if (!h.mapped) return 'hold';
    const o = h.opts;
    if (o.encryption === undefined || o.encryption === 0) return 'noneFlagged';
    if (!isDeviceIdentity(o.participantIdentity)) return 'senderMismatch';
    if (slotKind(o.slot) !== codecKind(o.codec)) return 'slotMismatch';
    const data = new Uint8Array(frame.data);
    try {
      const out = this.receiver.decrypt(CODEC_NUMBER[o.codec], data, hexToBytes(o.participantIdentity), o.slot, this.deps.now());
      const kid = peekKidHex(o.codec, data) ?? '?';
      this.stats.decrypted[kid] = (this.stats.decrypted[kid] ?? 0) + 1;
      frame.data = toArrayBuffer(out);
      return 'ok';
    } catch (err) {
      const code = errorCode(err);
      return code === 'E_SFRAME_UNKNOWN_KID' ? 'hold' : dropReasonOf(code);
    }
  }

  /** Enqueues a decrypted frame; a decrypted key frame ends a key-frame request episode (SP-02). */
  private deliver(h: TrackHandle, frame: EncodedFrameLike): void {
    h.sink.enqueue(frame);
    if (!h.awaitingKeyFrame) return;
    if (frame.type === 'key') h.awaitingKeyFrame = false;
    else this.requestKeyFrameIfDue(h);
  }

  private hold(h: TrackHandle, frame: EncodedFrameLike): void {
    if (h.fifo.push(this.deps.now(), frame) !== undefined) this.drop(h, 'unknownKid');
  }

  private drain(h: TrackHandle): void {
    const now = this.deps.now();
    for (let head = h.fifo.peek(); head !== undefined; head = h.fifo.peek()) {
      const outcome = this.process(h, head);
      if (outcome === 'hold') {
        if (!h.fifo.headExpired(now)) return;
        h.fifo.shift();
        this.drop(h, 'bufferTimeout');
        continue;
      }
      h.fifo.shift();
      if (outcome === 'ok') this.deliver(h, head);
      else this.drop(h, outcome);
    }
  }

  private drop(h: TrackHandle, reason: DropReason): void {
    this.stats.dropped[reason] += 1;
    if (reason !== 'sif') this.error(reason, h.trackId, h.opts.participantIdentity);
    if (KEY_FRAME_REASONS.has(reason) && slotKind(h.opts.slot) === 'video' && h.requestKeyFrame !== undefined) {
      h.awaitingKeyFrame = true;
      this.requestKeyFrameIfDue(h);
    }
  }

  private requestKeyFrameIfDue(h: TrackHandle): void {
    if (h.requestKeyFrame === undefined) return;
    const now = this.deps.now();
    if (now - h.lastKeyFrameRequest < KEY_FRAME_REQUEST_INTERVAL_MS) return;
    h.lastKeyFrameRequest = now;
    h.requestKeyFrame().catch(() => undefined); // resolves without sending once detached; never fatal
  }

  private installEpoch(m: Extract<ToWorker, { kind: 'installEpoch' }>): void {
    const now = this.deps.now();
    try {
      const leaves = Uint32Array.from(m.roster.map((r) => r.leaf));
      const devices = new Uint8Array(16 * m.roster.length);
      m.roster.forEach((r, i) => devices.set(hexToBytes(r.deviceId), 16 * i));
      this.receiver.install_epoch(m.epoch, m.baseKey, leaves, devices, m.selfLeaf, now);
      if (this.sender === null) {
        if (m.epoch >= this.minNextSenderEpoch) {
          this.sender = this.deps.crypto.newSender(m.baseKey, m.selfLeaf, m.epoch, m.epoch); // N1: min_epoch = first epoch seen
          this.senderEpoch = m.epoch;
          this.selfLeaf = m.selfLeaf;
        } else {
          this.log('warn', `no sender for epoch ${m.epoch}: this worker already encrypted in it`);
        }
      } else if (this.senderEpoch === null || m.epoch > this.senderEpoch) {
        this.sender.rekey(m.baseKey, m.selfLeaf, m.epoch);
        this.senderEpoch = m.epoch;
        this.selfLeaf = m.selfLeaf;
      }
    } catch (err) {
      this.error('E_WASM');
      this.log('error', `installEpoch ${m.epoch}: ${errorCode(err)}`);
      return;
    } finally {
      m.baseKey.fill(0);
    }
    if (!this.epochs.some((e) => e.epoch === m.epoch)) {
      const newer = this.epochs.some((e) => e.epoch > m.epoch);
      for (const e of this.epochs) if (e.supersededAt === null && e.epoch < m.epoch) e.supersededAt = now;
      this.epochs.push({ epoch: m.epoch, leaves: m.roster.map((r) => r.leaf), supersededAt: newer ? now : null });
    }
    this.refreshEpochStats();
    this.deps.post({ kind: 'epochInstalled', epoch: m.epoch });
    for (const h of this.tracks.values()) if (h.opts.side === 'decode') this.drain(h);
  }

  private clearKeys(): void {
    this.receiver.free();
    this.receiver = this.deps.crypto.newReceiver();
    if (this.sender !== null && this.senderEpoch !== null) this.minNextSenderEpoch = this.senderEpoch + 1n;
    this.sender?.free();
    this.sender = null;
    this.senderEpoch = null;
    this.selfLeaf = -1;
    this.epochs.length = 0;
    this.refreshEpochStats();
    for (const h of this.tracks.values()) this.dropHeld(h);
  }

  private retarget(previousTrackId: string, opts: DillaTransformOptions): void {
    const h = this.tracks.get(previousTrackId);
    if (h === undefined) {
      this.error('E_BAD_OPTIONS', opts.trackId);
      return;
    }
    this.tracks.delete(previousTrackId);
    this.dropHeld(h);
    h.trackId = opts.trackId;
    h.opts = opts;
    h.mapped = isMapped(opts);
    h.stoppedEpoch = null;
    h.awaitingKeyFrame = false;
    this.applyMapping(h);
    this.tracks.set(opts.trackId, h);
  }

  private mapTrack(m: Extract<ToWorker, { kind: 'mapTrack' }>): void {
    this.mappings.delete(m.trackId);
    this.mappings.set(m.trackId, { participantIdentity: m.participantIdentity, slot: m.slot, codec: m.codec, encryption: m.encryption });
    if (this.mappings.size > MAX_MAPPINGS) this.mappings.delete(this.mappings.keys().next().value as string);
    const h = this.tracks.get(m.trackId);
    if (h === undefined || h.opts.side !== 'decode') return; // attached later: addTrack or retarget applies it
    this.applyMapping(h);
    this.drain(h);
  }

  /** A decode handle takes the publication's device, slot, codec and flag from TrackSubscribed, whichever came first. */
  private applyMapping(h: TrackHandle): void {
    if (h.opts.side !== 'decode') return;
    const m = this.mappings.get(h.trackId);
    if (m === undefined) return;
    h.opts = { ...h.opts, participantIdentity: m.participantIdentity, slot: m.slot, codec: m.codec, encryption: m.encryption };
    h.mapped = true;
  }

  private detach(trackId: string): void {
    this.mappings.delete(trackId);
    const h = this.tracks.get(trackId);
    if (h === undefined) return;
    if (h.opts.side === 'decode') h.mapped = false;
    h.awaitingKeyFrame = false;
    this.dropHeld(h);
  }

  private dropHeld(h: TrackHandle): void {
    this.stats.dropped.bufferTimeout += h.fifo.clear().length;
  }

  private refreshEpochStats(): void {
    let current: bigint | null = null;
    const kids: string[] = [];
    for (const e of this.epochs) {
      if (current === null || e.epoch > current) current = e.epoch;
      for (const leaf of e.leaves) kids.push(kidHex(leaf, e.epoch));
    }
    this.stats.currentEpoch = current === null ? '' : current.toString();
    this.stats.knownKids = kids;
  }

  private error(code: ErrorCode, trackId?: string, participantIdentity?: string): void {
    const key = `${code}:${trackId ?? ''}`;
    const now = this.deps.now();
    const last = this.lastError.get(key);
    if (last !== undefined && now - last < ERROR_INTERVAL_MS) return;
    this.lastError.set(key, now);
    this.deps.post({ kind: 'error', code, trackId, participantIdentity: participantIdentity === '' ? undefined : participantIdentity });
  }

  private log(level: 'error' | 'warn' | 'info' | 'debug', msg: string): void {
    this.deps.post({ kind: 'log', level, msg });
  }
}

function isMapped(opts: DillaTransformOptions): boolean {
  return opts.side === 'encode' || (opts.participantIdentity !== '' && opts.encryption !== undefined);
}
