// Deterministic CBOR of the dilla subset (protocol/02, interfaces.md A1.2). Hand-written on purpose (ruling C20): no maps, tags, floats, negatives, indefinite lengths or simple values but null.
export type CborValue = bigint | Uint8Array | string | null | CborValue[];
export type CborInput = number | bigint | Uint8Array | string | null | readonly CborInput[];
export type CborErrorCode = 'E_CBOR_TRUNCATED' | 'E_CBOR_TRAILING' | 'E_CBOR_TYPE' | 'E_CBOR_NONCANONICAL'
  | 'E_CBOR_UTF8' | 'E_CBOR_DEPTH' | 'E_CBOR_RANGE' | 'E_CBOR_SHAPE';

export class CborError extends Error {
  readonly code: CborErrorCode;

  constructor(code: CborErrorCode, detail: string) {
    super(code + ': ' + detail);
    this.name = 'CborError';
    this.code = code;
  }
}

export const MAX_DEPTH = 8;
const MAX_UINT = (1n << 64n) - 1n;
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

class Writer {
  private readonly chunks: Uint8Array[] = [];
  private length = 0;

  add(bytes: Uint8Array): void {
    this.chunks.push(bytes);
    this.length += bytes.length;
  }

  finish(): Uint8Array {
    const result = new Uint8Array(this.length);
    let offset = 0;
    for (const chunk of this.chunks) {
      result.set(chunk, offset);
      offset += chunk.length;
    }
    return result;
  }
}

function head(major: number, n: bigint): Uint8Array {
  const first = major << 5;
  if (n < 24n) return Uint8Array.of(first | Number(n));
  if (n <= 0xffn) return Uint8Array.of(first | 24, Number(n));
  const width = n <= 0xffffn ? 2 : n <= 0xffffffffn ? 4 : 8;
  const bytes = new Uint8Array(width + 1);
  bytes[0] = first | (width === 2 ? 25 : width === 4 ? 26 : 27);
  for (let i = width; i > 0; i--) {
    bytes[i] = Number(n & 0xffn);
    n >>= 8n;
  }
  return bytes;
}

function kind(v: CborValue): string {
  if (Array.isArray(v)) return `array(${v.length})`;
  if (v instanceof Uint8Array) return `bytes(${v.length})`;
  if (typeof v === 'bigint') return 'uint';
  if (typeof v === 'string') return 'text';
  return 'null';
}

export function encode(value: CborInput): Uint8Array {
  const writer = new Writer();
  function put(v: unknown, depth: number): void {
    if (depth > MAX_DEPTH) throw new CborError('E_CBOR_DEPTH', `${typeof v} at depth ${depth}`);
    if (v === null) { writer.add(Uint8Array.of(0xf6)); return; }
    if (typeof v === 'number') {
      if (!Number.isSafeInteger(v) || v < 0) throw new CborError('E_CBOR_RANGE', 'number');
      writer.add(head(0, BigInt(v)));
      return;
    }
    if (typeof v === 'bigint') {
      if (v < 0n || v > MAX_UINT) throw new CborError('E_CBOR_RANGE', 'bigint');
      writer.add(head(0, v));
      return;
    }
    if (typeof v === 'string') {
      if (/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(v)) {
        throw new CborError('E_CBOR_UTF8', 'string');
      }
      const bytes = encoder.encode(v);
      writer.add(head(3, BigInt(bytes.length)));
      writer.add(bytes);
      return;
    }
    if (v instanceof Uint8Array) {
      writer.add(head(2, BigInt(v.length)));
      writer.add(v.slice());
      return;
    }
    if (Array.isArray(v)) {
      writer.add(head(4, BigInt(v.length)));
      for (const element of v) put(element, depth + 1);
      return;
    }
    const type = typeof v === 'object' && v !== null ? v.constructor?.name ?? 'object' : typeof v;
    throw new CborError('E_CBOR_TYPE', type);
  }
  put(value, 0);
  return writer.finish();
}

