// WB security m1: readCallMediaEpoch zero-fills the decoded key copy on every path, its error paths included. The cbor
// decoder copies every byte string, and `bin` hands that copy out; this spy keeps each copy of the key (0x5a × 16).
import { describe, expect, it, vi } from 'vitest';

const copies: Uint8Array[] = [];
vi.mock('./cbor', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./cbor')>();
  return { ...actual, bin: (v: Parameters<typeof actual.bin>[0], n?: number) => { const b = actual.bin(v, n); if (b.length === 16 && b.every((x) => x === 0x5a)) copies.push(b); return b; } };
});

const { encode } = await import('./cbor');
const { readCallMediaEpoch, CoreError } = await import('./core-port');

const KEY = new Uint8Array(16).fill(0x5a);
const DEVICE = new Uint8Array(16).fill(0x11);
const USER = new Uint8Array(16).fill(0x22);
const CODE = '12345 12345 12345 12345 12345 12345';

describe('readCallMediaEpoch zero-fills the decoded key copy on its error paths (WB security m1)', () => {
  const cases: [string, () => Uint8Array][] = [
    ['a bad call code', () => encode([3n, KEY, 0n, [[0n, DEVICE, USER]], 'not a code'])],
    ['a roster over the limit', () => encode([3n, KEY, 0n, Array.from({ length: 1025 }, () => [0n, DEVICE, USER]), CODE])],
    ['a malformed roster row', () => encode([3n, KEY, 0n, [[0n, DEVICE]], CODE])],
  ];
  it.each(cases)('%s', (_name, bytes) => {
    copies.length = 0;
    expect(() => readCallMediaEpoch(bytes())).toThrow(CoreError);
    const keyCopies = copies.filter((c) => c !== undefined);
    expect(keyCopies.length).toBeGreaterThan(0);
    expect(keyCopies.every((c) => c.every((b) => b === 0))).toBe(true);
  });

  it('the success path hands out a fresh key and leaves no other copy', () => {
    copies.length = 0;
    const out = readCallMediaEpoch(encode([3n, KEY, 0n, [[0n, DEVICE, USER]], CODE]));
    expect([...new Uint8Array(out.baseKey)]).toEqual([...KEY]);
    expect(copies[0].every((b) => b === 0)).toBe(true);
  });
});
