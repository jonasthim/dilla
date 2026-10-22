import { describe, expect, it, vi } from 'vitest';
import { encode, type CborInput } from '../cbor';
import { readDeviceListHistory } from './trust';
import { CoreError } from '../core-port';
import { decodePendingLeaves, decodeTrustState, historyFrom } from './trust';

const id16 = (n: number): Uint8Array => new Uint8Array(16).fill(n);
const key32 = (n: number): Uint8Array => new Uint8Array(32).fill(n);
const list = (version: number): Uint8Array => encode([version, new Uint8Array([version]), new Uint8Array(64), key32(version)]);
const history = (versions: number[]): Uint8Array => encode(versions.map((v) => [v, new Uint8Array([v]), new Uint8Array(64), key32(v)]));
function routes(heads: (number | null)[], pages: Record<number, number[]>) {
  let reads = 0;
  return {
    getDeviceList: (_user: Uint8Array) => {
      void _user;
      const v = heads[Math.min(reads++, heads.length - 1)];
      return Promise.resolve(v == null ? null : { version: BigInt(v), blob: new Uint8Array([v]), raw: list(v) });
    },
    getDeviceListHistory: (_user: Uint8Array, after: bigint) => {
      void _user;
      const versions = pages[Number(after)] ?? [];
      return Promise.resolve({ raw: history(versions), count: versions.length, lastVersion: versions.length ? BigInt(versions[versions.length - 1]) : null });
    },
  };
}
it('bounds core-owned pending and trust rows before copying', () => {
  expect(decodePendingLeaves(encode([[id16(1), 0, id16(2), 0, 'unknown']]))).toMatchObject([{ leafIndex: 0, reason: 'unknown' }]);
  expect(() => decodePendingLeaves(encode(Array.from({ length: 4097 }, () => [id16(1), 0, id16(2), 0, 'unknown'])))).toThrow(CoreError);
  expect(decodeTrustState(encode([[id16(2), key32(4), 12, 0, null, null]]))).toMatchObject([{ firstSeen: 12n, verified: false, blocked: null }]);
  expect(() => decodeTrustState(encode([[id16(2), new Uint8Array(31), 12, 0, null, null]]))).toThrow(CoreError);
  expect(() => decodePendingLeaves(Uint8Array.of(0x99, 0x10, 0x01))).toThrow('limit');
});
// ABI 8: the sixth element is the stored verdict of the user's leaves still in an active group (E_UMK_CHANGED wins).
it('reads the ABI-8 blocked verdict of a trust row and refuses the ABI-7 five-element row', () => {
  for (const code of ['E_UMK_CHANGED', 'E_CREDENTIAL', 'E_DEVICE_UNLISTED', 'E_TIER_MISMATCH'] as const)
    expect(decodeTrustState(encode([[id16(2), key32(4), 12, 1, null, code]]))).toMatchObject([{ verified: true, blocked: code }]);
  expect(decodeTrustState(encode([[id16(2), key32(4), 12, 0, key32(5), 'E_UMK_CHANGED']]))[0]?.changedUmk).toEqual(key32(5));
  // A code the page has no copy for fails closed as a failed identity check, as the core's own block_code does.
  expect(decodeTrustState(encode([[id16(2), key32(4), 12, 1, null, 'E_SOMETHING_NEW']]))[0]?.blocked).toBe('E_CREDENTIAL');
  expect(() => decodeTrustState(encode([[id16(2), key32(4), 12, 0, null]]))).toThrow(CoreError);
  expect(() => decodeTrustState(encode([[id16(2), key32(4), 12, 0, null, 7]]))).toThrow(CoreError);
});
it('accepts a complete signed history ending at the unchanged head', async () => {
  const result = await readDeviceListHistory(routes([3, 3], { 0: [1, 2, 3] }), id16(2), 0n);
  expect(result.head).toEqual(list(3));
  expect(result.history).toEqual(history([1, 2, 3]));
});
it('slices a history from the version the core cached, and answers null when nothing is left or it does not decode', () => {
  expect(historyFrom(history([1, 2, 3]), 2n)).toEqual(history([2, 3]));
  expect(historyFrom(history([1, 2, 3]), 0n)).toEqual(history([1, 2, 3]));
  expect(historyFrom(history([1, 2, 3]), 4n)).toBeNull();
  expect(historyFrom(new Uint8Array([0xff]), 1n)).toBeNull();
});
it('rejects gap, empty page, short page and a 65-row page', async () => {
  for (const pages of [{ 0: [1, 3] }, { 0: [] }, { 0: [1, 2] }, { 0: Array.from({ length: 65 }, (_, i) => i + 1) }]) {
    await expect(readDeviceListHistory(routes([3, 3], pages), id16(2), 0n))
      .rejects.toMatchObject({ code: 'E_DEVICE_LIST_STALE' });
  }
});
it('retries one changed head and refuses a second change', async () => {
  await expect(readDeviceListHistory(routes([2, 3, 3, 4], { 0: [1, 2, 3] }), id16(2), 0n))
    .rejects.toMatchObject({ code: 'E_DEVICE_LIST_STALE' });
  await expect(readDeviceListHistory(routes([null], { 0: [1] }), id16(2), 0n))
    .rejects.toMatchObject({ code: 'E_DEVICE_LIST_STALE' });
});

