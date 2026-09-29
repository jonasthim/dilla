import { describe, it, expect } from 'vitest';
import { safetyNumber, sas, recoveryKeyBase32, deriveRecoveryKeys, credentialIdentity, decimalDigits, sessionPreimage } from './identity.ts';
import { decode } from './cbor.ts';
import { hex, fromHex } from './bytes.ts';

describe('decimal digits', () => {
  it('renders a hash as a zero-padded 78-digit decimal string', () => {
    expect(decimalDigits(new Uint8Array(32))).toBe('0'.repeat(78));
    expect(decimalDigits(fromHex('00'.repeat(31) + '01'))).toBe('0'.repeat(77) + '1');
    expect(decimalDigits(fromHex('ff'.repeat(32)))).toBe('115792089237316195423570985008687907853269984665640564039457584007913129639935');
  });
});

describe('safety number', () => {
  it('is 60 digits, symmetric, and depends on both keys', async () => {
    const a = fromHex('01'.repeat(32)), b = fromHex('02'.repeat(32));
    const ab = await safetyNumber(a, b), ba = await safetyNumber(b, a);
    expect(ab).toMatch(/^\d{60}$/);
    expect(ab).toBe(ba);
    expect(await safetyNumber(a, fromHex('03'.repeat(32)))).not.toBe(ab);
  });
});

describe('SAS', () => {
  it('is the first 30 digits of the padded decimal of the epoch authenticator', () => {
    const ea = fromHex('ff'.repeat(32));
    expect(sas(ea)).toBe('115792089237316195423570985008');
    expect(sas(new Uint8Array(32))).toBe('0'.repeat(30));
  });
});

describe('recovery key', () => {
  it('encodes 256 bits as 52 Crockford base32 characters', () => {
    expect(recoveryKeyBase32(new Uint8Array(32))).toBe('0'.repeat(52));
    const s = recoveryKeyBase32(fromHex('ff'.repeat(32)));
    expect(s).toHaveLength(52);
    expect(s).toMatch(/^[0-9A-HJKMNP-TV-Z]{52}$/);
  });
  it('derives distinct header and archive keys with the documented labels', async () => {
    const rk = fromHex('0b'.repeat(32));
    const { header, archive } = await deriveRecoveryKeys(rk);
    expect(header.length).toBe(32); expect(archive.length).toBe(32);
    expect(hex(header)).not.toBe(hex(archive));
  });
});

describe('session preimage', () => {
  it('is 81 bytes with every field at its documented offset', () => {
    const instanceId = fromHex('00112233445566778899aabbccddeeff');
    const deviceId = fromHex('0102030405060708090a0b0c0d0e0f10');
    const nonce = fromHex('ab'.repeat(32));
    const p = sessionPreimage(instanceId, deviceId, nonce, 0);
    expect(p).toHaveLength(81);
    expect(new TextDecoder().decode(p.subarray(0, 16))).toBe('dilla session v1');
    expect(hex(p.subarray(16, 32))).toBe(hex(instanceId));
    expect(hex(p.subarray(32, 48))).toBe(hex(deviceId));
    expect(hex(p.subarray(48, 80))).toBe(hex(nonce));
    expect(p[80]).toBe(0);
  });
  it('binds the purpose, so a renew signature is not an establish signature', () => {
    const a = sessionPreimage(fromHex('00'.repeat(16)), fromHex('11'.repeat(16)), fromHex('22'.repeat(32)), 0);
    const b = sessionPreimage(fromHex('00'.repeat(16)), fromHex('11'.repeat(16)), fromHex('22'.repeat(32)), 1);
    expect(hex(a)).not.toBe(hex(b));
  });
  it('refuses a wrong-length field', () => {
    expect(() => sessionPreimage(fromHex('00'.repeat(15)), fromHex('11'.repeat(16)), fromHex('22'.repeat(32)), 0)).toThrow();
    expect(() => sessionPreimage(fromHex('00'.repeat(16)), fromHex('11'.repeat(15)), fromHex('22'.repeat(32)), 0)).toThrow();
    expect(() => sessionPreimage(fromHex('00'.repeat(16)), fromHex('11'.repeat(16)), fromHex('22'.repeat(31)), 0)).toThrow();
  });
});

describe('credential identity', () => {
  it('is a 10-element fixed-position array', () => {
    const b = credentialIdentity({ umkPub: fromHex('a1'.repeat(32)), userId: fromHex('b1'.repeat(16)), deviceId: fromHex('c1'.repeat(16)), kind: 0, tier: 0, signerTier: 0, sskPub: fromHex('d1'.repeat(32)), sigUmkSsk: fromHex('e1'.repeat(64)), sigSskDev: fromHex('f1'.repeat(64)) });
    const arr = decode(b) as unknown[];
    expect(arr.length).toBe(10);
    expect(arr[0]).toBe(1);
    expect(arr[4]).toBe(0);
    expect(hex(arr[7] as Uint8Array)).toBe('d1'.repeat(32));
  });
});
