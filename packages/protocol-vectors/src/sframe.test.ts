import { describe, it, expect } from 'vitest';
import {
  kid, deriveFrameKeys, counter, nonce, encodeSframeHeader, SUITE, decodeSframeHeader, prefixLen, canonicalizeH264,
  rbspEscape, rbspUnescape, trailingZeros, encryptFrame, openFrame, protect, unprotect, SframeError, parseDillaHeader, type Codec,
} from './sframe.ts';
import { hex, fromHex, concat } from './bytes.ts';

/** The code a refusal carries, or 'accepted'. */
async function codeOf(f: () => unknown): Promise<string> {
  try { await f(); return 'accepted'; } catch (e) { if (e instanceof SframeError) return e.code; throw e; }
}

describe('the frame cipher reference (protocol/05 "Frame format")', () => {
  // RFC 9605 appendix C.1, copied from https://www.rfc-editor.org/rfc/rfc9605.txt: every KID the
  // appendix uses with CTR 0, every CTR with KID 0, and max/max (34 of its 289 headers).
  const RFC_C1_SAMPLE: Array<[string, string, string]> = [
    ['0', '0', '00'], ['0', '1', '01'], ['0', '255', '08ff'], ['0', '256', '090100'], ['0', '65535', '09ffff'],
    ['0', '65536', '0a010000'], ['0', '16777215', '0affffff'], ['0', '16777216', '0b01000000'], ['0', '4294967295', '0bffffffff'],
    ['0', '4294967296', '0c0100000000'], ['0', '1099511627775', '0cffffffffff'], ['0', '1099511627776', '0d010000000000'],
    ['0', '281474976710655', '0dffffffffffff'], ['0', '281474976710656', '0e01000000000000'], ['0', '72057594037927935', '0effffffffffffff'],
    ['0', '72057594037927936', '0f0100000000000000'], ['0', '18446744073709551615', '0fffffffffffffffff'],
    ['1', '0', '10'], ['255', '0', '80ff'], ['256', '0', '900100'], ['65535', '0', '90ffff'], ['65536', '0', 'a0010000'],
    ['16777215', '0', 'a0ffffff'], ['16777216', '0', 'b001000000'], ['4294967295', '0', 'b0ffffffff'], ['4294967296', '0', 'c00100000000'],
    ['1099511627775', '0', 'c0ffffffffff'], ['1099511627776', '0', 'd0010000000000'], ['281474976710655', '0', 'd0ffffffffffff'],
    ['281474976710656', '0', 'e001000000000000'], ['72057594037927935', '0', 'e0ffffffffffffff'], ['72057594037927936', '0', 'f00100000000000000'],
    ['18446744073709551615', '0', 'f0ffffffffffffffff'],
    ['18446744073709551615', '18446744073709551615', 'ffffffffffffffffffffffffffffffffff'],
  ];
  it('encodes and strictly decodes the RFC 9605 C.1 sample', () => {
    expect(RFC_C1_SAMPLE.length).toBe(34);
    for (const [k, c, h] of RFC_C1_SAMPLE) {
      expect(hex(encodeSframeHeader(BigInt(k), BigInt(c)))).toBe(h);
      expect(decodeSframeHeader(fromHex(h))).toEqual({ kid: BigInt(k), ctr: BigInt(c), length: h.length / 2 });
    }
  });

  it('refuses truncated and non-minimal headers in reading order', async () => {
    for (const [h, code] of [
      ['', 'E_SFRAME_TRUNCATED_HEADER'], ['80', 'E_SFRAME_TRUNCATED_HEADER'], ['8f', 'E_SFRAME_TRUNCATED_HEADER'],
      ['99010001', 'E_SFRAME_TRUNCATED_HEADER'], ['8005', 'E_SFRAME_NON_MINIMAL_HEADER'], ['8007', 'E_SFRAME_NON_MINIMAL_HEADER'],
      ['0800', 'E_SFRAME_NON_MINIMAL_HEADER'], ['0807', 'E_SFRAME_NON_MINIMAL_HEADER'], ['9000ff', 'E_SFRAME_NON_MINIMAL_HEADER'],
      ['0900ff', 'E_SFRAME_NON_MINIMAL_HEADER'], ['f00000000000000000', 'E_SFRAME_NON_MINIMAL_HEADER'],
      ['0f0000000000000008', 'E_SFRAME_NON_MINIMAL_HEADER'], ['8800', 'E_SFRAME_NON_MINIMAL_HEADER'],
    ] as const) {
      expect(await codeOf(() => decodeSframeHeader(fromHex(h)))).toBe(code);
    }
    for (const h of ['77', '880808', '7808', '8708']) expect(await codeOf(() => decodeSframeHeader(fromHex(h)))).toBe('accepted');
  });

  it('reproduces the RFC 9605 C.3 suite 0x0004 frame with AAD = header || metadata', async () => {
    const { key, salt } = await deriveFrameKeys(fromHex('000102030405060708090a0b0c0d0e0f'), 0x123n);
    const prefix = fromHex('4945544620534672616d65205747');
    const input = concat(prefix, fromHex('64726166742d696574662d736672616d652d656e63'));
    const frame = encryptFrame(key, salt, 0x123n, 0x4567n, prefix.length, input);
    expect(hex(frame)).toBe('4945544620534672616d652057479901234567b7412c2513a1b66dbb48841bbaf17f598751176ad847681a69c6d0b091c07018ce4adb34eb');
    expect(hex(openFrame(key, salt, prefix.length, frame).plain)).toBe(hex(input));
  });

  const BASE = fromHex('0a'.repeat(16));
  const FRAMES: Array<[Codec, number, number, number, number, number, string, number, string]> = [
    ['opus', 0, 41, 0, 0, 0, 'fc0102030405060708', 0, '8029e2cb55c1af3559fae36751e93f325d2aaeff190e61164a66ff'],
    ['vp8', 3, 41, 1, 0, 1, '310102030405060708', 1, '319f03290100000000000001340a6b27e8eb6e0103de9bc092d5abe52394632f8ecd2519'],
    ['vp8', 3, 297, 1, 2, 1000, '5002009d012a8002e0010102030405060708', 10, '5002009d012a8002e0019f032901200000000003e8690e3801073c4c990ed0d5ad5735f3b67f0fdaa765afe0ba'],
    ['h264', 3, 41, 1, 0, 5, '000000016742c01e95a0501ec80000000168ce3c800000000165888421ff00000312345a5a5a5a', 28,
      '000000016742c01e95a0501ec80000000168ce3c80000000016588849f032901000003000003000005db05f193d08dc6cc86f2420a0baae4e1e76087c4740ff030eb87e1'],
  ];
  it('protects and unprotects one frame per codec rule, byte for byte', async () => {
    for (const [codec, leaf, epoch, slot, layer, seq, input, pl, out] of FRAMES) {
      expect(prefixLen(codec, fromHex(input))).toBe(pl);
      const sealed = await protect(BASE, kid(leaf, epoch), counter(slot, layer, seq), codec, fromHex(input));
      expect(hex(sealed)).toBe(out);
      expect(hex(await unprotect(BASE, codec, sealed))).toBe(input);
    }
  });

  it('canonicalises H.264 start codes and drops leading garbage', () => {
    const c = canonicalizeH264(fromHex('ffee0000016742c01e95a0501ec80000000168ce3c800000000001658884aabb'));
    expect(hex(c.frame)).toBe('000000016742c01e95a0501ec80000000168ce3c800000000001658884aabb');
    expect(c.prefixLen).toBe(c.frame.length - 2);
  });

  it('refuses the H.264 shapes protocol/05 refuses', async () => {
    expect(await codeOf(() => prefixLen('h264', fromHex('000000016742c01e95a0501ec80000000168ce3c80')))).toBe('E_SFRAME_NO_VCL_NAL');
    expect(await codeOf(() => prefixLen('h264', fromHex('000000016742c01e95a0501ec80000000162888421')))).toBe('E_SFRAME_UNSUPPORTED_CODEC');
    expect(await codeOf(() => prefixLen('h264', fromHex('000000016742c01e95a0501ec80000000174888421')))).toBe('E_SFRAME_UNSUPPORTED_CODEC');
    expect(await codeOf(() => prefixLen('h264', fromHex('0000000165c02020aa')))).toBe('E_SFRAME_MALFORMED_PREFIX');
    expect(prefixLen('h264', fromHex('0000000165c02000aa'))).toBe(8);
    expect(await codeOf(() => prefixLen('vp8', fromHex('5002009d012a8002e0')))).toBe('E_SFRAME_MALFORMED_PREFIX');
  });

  it('escapes with the zero counter seeded from the prefix', () => {
    for (const [seed, input, out] of [[0, '00000001000003', '000003000100000303'], [0, '000000', '00000300'], [0, '0000', '0000'],
      [1, '0001', '000301'], [1, '0100', '0100'], [2, '03ff', '0303ff'], [2, '04', '04'],
      [0, '9f03290100000000000001', '9f03290100000300000300000301']] as const) {
      expect(hex(rbspEscape(seed, fromHex(input)))).toBe(out);
      expect(hex(rbspUnescape(seed, fromHex(out)))).toBe(input);
    }
    expect(trailingZeros(fromHex('aa0000'))).toBe(2);
    expect(trailingZeros(fromHex('aa000000'))).toBe(2);
  });

  it('refuses every tampered VP8 key frame', async () => {
    const good = fromHex(FRAMES[2][8]);
    const flip = (at: number) => { const f = good.slice(); f[at] ^= 1; return f; };
    for (const [f, code] of [[flip(good.length - 1), 'E_SFRAME_AUTH'], [flip(6), 'E_SFRAME_AUTH'], [flip(21), 'E_SFRAME_AUTH'],
      [flip(20), 'E_SFRAME_AUTH'], [good.subarray(0, 36), 'E_SFRAME_TRUNCATED_FRAME']] as const) {
      expect(await codeOf(() => unprotect(BASE, 'vp8', f))).toBe(code);
    }
  });

  it('refuses a KID of 2^24 or more after the strict decode, which still reads it', async () => {
    for (const [h, code] of [
      ['a0ffffff', 'accepted'], ['b001000000', 'E_SFRAME_NON_CANONICAL_KID'], ['b001000129', 'E_SFRAME_NON_CANONICAL_KID'],
      ['f0ffffffffffffffff', 'E_SFRAME_NON_CANONICAL_KID'], ['a0000129', 'E_SFRAME_NON_MINIMAL_HEADER'], ['b0010001', 'E_SFRAME_TRUNCATED_HEADER'],
    ] as const) {
      expect(await codeOf(() => parseDillaHeader(fromHex(h)))).toBe(code);
    }
    expect(decodeSframeHeader(fromHex('b001000000')).kid).toBe(1n << 24n);
    // Sealed under the non-canonical KID's own key: only the range check refuses it.
    const sealed = await protect(BASE, (1n << 24n) | kid(0, 41), counter(0, 0, 0), 'opus', fromHex('fc01'));
    expect(await codeOf(() => unprotect(BASE, 'opus', sealed))).toBe('E_SFRAME_NON_CANONICAL_KID');
  });
});