it('retries a page that overtakes its candidate head once', async () => {
  let reads = 0;
  let pages = 0;
  const route = {
    getDeviceList: () => {
      const version = [2, 3, 3, 3][Math.min(reads++, 3)];
      return Promise.resolve({ version: BigInt(version), blob: new Uint8Array([version]), raw: list(version) });
    },
    getDeviceListHistory: () => {
      pages += 1;
      const versions = [1, 2, 3];
      return Promise.resolve({ raw: history(versions), count: 3, lastVersion: 3n });
    },
  };
  const result = await readDeviceListHistory(route, id16(2), 0n);
  expect(result.head).toEqual(list(3));
  expect(result.history).toEqual(history([1, 2, 3]));
  expect(pages).toBe(2);
});

it('uses the unchanged candidate as the cached signed anchor without paging', async () => {
  let pageCalls = 0;
  const route = {
    getDeviceList: () => Promise.resolve({ version: 3n, blob: new Uint8Array([3]), raw: list(3) }),
    getDeviceListHistory: () => {
      pageCalls += 1;
      return Promise.resolve({ raw: history([3]), count: 1, lastVersion: 3n });
    },
  };
  const result = await readDeviceListHistory(route, id16(2), 3n);
  expect(result.head).toEqual(list(3));
  expect(result.history).toEqual(history([3]));
  expect(pageCalls).toBe(0);
});

const USER = new Uint8Array(16).fill(7);
const body = (version: number): Uint8Array => new Uint8Array([version]);
const row = (version: number): CborInput[] => [version, body(version), new Uint8Array(64), new Uint8Array(32)];

describe('readDeviceListHistory', () => {
  it('rejects an oversized page before decoding its rows', async () => {
    const routes = {
      getDeviceList: vi.fn(() => Promise.resolve({ version: 1n, blob: body(1), raw: encode(row(1)) })),
      getDeviceListHistory: vi.fn(() => Promise.resolve({ raw: new Uint8Array(4 * 1024 * 1024 + 1), count: 1, lastVersion: 1n })),
    };
    await expect(readDeviceListHistory(routes as never, USER, 0n)).rejects.toMatchObject({ code: 'E_DEVICE_LIST_STALE' });
  });
  it('rejects a page whose advertised last version disagrees with its signed rows', async () => {
    const routes = {
      getDeviceList: vi.fn(() => Promise.resolve({ version: 1n, blob: body(1), raw: encode(row(1)) })),
      getDeviceListHistory: vi.fn(() => Promise.resolve({ raw: encode([row(1)]), count: 1, lastVersion: 2n })),
    };
    await expect(readDeviceListHistory(routes as never, USER, 0n)).rejects.toMatchObject({ code: 'E_DEVICE_LIST_STALE' });
  });
});
