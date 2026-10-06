import { decode, encode, type CborValue } from '../cbor';
import type { Id } from '../core-port';

/** One entry of a fake device list. `dskPub` absent means the device's own key, fakeDskPub(deviceId): a real list
 *  always names the key, and "listed" is the (device_id, dsk_pub) pair (protocol/02 item 4, security review F2). */
export interface FakeListEntry { deviceId: Id; revokedAt: bigint | null; dskPub?: Id; }
export interface FakeList { userId: Id; entries: FakeListEntry[]; at: bigint; }

/** The signing key every double gives a device unless a test says otherwise: distinct per device id, so that the
 *  instance's one-live-row-per-key rule (409) never trips over two devices of one account. */
export function fakeDskPub(deviceId: Id): Uint8Array {
  const key = new Uint8Array(32).fill(0x6b);
  key.set(deviceId.subarray(0, 16));
  return key;
}

export function fakeListBlob(userId: Id, entries: readonly FakeListEntry[], at: bigint): Uint8Array {
  return encode(['fake.list', userId, entries.map((entry) => entry.dskPub === undefined
    ? [entry.deviceId, entry.revokedAt] : [entry.deviceId, entry.revokedAt, entry.dskPub]), at]);
}

function entry(value: CborValue): FakeListEntry | null {
  if (!Array.isArray(value) || (value.length !== 2 && value.length !== 3) || !(value[0] instanceof Uint8Array) ||
      value[0].length !== 16 || (value[1] !== null && typeof value[1] !== 'bigint')) return null;
  if (value.length === 2) return { deviceId: value[0], revokedAt: value[1] };
  if (!(value[2] instanceof Uint8Array) || value[2].length !== 32) return null;
  return { deviceId: value[0], revokedAt: value[1], dskPub: value[2] };
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

const same = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((x, i) => x === b[i]);

/** The key an entry names: its own, or the device's default. */
export function entryKey(entry: FakeListEntry): Uint8Array {
  return entry.dskPub ?? fakeDskPub(entry.deviceId);
}

/** Whether an unrevoked entry names deviceId; with dskPub, whether it names the pair (the instance's "listed"). */
export function fakeListNames(list: FakeList, deviceId: Id, dskPub?: Uint8Array): boolean {
  return list.entries.some((entry) => entry.revokedAt === null && same(entry.deviceId, deviceId) &&
    (dskPub === undefined || same(entryKey(entry), dskPub)));
}