describe('KID', () => {
  it('packs leaf index and epoch mod 256', () => {
    expect(kid(0, 0)).toBe(0n);
    expect(kid(3, 41)).toBe((3n << 8n) | 41n);
    expect(kid(3, 297)).toBe((3n << 8n) | 41n);
    expect(kid(65535, 255)).toBe((65535n << 8n) | 255n);
  });
  it('rejects a leaf index above 16 bits', () => { expect(() => kid(65536, 0)).toThrow(); });
});

describe('key derivation for suite 0x0004', () => {
  it('derives a 16-byte key and 12-byte salt that depend on the KID', async () => {
    const base = fromHex('00'.repeat(16));
    const a = await deriveFrameKeys(base, kid(1, 1));
    const b = await deriveFrameKeys(base, kid(2, 1));
    expect(a.key.length).toBe(16); expect(a.salt.length).toBe(12);
    expect(hex(a.key)).not.toBe(hex(b.key));
  });
  it('uses the RFC 9605 labels: "SFrame 1.0 Secret key " and "SFrame 1.0 Secret salt " followed by KID and suite', async () => {
    // Reference computation with the labels spelled out, independent of deriveFrameKeys.
    const { hkdfSha256 } = await import('./hkdf.ts');
    const { concat, utf8, be64, be16 } = await import('./bytes.ts');
    const base = fromHex('0102030405060708090a0b0c0d0e0f10');
    const k = kid(7, 9);
    const expectedKey = await hkdfSha256(new Uint8Array(0), base, concat(utf8('SFrame 1.0 Secret key '), be64(k), be16(SUITE)), 16);
    const expectedSalt = await hkdfSha256(new Uint8Array(0), base, concat(utf8('SFrame 1.0 Secret salt '), be64(k), be16(SUITE)), 12);
    const got = await deriveFrameKeys(base, k);
    expect(hex(got.key)).toBe(hex(expectedKey));
    expect(hex(got.salt)).toBe(hex(expectedSalt));
  });
});

