import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { arr, CborError, decode, encode } from '../cbor';
import { fromHex, toHex } from '../hex';
import { decodeFrame, encodeFrame, Op } from './frames';

interface FrameCase { name: string; op: number; n: number; group_id: string; payload: string; frame: string }
interface FrameReject { name: string; frame: string; code: string }
const vectors = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../../../protocol/vectors/frames.json', import.meta.url)), 'utf8'),
) as { cases: FrameCase[]; rejects: FrameReject[] };

/** What this client does with each server-side reject vector: an error code, or null for "accepted". */
const CLIENT_VERDICT: Record<string, string | null> = {
  'three elements': 'E_FRAME_SHAPE',
  'five elements': 'E_FRAME_SHAPE',
  'unknown opcode': null,
  'server opcode from a client': 'E_FRAME_SHAPE',
  'payload is not an array': 'E_FRAME_SHAPE',
  'subscribe with the wrong element count': 'E_FRAME_SHAPE',
  'group_id on a control frame': 'E_FRAME_SHAPE',
  'group_id of the wrong length': 'E_FRAME_SHAPE',
  'commit_ack with no group_id': 'E_FRAME_SHAPE',
  'non-minimal op': 'E_CBOR_NONCANONICAL',
  'map instead of an array': 'E_CBOR_TYPE',
};

function verdict(bytes: Uint8Array): string | null {
  try {
    decodeFrame(bytes);
    return null;
  } catch (err) {
    if (err instanceof CborError) return err.code;
    if (err instanceof Error) return err.message;
    throw err;
  }
}

describe('frames.json', () => {
  it('holds the 25 cases and 11 rejects this codec was written against', () => {
    expect(vectors.cases).toHaveLength(25);
    expect(vectors.rejects).toHaveLength(11);
    expect(Object.keys(CLIENT_VERDICT).sort()).toEqual(vectors.rejects.map((r) => r.name).sort());
  });

  for (const c of vectors.cases) {
    it(`encodes ${c.name} byte for byte`, () => {
      const payload = arr(decode(fromHex(c.payload)));
      const groupId = c.group_id === '' ? null : fromHex(c.group_id);
      expect(toHex(encodeFrame(c.op, c.n, groupId, payload))).toBe(c.frame);
    });

    it(`decodes ${c.name}`, () => {
      const frame = decodeFrame(fromHex(c.frame));
      expect(frame.op).toBe(c.op);
      expect(frame.n).toBe(BigInt(c.n));
      expect(frame.groupId === null ? '' : toHex(frame.groupId)).toBe(c.group_id);
      expect(toHex(encode(frame.payload))).toBe(c.payload);
    });
  }

  for (const r of vectors.rejects) {
    it(`gives the client verdict on the reject "${r.name}"`, () => {
      expect(verdict(fromHex(r.frame))).toBe(CLIENT_VERDICT[r.name]);
    });
  }
});

describe('frame shape', () => {
  it('accepts an unknown opcode with any payload', () => {
    expect(decodeFrame(encode([63, 1, null, []]))).toEqual({ op: 63, n: 1n, groupId: null, payload: [] });
  });

  it('refuses an opcode above 255, a text group id and a wrong ready length', () => {
    expect(verdict(encode([256, 0, null, []]))).toBe('E_FRAME_SHAPE');
    expect(verdict(encode([19, 1, 'g', [1, 2, 3, 4, 5, 6]]))).toBe('E_FRAME_SHAPE');
    expect(verdict(encode([Op.ready, 1, null, [1, 2, 3]]))).toBe('E_FRAME_SHAPE');
  });

  it('refuses to encode a group id that is not 16 bytes, or a bad op or n', () => {
    expect(() => encodeFrame(Op.commitAck, 0, new Uint8Array(15), [1])).toThrow('E_FRAME_SHAPE');
    expect(() => encodeFrame(256, 0, null, [])).toThrow('E_FRAME_SHAPE');
    expect(() => encodeFrame(Op.heartbeat, -1, null, [0, 1])).toThrow('E_FRAME_SHAPE');
    expect(() => encodeFrame(Op.heartbeat, 1.5, null, [0, 1])).toThrow('E_FRAME_SHAPE');
  });

  it('pins the opcode numbers', () => {
    expect(Op).toEqual({ hello: 0, identify: 1, ready: 3, invalidSession: 5, heartbeat: 6, heartbeatAck: 7, reconnect: 8,
      error: 9, commitAck: 12, handshake: 16, commitNeeded: 17, epochChanged: 18, messageCt: 19, welcome: 20, messageDeleted: 21 });
  });
});
