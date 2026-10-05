// LiveKit appends the room's SIF trailer (43–52 ASCII bytes, gap G12 constraint 7) to the blank frames its
// down-tracks write, and only for publications whose Encryption is not NONE (subscribedtrack.go:129-133).
// Measured in SP-13 (task 16, docs/spikes/2026-10-sfu-injected-frames.md): audio on mute (51 per 7 s mute),
// audio and video on close (11 Opus frames; 6 VP8 key frames), and audio padding-on-mute for Go subscribers
// only (a browser receiver never gets it). A camera mute injects nothing. The worker tests this suffix before
// it parses any SFrame header: the injected Opus frame starts f8 ff fe 00, which an SFrame parser reads as an
// 8-byte KID, so a parse-first worker would count every injected frame as a header failure (gap G21 fact 9).

/** LiveKit v1.13.7 OpusSilenceFrame (downtrack.go:110-121): f8 ff fe followed by 77 zero bytes. */
export const OPUS_SILENCE_FRAME: Uint8Array = Uint8Array.from([0xf8, 0xff, 0xfe, ...new Array<number>(77).fill(0)]);

export function hasSifSuffix(frame: Uint8Array, trailer: Uint8Array): boolean {
  if (trailer.length === 0 || frame.length < trailer.length) return false;
  const off = frame.length - trailer.length;
  for (let i = 0; i < trailer.length; i++) if (frame[off + i] !== trailer[i]) return false;
  return true;
}