describe('counter partition and nonce', () => {
  it('lays out slot(8) | layer(4) | seq(52)', () => {
    expect(counter(0, 0, 0)).toBe(0n);
    expect(counter(1, 0, 0)).toBe(1n << 56n);
    expect(counter(0, 1, 0)).toBe(1n << 52n);
    expect(counter(2, 3, 5)).toBe((2n << 56n) | (3n << 52n) | 5n);
  });
  it('refuses to wrap', () => {
    expect(() => counter(0, 0, 1n << 52n)).toThrow();
    expect(() => counter(256, 0, 0)).toThrow();
    expect(() => counter(0, 16, 0)).toThrow();
  });
  it('nonce is the 12-byte salt XOR the big-endian counter', () => {
    const salt = fromHex('000000000000000000000000');
    expect(hex(nonce(salt, 1n))).toBe('000000000000000000000001');
    expect(hex(nonce(fromHex('ff'.repeat(12)), 1n))).toBe('ff'.repeat(11) + 'fe');
  });
});

describe('SFrame header (RFC 9605 §4.3, vectors from Appendix C.1)', () => {
  // Copied verbatim from RFC 9605 Appendix C.1 "Header Encoding/Decoding" (https://www.rfc-editor.org/rfc/rfc9605.txt).
  // Note: the RFC's test vectors live in Appendix C, not Appendix A (Appendix A is the non-normative "Example API").
  const RFC_HEADER_VECTORS: Array<{ kid: string; ctr: string; header: string }> = [
    { kid: '0000000000000000', ctr: '0000000000000000', header: '00' },
    { kid: '0000000000000000', ctr: '0000000000000100', header: '090100' },
    { kid: '00000000000000ff', ctr: '0000000000000000', header: '80ff' },
    { kid: '0000000000000100', ctr: '0000000000000100', header: '9901000100' },
  ];
  it('has at least three vectors copied from RFC 9605 Appendix C.1', () => {
    expect(RFC_HEADER_VECTORS.length).toBeGreaterThanOrEqual(3);
  });
  for (const v of RFC_HEADER_VECTORS) {
    it(`encodes kid ${v.kid} ctr ${v.ctr} as ${v.header}`, () => {
      expect(hex(encodeSframeHeader(BigInt('0x' + v.kid), BigInt('0x' + v.ctr)))).toBe(v.header.toLowerCase());
    });
  }
});