export function decode(bytes: Uint8Array): CborValue {
  let pos = 0;
  function error(code: CborErrorCode, offset: number, reason: string): never {
    throw new CborError(code, `at byte ${offset}: ${reason}`);
  }
  function item(depth: number): CborValue {
    if (depth > MAX_DEPTH) error('E_CBOR_DEPTH', pos, 'depth exceeded');
    if (pos >= bytes.length) error('E_CBOR_TRUNCATED', pos, 'item missing');
    const start = pos;
    const initial = bytes[pos++];
    const major = initial >> 5;
    const ai = initial & 31;
    if (major === 7) {
      if (initial === 0xf6) return null;
      error('E_CBOR_TYPE', start, 'simple value');
    }
    if (ai >= 28) error('E_CBOR_TYPE', start, 'additional information');
    if (major === 1 || major === 5 || major === 6) error('E_CBOR_TYPE', start, 'major type');
    let n: bigint;
    if (ai < 24) n = BigInt(ai);
    else {
      const width = ai === 24 ? 1 : ai === 25 ? 2 : ai === 26 ? 4 : 8;
      if (bytes.length - pos < width) error('E_CBOR_TRUNCATED', pos, 'head missing');
      n = 0n;
      for (let i = 0; i < width; i++) n = (n << 8n) | BigInt(bytes[pos++]);
      const floor = width === 1 ? 24n : width === 2 ? 0x100n : width === 4 ? 0x10000n : 0x100000000n;
      if (n < floor) error('E_CBOR_NONCANONICAL', start, 'head is not shortest');
    }
    if (major === 0) return n;
    if (major === 2 || major === 3) {
      if (n > BigInt(bytes.length - pos)) error('E_CBOR_TRUNCATED', pos, 'body missing');
      const end = pos + Number(n);
      const body = bytes.slice(pos, end);
      pos = end;
      if (major === 2) return body;
      try { return decoder.decode(body); }
      catch (e) {
        if (e instanceof TypeError) error('E_CBOR_UTF8', start, 'invalid text');
        throw e;
      }
    }
    if (n > BigInt(bytes.length - pos)) error('E_CBOR_TRUNCATED', pos, 'array items missing');
    const values: CborValue[] = [];
    for (let i = 0; i < Number(n); i++) values.push(item(depth + 1));
    return values;
  }
  const value = item(0);
  if (pos !== bytes.length) error('E_CBOR_TRAILING', pos, 'bytes after item');
  return value;
}

export function arr(v: CborValue, length?: number): CborValue[] {
  if (!Array.isArray(v) || (length !== undefined && v.length !== length)) {
    throw new CborError('E_CBOR_SHAPE', `expected array${length === undefined ? '' : ` of ${length}`}, got ${kind(v)}`);
  }
  return v;
}

export function u64(v: CborValue): bigint {
  if (typeof v !== 'bigint') throw new CborError('E_CBOR_SHAPE', `expected uint, got ${kind(v)}`);
  return v;
}

export function u53(v: CborValue): number {
  const n = u64(v);
  if (n > BigInt(Number.MAX_SAFE_INTEGER)) throw new CborError('E_CBOR_RANGE', 'uint exceeds safe number');
  return Number(n);
}

export function bin(v: CborValue, length?: number): Uint8Array {
  if (!(v instanceof Uint8Array) || (length !== undefined && v.length !== length)) {
    throw new CborError('E_CBOR_SHAPE', `expected bytes${length === undefined ? '' : ` of ${length}`}, got ${kind(v)}`);
  }
  return v;
}

export function str(v: CborValue): string {
  if (typeof v !== 'string') throw new CborError('E_CBOR_SHAPE', `expected text, got ${kind(v)}`);
  return v;
}

export function opt<T>(v: CborValue, read: (v: CborValue) => T): T | null {
  return v === null ? null : read(v);
}
