import { decode, encode, type CborValue } from '../cbor';
import type { Id } from '../core-port';

export interface FakeListEntry { deviceId: Id; revokedAt: bigint | null; }
export interface FakeList { userId: Id; entries: FakeListEntry[]; at: bigint; }

export function fakeListBlob(userId: Id, entries: readonly FakeListEntry[], at: bigint): Uint8Array {
  return encode(['fake.list', userId, entries.map((entry) => [entry.deviceId, entry.revokedAt]), at]);
}

function entry(value: CborValue): FakeListEntry | null {
  if (!Array.isArray(value) || value.length !== 2 || !(value[0] instanceof Uint8Array) || value[0].length !== 16 ||
      (value[1] !== null && typeof value[1] !== 'bigint')) return null;
  return { deviceId: value[0], revokedAt: value[1] };
}

export function readFakeList(blob: Uint8Array): FakeList | null {
  try {
    const value = decode(blob);
    if (!Array.isArray(value) || value.length !== 4 || value[0] !== 'fake.list' ||
        !(value[1] instanceof Uint8Array) || value[1].length !== 16 || typeof value[3] !== 'bigint') return null;
    if (value[2] instanceof Uint8Array) {
      if (value[2].length !== 16) return null;
      return { userId: value[1], entries: [{ deviceId: value[2], revokedAt: null }], at: value[3] };
    }
    if (!Array.isArray(value[2])) return null;
    const entries: FakeListEntry[] = [];
    for (const item of value[2]) {
      const parsed = entry(item);
      if (parsed === null) return null;
      entries.push(parsed);
    }
    return { userId: value[1], entries, at: value[3] };
  } catch {
    return null;
  }
}

export function fakeListNames(list: FakeList, deviceId: Id): boolean {
  return list.entries.some((entry) => entry.revokedAt === null && entry.deviceId.length === deviceId.length &&
    entry.deviceId.every((byte, index) => byte === deviceId[index]));
}
