import { describe, expect, it } from 'vitest';
import { frameVectors } from './frames.ts';
import { decode } from './cbor.ts';
// bytes.ts exports hex, fromHex, concat, utf8, be64, be16 — there is no `unhex`.
import { fromHex } from './bytes.ts';

describe('gateway frame vectors', () => {
  const v = frameVectors();

  it('carries one accept case per opcode in the catalogue', () => {
    const ops = new Set(v.cases.map((c) => c.op));
    for (const op of [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 16, 17, 18, 19, 20, 21, 32, 33, 48, 49, 50]) {
      expect(ops.has(op), `opcode ${op} has no case`).toBe(true);
    }
  });

  it('every frame decodes to four elements whose first two are the op and n', () => {
    for (const c of v.cases) {
      const parts = decode(fromHex(c.frame)) as unknown[];
      expect(parts).toHaveLength(4);
      expect(parts[0]).toBe(c.op);
      expect(parts[1]).toBe(c.n);
    }
  });

  it('every reject case names a frame-level error code', () => {
    for (const r of v.rejects) {
      expect(['E_FRAME_SHAPE', 'E_FRAME_TYPE', 'E_FRAME_CBOR', 'E_FRAME_LIMIT']).toContain(r.code);
    }
  });
});
