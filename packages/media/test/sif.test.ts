import { describe, expect, it } from 'vitest';
import { hasSifSuffix, OPUS_SILENCE_FRAME } from '../src/worker/sif';

const trailer = (n: number): Uint8Array => new TextEncoder().encode('Zq7'.repeat(20).slice(0, n));

function silenceWith(t: Uint8Array): Uint8Array {
  const f = new Uint8Array(OPUS_SILENCE_FRAME.length + t.length);
  f.set(OPUS_SILENCE_FRAME);
  f.set(t, OPUS_SILENCE_FRAME.length);
  return f;
}

describe('the SIF trailer (DEV-13, SP-13)', () => {
  it('is LiveKit OpusSilenceFrame: 80 bytes starting f8 ff fe', () => {
    expect(OPUS_SILENCE_FRAME.length).toBe(80);
    expect([...OPUS_SILENCE_FRAME.slice(0, 3)]).toEqual([0xf8, 0xff, 0xfe]);
    expect(OPUS_SILENCE_FRAME.slice(3).every((b) => b === 0)).toBe(true);
  });

  it('matches the injected silence for 43-, 44- and 52-byte trailers', () => {
    for (const n of [43, 44, 52]) expect(hasSifSuffix(silenceWith(trailer(n)), trailer(n))).toBe(true);
  });

  it('an empty trailer matches nothing', () => {
    expect(hasSifSuffix(OPUS_SILENCE_FRAME, new Uint8Array(0))).toBe(false);
  });

  it('a frame shorter than the trailer does not match', () => {
    expect(hasSifSuffix(trailer(10), trailer(43))).toBe(false);
  });

  it('a frame whose tail differs in one byte does not match', () => {
    const f = silenceWith(trailer(44));
    f[f.length - 1] ^= 1;
    expect(hasSifSuffix(f, trailer(44))).toBe(false);
  });
});
