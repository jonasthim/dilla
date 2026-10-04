import { RoomEvent, SubscriptionError, supportsVP9, type Participant, type Room } from 'livekit-client';
import type { CallCaps } from './presets';

/** The participant attribute dillad writes into the token from the calls request's `vdec` (DEV-07, MD-9). */
export const VDEC_ATTRIBUTE = 'dilla.vdec';

const ORDER = ['vp8', 'h264', 'vp9'] as const;
// Follow-up card: enable only after a VP9 vector and a measured LiveKit run.
const VP9_ENABLED = false;

/** The calls request's `vdec`: what this browser can decode, lowercase, in a fixed order. */
export function localDecodeList(): string {
  const receiver = (globalThis as { RTCRtpReceiver?: { getCapabilities?: (kind: string) => RTCRtpCapabilities | null } }).RTCRtpReceiver;
  const caps = receiver?.getCapabilities?.('video');
  const have = new Set((caps?.codecs ?? []).map((c) => c.mimeType.split('/')[1]?.toLowerCase() ?? ''));
  return ORDER.filter((c) => have.has(c)).join(',');
}

export function decodeListHas(list: string | undefined, codec: 'vp8' | 'h264' | 'vp9'): boolean {
  return (list ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .includes(codec);
}

/**
 * VP9 only when the instance allows it (`livekit.vp9`, default off per F4), this browser can encode
 * it (`supportsVP9()` is false on Firefox and on Safari < 16), and every remote participant's
 * `dilla.vdec` names it. A participant without the attribute counts as "cannot decode".
 */
export function chooseVideoCodec(room: Room, caps: CallCaps, canEncodeVp9: () => boolean = supportsVP9): 'vp8' | 'vp9' {
  if (!VP9_ENABLED) return 'vp8';
  if (!caps.vp9 || !canEncodeVp9()) return 'vp8';
  for (const p of room.remoteParticipants.values()) {
    if (!decodeListHas(p.attributes[VDEC_ATTRIBUTE], 'vp9')) return 'vp8';
  }
  return 'vp9';
}

/**
 * Re-evaluates the rule on every join and attribute change and reports a change of codec; the
 * caller republishes. `TrackSubscriptionFailed(…, SE_CODEC_UNSUPPORTED)` is the backstop for a
 * subscriber whose attribute lied or arrived late: from then on this call publishes VP8.
 */
export function watchVideoCodec(
  room: Room,
  caps: CallCaps,
  onChange: (codec: 'vp8' | 'vp9', why: 'join' | 'attributes' | 'subscription-failed') => void,
  canEncodeVp9: () => boolean = supportsVP9,
): () => void {
  let current = chooseVideoCodec(room, caps, canEncodeVp9);
  let pinnedVp8 = false;
  const evaluate = (why: 'join' | 'attributes') => {
    const next = pinnedVp8 ? 'vp8' : chooseVideoCodec(room, caps, canEncodeVp9);
    if (next !== current) {
      current = next;
      onChange(next, why);
    }
  };
  const onJoin = () => evaluate('join');
  const onAttributes = () => evaluate('attributes');
  const onFailed = (_sid: string, _p: Participant | undefined, reason?: SubscriptionError) => {
    if (reason !== SubscriptionError.SE_CODEC_UNSUPPORTED) return;
    pinnedVp8 = true;
    if (current !== 'vp8') {
      current = 'vp8';
      onChange('vp8', 'subscription-failed');
    }
  };
  room.on(RoomEvent.ParticipantConnected, onJoin);
  room.on(RoomEvent.ParticipantAttributesChanged, onAttributes);
  room.on(RoomEvent.TrackSubscriptionFailed, onFailed);
  return () => {
    room.off(RoomEvent.ParticipantConnected, onJoin);
    room.off(RoomEvent.ParticipantAttributesChanged, onAttributes);
    room.off(RoomEvent.TrackSubscriptionFailed, onFailed);
  };
}
