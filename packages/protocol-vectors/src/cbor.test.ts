import { describe, it, expect } from 'vitest';
import { encode, decode } from './cbor.ts';
import { hex, fromHex } from './bytes.ts';

const cases: Array<[unknown, string]> = [
  [0, '00'], [1, '01'], [10, '0a'], [23, '17'], [24, '1818'], [25, '1819'], [100, '1864'],
  [1000, '1903e8'], [1000000, '1a000f4240'], [1000000000000n, '1b000000e8d4a51000'],
  ['', '60'], ['a', '6161'], ['IETF', '6449455446'], ['ü', '62c3bc'],
  [new Uint8Array([]), '40'], [new Uint8Array([1, 2, 3, 4]), '4401020304'],
  [null, 'f6'], [[], '80'], [[1, 2, 3], '83010203'],
  [[1, [2, 3], [4, 5]], '8301820203820405'],
  [Array.from({ length: 25 }, (_, i) => i + 1), '98190102030405060708090a0b0c0d0e0f101112131415161718181819'],
];

describe('deterministic CBOR encode', () => {
  for (const [value, expected] of cases) {
    it(`encodes ${JSON.stringify(value, (_, v) => typeof v === 'bigint' ? v.toString() : v)} as ${expected}`, () => {
      expect(hex(encode(value as never))).toBe(expected);
    });
  }
  it('rejects negative numbers, floats, maps and undefined', () => {
    expect(() => encode(-1 as never)).toThrow();
    expect(() => encode(1.5 as never)).toThrow();
    expect(() => encode({} as never)).toThrow();
    expect(() => encode(undefined as never)).toThrow();
  });
});

describe('CBOR decode', () => {
  for (const [value, expected] of cases) {
    it(`decodes ${expected}`, () => {
      const decoded = decode(fromHex(expected));
      // Both sides: bigints that fit in a safe integer become numbers (decode returns numbers for those), larger ones become decimal strings.
      const replacer = (_: string, v: unknown) => typeof v === 'bigint' ? (v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : v.toString()) : v instanceof Uint8Array ? hex(v) : v;
      expect(JSON.stringify(decoded, replacer)).toBe(JSON.stringify(value, replacer));
    });
  }
  it('rejects indefinite-length and non-minimal encodings', () => {
    expect(() => decode(fromHex('9f01ff'))).toThrow();   // indefinite array
    expect(() => decode(fromHex('1801'))).toThrow();     // 1 encoded with one extra byte
    expect(() => decode(fromHex('a0'))).toThrow();       // map
    expect(() => decode(fromHex('0101'))).toThrow();     // trailing bytes
  });
});
