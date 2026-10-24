import { arr, decode, encode, u64, type CborValue } from '../cbor/index.ts';

export const MAX_KEYPACKAGE_UPLOAD_BODY = 1_047_296;
export const HELPER_PAYLOAD_MAX = 1_048_480;
const MAX_I64 = (1n << 63n) - 1n;

export class KeyPackageCodecError extends Error {
  constructor() {
    super('E_KEYPACKAGE_CONTRACT');
    this.name = 'KeyPackageCodecError';
  }
}

const fail = (): never => { throw new KeyPackageCodecError(); };

function bytes(value: unknown, expectedLength?: number): Uint8Array {
  if (!(value instanceof Uint8Array) ||
      (expectedLength !== undefined && value.length !== expectedLength)) {
    return fail();
  }
  return value;
}

function uint(value: unknown, min = 0n, max = MAX_I64): bigint {
  try {
    const result = u64(value as CborValue);
    if (result < min || result > max) return fail();
    return result;
  } catch {
    return fail();
  }
}

function id(value: unknown): Uint8Array {
  const result = bytes(value, 16);
  if (result.every((byte) => byte === 0)) return fail();
  return result;
}

function refs(value: unknown, min = 1, max = 33): Uint8Array[] {
  if (!Array.isArray(value) || value.length < min || value.length > max) return fail();
  const result = value.map((ref) => bytes(ref, 32));
  const keys = result.map((ref) => Array.from(ref).join(','));
  if (new Set(keys).size !== result.length) return fail();
  return result;
}

function uploadCount(raw: Uint8Array): number {
  if (raw.length > MAX_KEYPACKAGE_UPLOAD_BODY) return fail();

  let value: CborValue;
  try {
    value = decode(raw);
  } catch {
    return fail();
  }

  const fields = arr(value, 2);
  const packages = fields[0];
  if (!Array.isArray(packages) || packages.length < 1 || packages.length > 32) return fail();
  for (const packageBytes of packages) {
    if (bytes(packageBytes).length === 0) return fail();
  }

  let count = packages.length;
  if (fields[1] !== null) {
    if (bytes(fields[1]).length === 0) return fail();
    count++;
  }
  if (!equal(encode(fields), raw)) return fail();
  return count;
}

function equal(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, index) => byte === b[index]);
}

function parse(raw: Uint8Array, length: number): CborValue[] {
  if (raw.length === 0 || raw.length > HELPER_PAYLOAD_MAX) return fail();
  let value: CborValue;
  try {
    value = decode(raw);
  } catch {
    return fail();
  }
  return arr(value, length);
}

export interface KeyPackagePublication {
  operationId: Uint8Array;
  expectedGeneration: bigint;
  uploadBody: Uint8Array;
}

export interface KeyPackagePublicationReceipt {
  expectedGeneration: bigint;
  uploadSha256: Uint8Array;
  count: bigint;
}

export interface KeyPackageIntent {
  operationId: Uint8Array;
  count: bigint;
  lastResort: bigint;
  expectedGeneration: bigint;
}

export interface KeyPackageIntentResult {
  uploadBody: Uint8Array;
  packageRefs: Uint8Array[];
  greatestExpiry: bigint;
}

export interface KeyPackageResolution {
  operationId: Uint8Array;
  packageRefs: Uint8Array[];
  outcome: bigint;
  now: bigint;
  currentGeneration: bigint;
}

export function decodeKeyPackagePublication(raw: Uint8Array): KeyPackagePublication {
  const fields = parse(raw, 3);
  const result = {
    operationId: id(fields[0]),
    expectedGeneration: uint(fields[1]),
    uploadBody: bytes(fields[2]),
  };
  uploadCount(result.uploadBody);
  return result;
}

export function encodeKeyPackagePublication(value: KeyPackagePublication): Uint8Array {
  id(value.operationId);
  uint(value.expectedGeneration);
  uploadCount(value.uploadBody);
  return encode([value.operationId, value.expectedGeneration, value.uploadBody]);
}

export function decodeKeyPackagePublicationReceipt(raw: Uint8Array): KeyPackagePublicationReceipt {
  const fields = parse(raw, 3);
  return {
    expectedGeneration: uint(fields[0]),
    uploadSha256: bytes(fields[1], 32),
    count: uint(fields[2], 1n, 33n),
  };
}

export function encodeKeyPackagePublicationReceipt(value: KeyPackagePublicationReceipt): Uint8Array {
  uint(value.expectedGeneration);
  bytes(value.uploadSha256, 32);
  uint(value.count, 1n, 33n);
  return encode([value.expectedGeneration, value.uploadSha256, value.count]);
}

export function decodeKeyPackageIntent(raw: Uint8Array): KeyPackageIntent {
  const fields = parse(raw, 4);
  return {
    operationId: id(fields[0]),
    count: uint(fields[1], 1n, 32n),
    lastResort: uint(fields[2], 0n, 1n),
    expectedGeneration: uint(fields[3]),
  };
}

export function encodeKeyPackageIntent(value: KeyPackageIntent): Uint8Array {
  id(value.operationId);
  uint(value.count, 1n, 32n);
  uint(value.lastResort, 0n, 1n);
  uint(value.expectedGeneration);
  return encode([value.operationId, value.count, value.lastResort, value.expectedGeneration]);
}

export function decodeKeyPackageIntentResult(raw: Uint8Array): KeyPackageIntentResult {
  const fields = parse(raw, 3);
  const uploadBody = bytes(fields[0]);
  const count = uploadCount(uploadBody);
  const packageRefs = refs(fields[1]);
  if (packageRefs.length !== count) return fail();
  return { uploadBody, packageRefs, greatestExpiry: uint(fields[2]) };
}

export function encodeKeyPackageIntentResult(value: KeyPackageIntentResult): Uint8Array {
  const count = uploadCount(value.uploadBody);
  const packageRefs = refs(value.packageRefs);
  if (packageRefs.length !== count) return fail();
  uint(value.greatestExpiry);
  const result = encode([value.uploadBody, packageRefs, value.greatestExpiry]);
  if (result.length > HELPER_PAYLOAD_MAX) return fail();
  return result;
}

export function decodeKeyPackageResolution(raw: Uint8Array): KeyPackageResolution {
  const fields = parse(raw, 5);
  return {
    operationId: id(fields[0]),
    packageRefs: refs(fields[1]),
    outcome: uint(fields[2], 0n, 1n),
    now: uint(fields[3]),
    currentGeneration: uint(fields[4]),
  };
}

export function encodeKeyPackageResolution(value: KeyPackageResolution): Uint8Array {
  id(value.operationId);
  const packageRefs = refs(value.packageRefs);
  uint(value.outcome, 0n, 1n);
  uint(value.now);
  uint(value.currentGeneration);
  return encode([value.operationId, packageRefs, value.outcome, value.now, value.currentGeneration]);
}
