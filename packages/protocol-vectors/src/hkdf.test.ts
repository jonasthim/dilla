import { it, expect } from 'vitest';
import { hkdfSha256 } from './hkdf.ts';
import { hex, fromHex } from './bytes.ts';

it('matches RFC 5869 test case 1', async () => {
  const okm = await hkdfSha256(fromHex('000102030405060708090a0b0c'), fromHex('0b'.repeat(22)), fromHex('f0f1f2f3f4f5f6f7f8f9'), 42);
  expect(hex(okm)).toBe('3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865');
});
it('matches RFC 5869 test case 3 (empty salt and info)', async () => {
  const okm = await hkdfSha256(new Uint8Array(0), fromHex('0b'.repeat(22)), new Uint8Array(0), 42);
  expect(hex(okm)).toBe('8da4e775a563c18f715f802a063c5a31b8a11f5c5ee1879ec3454e5f3c738d2d9d201395faa4b61a96c8');
});
