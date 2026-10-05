// M4 (task 17 review): the argument buffer wasm-bindgen allocates for a base key is zeroed before it is freed, and the
// sender path leaves no copy of the key anywhere in linear memory. The receiver keeps its copy (zeroized on drop) for
// the epoch's retention; KeyRing::install_epoch takes the key by value, which leaves one transient copy in the wasm
// stack region until a later call overwrites it (stated in protocol/08). Scans the instance's memory for the bytes.
import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { initSync, MediaReceiver, MediaSender, type InitOutput } from '../wasm/dilla_core_wasm.js';

let exports: InitOutput;
beforeAll(() => {
  exports = initSync({ module: readFileSync(new URL('../wasm/dilla_core_wasm_bg.wasm', import.meta.url)) });
});

/** A key no other test uses, so any match in memory is a copy of it. */
const KEY = Uint8Array.from({ length: 16 }, (_, i) => 0xc3 ^ (i * 29));
const DEVICES = new Uint8Array(32).fill(0xa1).fill(0xb2, 16);

function copiesInMemory(): number {
  const mem = new Uint8Array(exports.memory.buffer);
  let n = 0;
  outer: for (let i = 0; i + KEY.length <= mem.length; i++) {
    if (mem[i] !== KEY[0]) continue;
    for (let j = 1; j < KEY.length; j++) if (mem[i + j] !== KEY[j]) continue outer;
    n++;
  }
  return n;
}

describe('no stray base-key copies in wasm memory (M4)', () => {
  it('MediaSender: the constructor and rekey zero their argument buffers; the caller’s array is untouched', () => {
    const arg = KEY.slice();
    const s = new MediaSender(arg, 0, 1n, 1n);
    expect([...arg]).toEqual([...KEY]); // wasm-bindgen copied it in; the worker zeroes its own copies
    expect(copiesInMemory()).toBe(0);
    s.rekey(KEY.slice(), 0, 2n);
    expect(copiesInMemory()).toBe(0);
    s.free();
  });

  it('a wrong-length key is zeroed as well', () => {
    const long = new Uint8Array(32);
    long.set(KEY);
    expect(() => new MediaSender(long, 0, 1n, 1n)).toThrow('E_BAD_OPTIONS');
    expect(copiesInMemory()).toBe(0);
  });

  // Runs last: it leaves the stack-region copy behind.
  it('MediaReceiver: the retained epoch’s copy is zeroized when the receiver is freed; the argument buffer is zeroed', () => {
    const r = new MediaReceiver();
    r.install_epoch(1n, KEY.slice(), Uint32Array.from([0, 1]), DEVICES, 1, 0);
    const held = copiesInMemory();
    expect(held).toBeGreaterThanOrEqual(1);
    expect(held).toBeLessThanOrEqual(2); // KeyRing's copy, and at most the one transient stack copy
    r.free();
    expect(copiesInMemory()).toBe(held - 1);
  });
});
