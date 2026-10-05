import type { DillaBlockOptions, DillaMediaStats, DillaTransformOptions, DropReason, FromWorker, ToWorker } from '../protocol';
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
  /** A blocking transform (DillaBlockOptions): every frame is dropped as `blocked`, whatever else happens. */
  blocked: boolean;
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
const KEY_FRAME_REASONS: ReadonlySet<DropReason> = new Set<DropReason>(['bufferTimeout', 'unknownKid', 'aeadFail', 'expiredKid', 'parse', 'internal']);

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

/**
 * The drop reason of a cipher failure. Only a bare dilla-sframe/1 code is read as one; a wasm trap
 * (RuntimeError "unreachable"), a JS exception or a thrown non-Error is `internal`. Either way the frame is dropped:
 * nothing but a successful encrypt or an authenticated decrypt ever reaches a sink.
 */
function failureReason(err: unknown): DropReason {
  const code = errorCode(err);
  return code.startsWith('E_SFRAME_') ? dropReasonOf(code) : 'internal';
}

function blockedOpts(o: DillaBlockOptions): DillaTransformOptions {
  return { dilla: 1, side: o.side, trackId: o.trackId, participantIdentity: '', slot: 0, codec: 'opus' };
}

const isBlock = (o: DillaTransformOptions | DillaBlockOptions): o is DillaBlockOptions => 'block' in o && o.block === true;

function toArrayBuffer(u8: Uint8Array): ArrayBuffer {
  return u8.byteOffset === 0 && u8.byteLength === u8.buffer.byteLength ? (u8.buffer as ArrayBuffer) : (u8.slice().buffer as ArrayBuffer);
}

/** Every frame goes through here; only a zero-byte audio DTX marker passes without encryption. */
export class Pipeline {
  readonly stats: DillaMediaStats = newStats();
  private readonly tracks = new Map<string, TrackHandle>();
  private readonly mappings = new Map<string, Mapping>();
  private receiver: ReceiverLike;
  private sender: SenderLike | null = null;
  private senderEpoch: bigint | null = null;
  private minNextSenderEpoch = 0n; // N1 across clearKeys: never a second counter space under a used KID
  private selfLeaf = -1;
  private readonly epochs: Array<{ epoch: bigint; leaves: number[]; supersededAt: number | null; groupId: string; selfLeaf: number; roster: Array<{ leaf: number; deviceId: string }>; baseKey: Uint8Array }> = [];
  private droppedEpochFloor: bigint | null = null;
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

  addTrack(o: DillaTransformOptions | DillaBlockOptions, sink: FrameSink, requestKeyFrame?: () => Promise<unknown>): TrackHandle {
    const collision = this.tracks.get(o.trackId)?.opts.side !== undefined && this.tracks.get(o.trackId)?.opts.side !== o.side;
    const blocked = isBlock(o) || collision;
    const opts = blocked ? blockedOpts({ dilla: 1, side: o.side, trackId: o.trackId, block: true }) : o;
    const h: TrackHandle = {
      trackId: opts.trackId, opts, blocked, mapped: !blocked && isMapped(opts), sink, requestKeyFrame,
      fifo: new PendingQueue(), stoppedEpoch: null, lastKeyFrameRequest: Number.NEGATIVE_INFINITY, awaitingKeyFrame: false,
    };
    if (!blocked) this.applyMapping(h);
    if (collision) this.error('E_BAD_OPTIONS', opts.trackId, undefined, undefined, opts.side);
    else this.tracks.set(opts.trackId, h);
    this.deps.post({ kind: 'attached', trackId: opts.trackId, side: opts.side });
    return h;
  }

  frame(h: TrackHandle, frame: EncodedFrameLike): void {
    if (h.blocked) {
      this.drop(h, 'blocked');
      return;
    }
    if (h.opts.side === 'encode') {
      const out = this.encode(h, frame);
      if (out !== null) h.sink.enqueue(out);
      return;
    }
    this.decode(h, frame);
  }

  /**
   * The transform callback caught `err` from frame(): the frame is dropped (it was never enqueued, since every
   * enqueue is the last step of a successful path) and counted, and the stream stays open for the next frame.
   */
  fault(h: TrackHandle, err: unknown): void {
    this.log('warn', `frame on ${h.trackId}: ${errorCode(err)}`);
    this.drop(h, 'internal');
  }

