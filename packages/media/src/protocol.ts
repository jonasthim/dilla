// dilla-media/1: the main-thread ↔ dilla-media-worker message contract (interfaces.md c.6, verbatim).
// Worker invariants: no enable/disable message; encrypt everything given, pass nothing through; the send codec is
// each frame's own (getMetadata().mimeType), and a frame with no prefix rule is dropped; options the worker does
// not recognise, and DillaBlockOptions, block the transform (every frame discarded); SIF suffix
// test before SFrame parse; a NONE-flagged publication drops all frames; GCM and CUSTOM both mean
// dilla-sframe/1 (never test == GCM); seq per (epoch, KID, slot, layer) survives transform re-creation.
// This is not livekit-client's E2EE worker protocol: livekit-client posts nothing to a custom manager's worker
// (DEV-12), and the worker ignores every message that is not one of these shapes (setKey, ratchetRequest,
// enable, encode, decode, livekit's own setSifTrailer, …).

export type Side = 'encode' | 'decode';
export type MediaCodec = 'opus' | 'vp8' | 'h264' | 'vp9'; // av1/h265 refused
export type SlotId = 0 | 1 | 2 | 3; // Microphone, Camera, ScreenVideo, ScreenAudio (ctr.rs:13-19)
// Track.Source → slot: 'microphone'→0, 'camera'→1, 'screen_share'→2, 'screen_share_audio'→3, 'unknown' → refuse
// LiveKit TrackSource enum → slot: MICROPHONE(2)→0, CAMERA(1)→1, SCREEN_SHARE(3)→2, SCREEN_SHARE_AUDIO(4)→3, UNKNOWN(0)→reject

export interface DillaTransformOptions {
  dilla: 1;
  side: Side;
  trackId: string;
  participantIdentity: string; // device_id hex, 32 lowercase
  slot: SlotId;
  // decode: the publication's codec. encode: informational only; the encoder takes the codec of every frame from
  // that frame's own getMetadata().mimeType and drops a frame with no prefix rule (C1, task 17 fix round 1).
  codec: MediaCodec;
  encryption?: 0 | 1 | 2; // decode: pub.trackInfo.encryption
}

/**
 * A transform that never forwards a frame: the manager attaches it wherever it cannot build DillaTransformOptions
 * (an unknown source, a kind that does not match its source), so no sender or receiver it has seen is ever left
 * without a transform. The worker reads and discards every frame (counted as `blocked`). Any transform options the
 * worker does not recognise are treated the same way. On the createEncodedStreams path a later `retarget` with
 * full options may upgrade a blocked handle of a reused sender; a `retarget` with block options blocks one.
 */
export interface DillaBlockOptions {
  dilla: 1;
  side: Side;
  trackId: string;
  block: true;
}

export type ToWorker =
  | { kind: 'init'; v: 1; logLevel: 'error' | 'warn' | 'info' | 'debug'; wasmUrl: string }
  | {
      kind: 'installEpoch';
      requestId?: number; // correlates concurrent installs of the same epoch
      groupId: string;
      epoch: bigint;
      baseKey: Uint8Array; // 16 B, buffer transferred
      selfLeaf: number;
      roster: Array<{ leaf: number; deviceId: string /* hex */ }>;
    } // roster per epoch (G14); snapshot taken with the base key before merge
  | { kind: 'clearKeys' }
  | { kind: 'setSifTrailer'; trailer: Uint8Array } // replace; 43-52 B; empty ignored
  | { kind: 'attach'; data: (DillaTransformOptions | DillaBlockOptions) & { readable: ReadableStream; writable: WritableStream } } // Chromium createEncodedStreams path
  | { kind: 'retarget'; data: { previousTrackId: string } & (DillaTransformOptions | DillaBlockOptions) }
  | { kind: 'mapTrack'; trackId: string; participantIdentity: string; slot: SlotId; codec: MediaCodec; encryption: 0 | 1 | 2 } // metadata after early attach
  | { kind: 'detach'; trackId: string }
  | { kind: 'stats'; id: number };

export type FromWorker =
  | { kind: 'initAck'; v: 1; scriptTransform: boolean }
  | { kind: 'epochInstalled'; epoch: bigint; requestId?: number }
  | { kind: 'epochIgnored'; epoch: bigint; reason: 'tooOld' | 'dropped'; requestId?: number }
  | { kind: 'epochRetired'; epoch: bigint }
  | { kind: 'attached'; trackId: string; side: Side }
  | { kind: 'seqExhausted'; slot: SlotId; layer: number } // encoder stopped → manager triggers MLS Update
  | { kind: 'rekeyNeeded'; reason: 'layerSpace' | 'seqExhausted' }
  // ≤1/s per (code, trackId). `epoch` names the installEpoch that failed; an E_WASM with neither `trackId` nor
  // `epoch` is worker-wide (the wasm never loaded): the manager then fails every pending call.
  | { kind: 'error'; code: DropReason | 'E_NO_EPOCH' | 'E_BAD_OPTIONS' | 'E_WASM'; participantIdentity?: string; trackId?: string; side?: Side; epoch?: bigint; requestId?: number }
  | { kind: 'stats'; id: number; data: DillaMediaStats }
  | { kind: 'log'; level: 'error' | 'warn' | 'info' | 'debug'; msg: string };

export type DropReason =
  | 'parse' | 'unknownKid' | 'bufferTimeout' | 'aeadFail' | 'foreignLeaf' /* LeafNotInEpoch */ | 'senderMismatch'
  | 'ownKid' | 'slotMismatch' | 'replay' | 'expiredKid' | 'sif' | 'noneFlagged' | 'noVclNal' | 'unsupportedCodec'
  | 'blocked' /* a frame of a blocking transform */ | 'internal' /* the pipeline threw on this frame */;

export interface DillaMediaStats {
  encrypted: Record<string /* kid hex */, Record<SlotId, number>>;
  decrypted: Record<string, number>; // AEAD-verified only; keyed by a JS peek of the KID, for statistics only
  decryptedByTrack: Record<string, number>; // AEAD-verified frames by receiver MediaStreamTrack.id
  decryptedByTrackKid: Record<string, Record<string, number>>; // authenticated KIDs on each receiver track
  verifiedByTrack: Record<string, number>; // authenticated frames on each receiver track
  // N6: device_id hex → frames the cipher authenticated AND bound to that device (the decode handle's mapped
  // participantIdentity is the expectedDevice of the decrypt). The only input of verifiedIdentities().
  verified: Record<string, number>;
  emptyFrames: Record<Side, number>; // zero-byte audio DTX markers passed through on each side
  emptyFramesByTrack: Record<string, number>; // decoded zero-byte audio by receiver MediaStreamTrack.id
  // Both sides: an encoder counts unsupportedCodec (a frame whose own codec has no prefix rule), blocked and internal.
  dropped: Record<DropReason, number>;
  droppedByTrack: Record<string, number>; // frames refused on each receiver or sender track
  passedThrough: 0;
  currentEpoch: string;
  knownKids: string[];
  sifTrailerLen: number;
}
// Mirrored on globalThis.__dillaMediaStats (a module-scoped const is invisible to Playwright worker.evaluate; G35).
