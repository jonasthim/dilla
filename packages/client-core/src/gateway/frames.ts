import { decode, encode, type CborInput, type CborValue } from '../cbor';

export interface Frame {
  op: number;
  n: bigint;
  groupId: Uint8Array | null;
  payload: CborValue[];
}

export const Op = {
  hello: 0, identify: 1, ready: 3, invalidSession: 5, heartbeat: 6, heartbeatAck: 7,
  reconnect: 8, error: 9, commitAck: 12, handshake: 16, commitNeeded: 17,
  epochChanged: 18, messageCt: 19, welcome: 20, messageDeleted: 21,
} as const;

const SPECS: ReadonlyMap<number, { elements: number; grouped: boolean }> = new Map([
  [0, 9], [1, 5], [2, 4], [3, 9], [4, 3], [5, 2], [6, 2], [7, 1], [8, 2],
  [9, 3], [10, 1], [11, 1], [12, 1], [16, 5], [17, 4], [18, 2], [19, 6],
  [20, 6], [21, 2], [32, 7], [33, 4], [48, 4], [49, 4], [50, 4],
].map(([op, elements]) => [op, { elements, grouped: op === 12 || (op >= 16 && op <= 21) }]));

function shape(): never {
  throw new Error('E_FRAME_SHAPE');
}

export function encodeFrame(op: number, n: number, groupId: Uint8Array | null, payload: readonly CborInput[]): Uint8Array {
  if (!Number.isInteger(op) || op < 0 || op > 255 || !Number.isSafeInteger(n) || n < 0
    || (groupId !== null && (!(groupId instanceof Uint8Array) || groupId.length !== 16))) shape();
  return encode([op, n, groupId, payload]);
}

export function decodeFrame(bytes: Uint8Array): Frame {
  const value = decode(bytes);
  if (!Array.isArray(value) || value.length !== 4) shape();
  const [op, n, groupId, payload] = value;
  if (typeof op !== 'bigint' || op > 255n || typeof n !== 'bigint'
    || (groupId !== null && (!(groupId instanceof Uint8Array) || groupId.length !== 16))
    || !Array.isArray(payload)) shape();
  const spec = SPECS.get(Number(op));
  if (spec !== undefined && (payload.length !== spec.elements || spec.grouped !== (groupId !== null))) shape();
  return { op: Number(op), n, groupId, payload };
}
