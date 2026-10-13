import { describe, expect, it } from 'vitest';
import { frameVectors } from './frames.ts';
import { decode } from './cbor.ts';
// bytes.ts exports hex, fromHex, concat, utf8, be64, be16 — there is no `unhex`.
import { fromHex } from './bytes.ts';

describe('gateway frame vectors', () => {
  const v = frameVectors();

  it('carries one accept case per opcode in the catalogue', () => {
    const ops = new Set(v.cases.map((c) => c.op));
    for (const op of [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 16, 17, 18, 19, 20, 21, 32, 33, 48, 49, 50, 51, 52, 53]) {
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

  it('pins all new ephemeral payloads, direction, group and replay shape', () => {
    const cases = [
      { name: 'typing channel', op: 49, payload: [new Uint8Array(16).fill(0x0c), new Uint8Array(16).fill(0x09), new Uint8Array(16).fill(0x08), 1, 1758659010] },
      { name: 'typing_set on', op: 51, payload: [new Uint8Array(16).fill(0x0c), 1] },
      { name: 'voice_self muted', op: 52, payload: [new Uint8Array(16).fill(0x0d), 1] },
      // op 53 call_ring (L-GW-33): [call_id, channel_id, user_id, state 0..2, expires_ts]
      { name: 'call_ring state 1', op: 53, payload: [new Uint8Array(16).fill(0x0d), new Uint8Array(16).fill(0x0c), new Uint8Array(16).fill(0x09), 1, 1758659030] },
      { name: 'call_ring state 0', op: 53, payload: [new Uint8Array(16).fill(0x0d), new Uint8Array(16).fill(0x0c), new Uint8Array(16).fill(0x09), 0, 1758659030] },
      { name: 'call_ring state 2', op: 53, payload: [new Uint8Array(16).fill(0x0d), new Uint8Array(16).fill(0x0c), new Uint8Array(16).fill(0x09), 2, 1758659030] },
    ];
    for (const want of cases) {
      const found = v.cases.find(c => c.name === want.name);
      expect(found?.op).toBe(want.op);
      expect(found?.n).toBe(0);
      expect(found?.group_id).toBe('');
      expect(decode(fromHex(found!.payload))).toEqual(want.payload);
      const frame = decode(fromHex(found!.frame)) as unknown[];
      expect(frame).toHaveLength(4);
      expect(frame[0]).toBe(want.op);
      expect(frame[1]).toBe(0);
      expect(frame[2]).toBeNull();
      expect(frame[3]).toEqual(want.payload);
    }
  });

  it('commits the four shape refusals as exact CBOR frames', () => {
    const rejects = [
      { name: 'old typing has four elements', op: 49, group: null, payload: [new Uint8Array(16).fill(0x09), new Uint8Array(16).fill(0x08), 1, 1758659010] },
      { name: 'typing_set channel id has 17 bytes', op: 51, group: null, payload: [new Uint8Array(17).fill(0x0c), 1] },
      { name: 'voice_self flags 4', op: 52, group: null, payload: [new Uint8Array(16).fill(0x0d), 4] },
      { name: 'typing_set has group_id', op: 51, group: new Uint8Array(16).fill(0x07), payload: [new Uint8Array(16).fill(0x0c), 1] },
    ];
    for (const want of rejects) {
      const found = v.rejects.find(r => r.name === want.name);
      expect(found?.code).toBe('E_FRAME_SHAPE');
      expect(decode(fromHex(found!.frame))).toEqual([want.op, 0, want.group, want.payload]);
    }
  });

  // op 53 is server-to-client: the corpus code is the instance decoder's verdict (L-GW-33).
  it('commits the two call_ring refusals with the instance code E_FRAME_TYPE', () => {
    const call = new Uint8Array(16).fill(0x0d);
    const channel = new Uint8Array(16).fill(0x0c);
    const user = new Uint8Array(16).fill(0x09);
    const rejects = [
      { name: 'call_ring state 3', payload: [call, channel, user, 3, 1758659030] },
      { name: 'call_ring with 4 elements', payload: [call, channel, user, 1] },
    ];
    for (const want of rejects) {
      const found = v.rejects.find(r => r.name === want.name);
      expect(found?.code).toBe('E_FRAME_TYPE');
      expect(decode(fromHex(found!.frame))).toEqual([53, 0, null, want.payload]);
    }
  });
});
