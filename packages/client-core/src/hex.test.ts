import { describe, expect, it } from 'vitest';
import { fromHex, toHex } from './hex';

describe('hex', () => {
  it('writes two lower-case digits per byte', () => {
    expect(toHex(new Uint8Array([0, 1, 0xab, 0xff]))).toBe('0001abff');
    expect(toHex(new Uint8Array(0))).toBe('');
  });

  it('reads back what it writes for every byte value', () => {
    const all = new Uint8Array(256).map((_, i) => i);
    expect(fromHex(toHex(all))).toEqual(all);
    expect(fromHex('')).toEqual(new Uint8Array(0));
  });

  it('refuses odd lengths, upper case and anything that is not a hex digit', () => {
    for (const bad of ['0', 'abc', 'AB', 'aB', '0g', ' 00', '00 ', '0x00', '٠١']) {
      expect(() => fromHex(bad), JSON.stringify(bad)).toThrow(/^E_HEX: /);
    }
    expect(() => fromHex('zz')).toThrow(RangeError);
  });
});
