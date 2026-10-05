import type { Track } from 'livekit-client';
import type { MediaCodec, SlotId } from './protocol';

const DEVICE_IDENTITY = /^[0-9a-f]{32}$/;
const HEX = /^(?:[0-9a-fA-F]{2})*$/;

export const CODEC_NUMBER: Record<MediaCodec, number> = { opus: 0, vp8: 1, vp9: 2, h264: 3 };

export function sourceToSlot(s: Track.Source): SlotId {
  const v: string = s;
  switch (v) {
    case 'microphone': return 0;
    case 'camera': return 1;
    case 'screen_share': return 2;
    case 'screen_share_audio': return 3;
    default: throw new Error(`E_BAD_OPTIONS: track source ${v} has no slot`);
  }
}

export function trackSourceToSlot(s: number): SlotId {
  switch (s) {
    case 2: return 0; // MICROPHONE
    case 1: return 1; // CAMERA
    case 3: return 2; // SCREEN_SHARE
    case 4: return 3; // SCREEN_SHARE_AUDIO
    default: throw new Error(`E_BAD_OPTIONS: TrackSource ${s} has no slot`);
  }
}

/** A LiveKit identity is a device id as 32 lowercase hex; anything else (including `#`) is an unverified stream. */
export function isDeviceIdentity(identity: string): boolean {
  return DEVICE_IDENTITY.test(identity);
}

export function kindMatchesSource(kind: 'audio' | 'video', source: Track.Source): boolean {
  const v: string = source;
  return kind === 'audio' ? v === 'microphone' || v === 'screen_share_audio' : v === 'camera' || v === 'screen_share';
}

/** `mimeTypeToVideoCodecString` is not exported by livekit-client, so this is its one-liner plus the dilla refusals. */
export function codecFromMime(mime: string | undefined, kind: 'audio' | 'video'): MediaCodec | null {
  const sub = mime?.split('/')[1]?.toLowerCase();
  if (kind === 'audio') return sub === 'opus' ? 'opus' : null;
  return sub === 'vp8' || sub === 'vp9' || sub === 'h264' ? sub : null;
}

export function slotKind(slot: SlotId): 'audio' | 'video' {
  return slot === 0 || slot === 3 ? 'audio' : 'video';
}

export function codecKind(codec: MediaCodec): 'audio' | 'video' {
  return codec === 'opus' ? 'audio' : 'video';
}

export function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0 || !HEX.test(hex)) throw new Error('E_BAD_OPTIONS: malformed hex');
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(2 * i, 2 * i + 2), 16);
  return out;
}