describe('key derivation against RFC 9605 Appendix C.3 vectors', () => {
  // Copied verbatim from RFC 9605 Appendix C.3 "SFrame Encryption/Decryption", the cipher_suite: 0x0004 case
  // (AES_128_GCM_SHA256_128). The RFC's test vectors live in Appendix C, not Appendix A/A.2/A.3.
  const RFC_KDF_VECTOR: { base_key: string; kid: string; sframe_key: string; sframe_salt: string } | null = {
    base_key: '000102030405060708090a0b0c0d0e0f',
    kid: '0000000000000123',
    sframe_key: 'd34f547f4ca4f9a7447006fe7fcbf768',
    sframe_salt: '75234edefe07819026751816',
  };
  it('has the RFC 0x0004 derivation vector', () => { expect(RFC_KDF_VECTOR).not.toBeNull(); });
  it('derives the RFC key and salt', async () => {
    if (!RFC_KDF_VECTOR) return;
    const got = await deriveFrameKeys(fromHex(RFC_KDF_VECTOR.base_key), BigInt('0x' + RFC_KDF_VECTOR.kid));
    expect(hex(got.key)).toBe(RFC_KDF_VECTOR.sframe_key.toLowerCase());
    expect(hex(got.salt)).toBe(RFC_KDF_VECTOR.sframe_salt.toLowerCase());
  });
});
