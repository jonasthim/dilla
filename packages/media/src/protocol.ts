// dilla-media/1: the main-thread ↔ dilla-media-worker message contract (interfaces.md c.6, verbatim).
// Worker invariants: no enable/disable message; encrypt everything given, pass nothing through; SIF suffix
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
  codec: MediaCodec;
  encryption?: 0 | 1 | 2; // decode: pub.trackInfo.encryption
}

export type ToWorker =
  | { kind: 'init'; v: 1; logLevel: 'error' | 'warn' | 'info' | 'debug'; wasmUrl: string }
  | {
      kind: 'installEpoch';
      groupId: string;
      epoch: bigint;
      baseKey: Uint8Array; // 16 B, buffer transferred
      selfLeaf: number;
      roster: Array<{ leaf: number; deviceId: string /* hex */ }>;
    } // roster per epoch (G14); snapshot taken with the base key before merge
  | { kind: 'clearKeys' }
  | { kind: 'setSifTrailer'; trailer: Uint8Array } // replace; 43-52 B; empty ignored
  | { kind: 'attach'; data: DillaTransformOptions & { readable: ReadableStream; writable: WritableStream } } // Chromium createEncodedStreams path
  | { kind: 'retarget'; data: { previousTrackId: string } & DillaTransformOptions }
  | { kind: 'mapTrack'; trackId: string; participantIdentity: string; slot: SlotId; codec: MediaCodec; encryption: 0 | 1 | 2 } // metadata after early attach
  | { kind: 'detach'; trackId: string }
  | { kind: 'stats'; id: number };

export type FromWorker =
  | { kind: 'initAck'; v: 1; scriptTransform: boolean }
  | { kind: 'epochInstalled'; epoch: bigint }
  | { kind: 'epochRetired'; epoch: bigint }
  | { kind: 'attached'; trackId: string; side: Side }
  | { kind: 'seqExhausted'; slot: SlotId; layer: number } // encoder stopped → manager triggers MLS Update
  | { kind: 'rekeyNeeded'; reason: 'layerSpace' | 'seqExhausted' }
  | { kind: 'error'; code: DropReason | 'E_NO_EPOCH' | 'E_BAD_OPTIONS' | 'E_WASM'; participantIdentity?: string; trackId?: string } // ≤1/s per (code, trackId)
  | { kind: 'stats'; id: number; data: DillaMediaStats }
  | { kind: 'log'; level: 'error' | 'warn' | 'info' | 'debug'; msg: string };

export type DropReason =
  | 'parse' | 'unknownKid' | 'bufferTimeout' | 'aeadFail' | 'foreignLeaf' /* LeafNotInEpoch */ | 'senderMismatch'
  | 'ownKid' | 'slotMismatch' | 'replay' | 'expiredKid' | 'sif' | 'noneFlagged' | 'noVclNal' | 'unsupportedCodec';

export interface DillaMediaStats {
  encrypted: Record<string /* kid hex */, Record<SlotId, number>>;
  decrypted: Record<string, number>; // AEAD-verified only
  dropped: Record<DropReason, number>;
  passedThrough: 0;
  currentEpoch: string;
  knownKids: string[];
  sifTrailerLen: number;
}
// Mirrored on globalThis.__dillaMediaStats (a module-scoped const is invisible to Playwright worker.evaluate; G35).
