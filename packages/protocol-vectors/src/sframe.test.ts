import { describe, it, expect } from 'vitest';
import { kid, deriveFrameKeys, counter, nonce, encodeSframeHeader, SUITE } from './sframe.ts';
import { hex, fromHex } from './bytes.ts';

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