  tick(): void {
    const now = this.deps.now();
    this.receiver.expire(now);
    this.retireExpiredEpochs(now);
    this.refreshEpochStats();
    for (const h of this.tracks.values()) {
      if (h.opts.side !== 'decode') continue;
      if (h.fifo.length > 0) this.drain(h);
      if (h.awaitingKeyFrame) this.requestKeyFrameIfDue(h);
    }
  }

  private retireExpiredEpochs(now: number): void {
    for (let i = this.epochs.length - 1; i >= 0; i--) {
      const e = this.epochs[i];
      if (e.supersededAt !== null && now - e.supersededAt >= RETENTION_MS) {
        this.epochs.splice(i, 1);
        e.baseKey.fill(0);
        this.droppedEpochFloor = this.droppedEpochFloor === null || e.epoch > this.droppedEpochFloor ? e.epoch : this.droppedEpochFloor;
        this.deps.post({ kind: 'epochRetired', epoch: e.epoch });
      }
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
    // C1 step 2 (task 17 fix round 1): the codec is the frame's own, never the attach-time label, which the SFU
    // can choose (JoinResponse.enabledPublishCodecs, LocalParticipant.ts:1052-1060). A frame whose codec has no
    // dilla-sframe/1 prefix rule (AV1, H.265, RED, PCMU, …), or that names none, is dropped (DEV-06 "refuses anything
    // but opus/vp8/vp9/h264"). Measured, task 17 fix round 1: Chromium 153 and Firefox 155 set mimeType on every
    // sender-side audio and video frame (VP8, VP9, H.264, AV1 and Opus).
    const codec = codecFromMime(meta.mimeType, audio ? 'audio' : 'video');
    if (codec === null) {
      this.drop(h, 'unsupportedCodec');
      return null;
    }
    if (audio && codec === 'opus' && frame.data.byteLength === 0) {
      this.stats.emptyFrames.encode += 1;
      return frame;
    }
    if (!audio && frame.data.byteLength === 0) {
      this.drop(h, 'parse');
      return null;
    }
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
        this.drop(h, failureReason(err)); // never the frame: its data is still the plaintext
      }
      return null;
    }
    frame.data = toArrayBuffer(out);
    const row = (this.stats.encrypted[kidHex(this.selfLeaf, epoch)] ??= { 0: 0, 1: 0, 2: 0, 3: 0 });
    row[h.opts.slot] += 1;
    return frame;
  }

  private decode(h: TrackHandle, frame: EncodedFrameLike): void {
    if (frame.data.byteLength > 0 && hasSifSuffix(new Uint8Array(frame.data), this.sif)) {
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
    if (frame.data.byteLength === 0) {
      if (slotKind(h.opts.slot) !== 'audio' || h.opts.codec !== 'opus') return 'parse';
      this.stats.emptyFrames.decode += 1;
      this.stats.emptyFramesByTrack[h.trackId] = (this.stats.emptyFramesByTrack[h.trackId] ?? 0) + 1;
      return 'ok';
    }
    if (!h.mapped) return 'hold';
    const o = h.opts;
    if (o.encryption === undefined || o.encryption === 0) return 'noneFlagged';
    if (!isDeviceIdentity(o.participantIdentity)) return 'senderMismatch';
    if (slotKind(o.slot) !== codecKind(o.codec)) return 'slotMismatch';
    const data = new Uint8Array(frame.data);
    try {
      const mime = frame.getMetadata?.()?.mimeType;
      const codec = mime === undefined ? o.codec : codecFromMime(mime, slotKind(o.slot));
      if (codec === null) return 'unsupportedCodec';
      const out = this.receiver.decrypt(CODEC_NUMBER[codec], data, hexToBytes(o.participantIdentity), o.slot, this.deps.now());
      // N6: decrypt() returned, so the core authenticated the frame and checked that its KID's leaf belongs to
      // o.participantIdentity (expectedDevice): that device is verified. The KID peek is statistics only.
      this.stats.verified[o.participantIdentity] = (this.stats.verified[o.participantIdentity] ?? 0) + 1;
      this.stats.verifiedByTrack[h.trackId] = (this.stats.verifiedByTrack[h.trackId] ?? 0) + 1;
      const kid = peekKidHex(codec, data) ?? '?';
      this.stats.decrypted[kid] = (this.stats.decrypted[kid] ?? 0) + 1;
      this.stats.decryptedByTrack[h.trackId] = (this.stats.decryptedByTrack[h.trackId] ?? 0) + 1;
      const trackKids = (this.stats.decryptedByTrackKid[h.trackId] ??= {});
      trackKids[kid] = (trackKids[kid] ?? 0) + 1;
      frame.data = toArrayBuffer(out);
      return 'ok';
    } catch (err) {
      return errorCode(err) === 'E_SFRAME_UNKNOWN_KID' ? 'hold' : failureReason(err);
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
    const evicted = h.fifo.push(this.deps.now(), frame, frame.data.byteLength).length;
    for (let i = 0; i < evicted; i++) this.drop(h, 'unknownKid');
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
    this.stats.droppedByTrack[h.trackId] = (this.stats.droppedByTrack[h.trackId] ?? 0) + 1;
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
    this.retireExpiredEpochs(now);
    this.refreshEpochStats();
    // Mirror the receiver's install decision before touching the sender or reporting success.
    const newest = this.epochs.reduce<bigint | null>((max, e) => max === null || e.epoch > max ? e.epoch : max, null);
    const held = this.epochs.find((e) => e.epoch === m.epoch);
    if (held !== undefined) {
      const byLeafAndDevice = (a: { leaf: number; deviceId: string }, b: { leaf: number; deviceId: string }): number =>
        a.leaf - b.leaf || a.deviceId.localeCompare(b.deviceId);
      const prior = [...held.roster].sort(byLeafAndDevice);
      const incoming = [...m.roster].sort(byLeafAndDevice);
      const same = held.groupId === m.groupId && held.selfLeaf === m.selfLeaf && prior.length === incoming.length
        && prior.every((r, i) => r.leaf === incoming[i]?.leaf && r.deviceId === incoming[i]?.deviceId)
        && held.baseKey.length === m.baseKey.length && held.baseKey.every((b, i) => b === m.baseKey[i]);
      m.baseKey.fill(0);
      if (same) this.deps.post({ kind: 'epochInstalled', epoch: m.epoch, ...(m.requestId === undefined ? {} : { requestId: m.requestId }) });
      else this.deps.post({ kind: 'error', code: 'E_BAD_OPTIONS', epoch: m.epoch, ...(m.requestId === undefined ? {} : { requestId: m.requestId }) });
      return;
    }
    if (newest !== null && m.epoch < newest && (newest - m.epoch > 255n || (this.droppedEpochFloor !== null && m.epoch <= this.droppedEpochFloor))) {
      const reason = newest - m.epoch > 255n ? 'tooOld' : 'dropped';
      m.baseKey.fill(0);
      this.deps.post({ kind: 'epochIgnored', epoch: m.epoch, reason, ...(m.requestId === undefined ? {} : { requestId: m.requestId }) });
      return;
    }
    // The wasm entry points zero the argument buffer wasm-bindgen copies the key into (M4), not the caller's array:
    // each call gets its own copy here, and every copy and the transferred key are zeroed below, also on a throw.
    const retainedKey = m.baseKey.slice();
    const copies: Uint8Array[] = [];
    const key = (): Uint8Array => {
      const c = m.baseKey.slice();
      copies.push(c);
      return c;
    };
    try {
      const leaves = Uint32Array.from(m.roster.map((r) => r.leaf));
      const devices = new Uint8Array(16 * m.roster.length);
      m.roster.forEach((r, i) => devices.set(hexToBytes(r.deviceId), 16 * i));
      this.receiver.install_epoch(m.epoch, key(), leaves, devices, m.selfLeaf, now);
      if (this.sender === null) {
        if (m.epoch >= this.minNextSenderEpoch) {
          this.sender = this.deps.crypto.newSender(key(), m.selfLeaf, m.epoch, m.epoch); // N1: min_epoch = first epoch seen
          this.senderEpoch = m.epoch;
          this.selfLeaf = m.selfLeaf;
        } else {
          this.log('warn', `no sender for epoch ${m.epoch}: this worker already encrypted in it`);
        }
      } else if (this.senderEpoch === null || m.epoch > this.senderEpoch) {
        this.sender.rekey(key(), m.selfLeaf, m.epoch);
        this.senderEpoch = m.epoch;
        this.selfLeaf = m.selfLeaf;
      }
    } catch (err) {
      retainedKey.fill(0);
      this.deps.post({ kind: 'error', code: 'E_WASM', epoch: m.epoch, ...(m.requestId === undefined ? {} : { requestId: m.requestId }) });
      this.log('error', `installEpoch ${m.epoch}: ${errorCode(err)}`);
      return;
    } finally {
      for (const c of copies) c.fill(0);
      m.baseKey.fill(0);
    }
    const newer = this.epochs.some((e) => e.epoch > m.epoch);
    for (let i = this.epochs.length - 1; i >= 0; i--) {
      const e = this.epochs[i];
      if (e.epoch % 256n === m.epoch % 256n || (!newer && m.epoch - e.epoch > 255n)) {
        this.epochs.splice(i, 1);
        e.baseKey.fill(0);
        this.droppedEpochFloor = this.droppedEpochFloor === null || e.epoch > this.droppedEpochFloor ? e.epoch : this.droppedEpochFloor;
        this.deps.post({ kind: 'epochRetired', epoch: e.epoch });
      } else if (!newer && e.supersededAt === null) {
        e.supersededAt = now;
      }
    }
    this.epochs.push({ epoch: m.epoch, leaves: m.roster.map((r) => r.leaf), supersededAt: newer ? now : null,
      groupId: m.groupId, selfLeaf: m.selfLeaf, roster: m.roster.map((r) => ({ ...r })), baseKey: retainedKey });
    this.refreshEpochStats();
    this.deps.post({ kind: 'epochInstalled', epoch: m.epoch, ...(m.requestId === undefined ? {} : { requestId: m.requestId }) });
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
    for (const e of this.epochs) e.baseKey.fill(0);
    this.epochs.length = 0;
    this.droppedEpochFloor = null;
    this.refreshEpochStats();
    for (const h of this.tracks.values()) this.dropHeld(h);
  }

  /**
   * Re-points the handle of a reused createEncodedStreams sender or receiver. Full options upgrade a blocked handle;
   * block options, or options for the other side, block it.
   */
  private retarget(previousTrackId: string, o: DillaTransformOptions | DillaBlockOptions): void {
    const h = this.tracks.get(previousTrackId);
    if (h === undefined) {
      this.error('E_BAD_OPTIONS', o.trackId);
      return;
    }
    this.tracks.delete(previousTrackId);
    this.dropHeld(h);
    const block = isBlock(o) || o.side !== h.opts.side;
    if (!isBlock(o) && o.side !== h.opts.side) this.error('E_BAD_OPTIONS', o.trackId);
    const opts = isBlock(o) ? blockedOpts(o) : block ? blockedOpts({ dilla: 1, side: h.opts.side, trackId: o.trackId, block: true }) : o;
    h.trackId = opts.trackId;
    h.opts = opts;
    h.blocked = block;
    h.mapped = !block && isMapped(opts);
    h.stoppedEpoch = null;
    h.awaitingKeyFrame = false;
    if (!block) this.applyMapping(h);
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
    for (const _ of h.fifo.clear()) {
      this.stats.dropped.bufferTimeout += 1;
      this.stats.droppedByTrack[h.trackId] = (this.stats.droppedByTrack[h.trackId] ?? 0) + 1;
    }
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

  private error(code: ErrorCode, trackId?: string, participantIdentity?: string, epoch?: bigint, side?: 'encode' | 'decode'): void {
    const identity = participantIdentity === '' ? undefined : participantIdentity;
    const errorSide = side ?? (trackId === undefined ? undefined : this.tracks.get(trackId)?.opts.side);
    if (epoch !== undefined) {
      // Never rate-limited: the manager settles the pending installEpoch of exactly this epoch with it.
      this.deps.post({ kind: 'error', code, trackId, side: errorSide, participantIdentity: identity, epoch });
      return;
    }
    const key = `${code}:${trackId ?? ''}`;
    const now = this.deps.now();
    const last = this.lastError.get(key);
    if (last !== undefined && now - last < ERROR_INTERVAL_MS) return;
    this.lastError.set(key, now);
    this.deps.post({ kind: 'error', code, trackId, side: errorSide, participantIdentity: identity });
  }

  private log(level: 'error' | 'warn' | 'info' | 'debug', msg: string): void {
    this.deps.post({ kind: 'log', level, msg });
  }
}

function isMapped(opts: DillaTransformOptions): boolean {
  return opts.side === 'encode' || (opts.participantIdentity !== '' && opts.encryption !== undefined);
}
