import { arr, bin, decode, encode, u64, type CborValue } from '../cbor';
import { CoreError, type Id } from '../core-port';
import type { Routes } from '../http/routes';

type ReaderRoutes = Pick<Routes, 'getDeviceList' | 'getDeviceListHistory'>;
const MAX_VERSIONS = 1024;
const MAX_BYTES = 4 * 1024 * 1024;
const PAGE = 64;
const equal = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((v, i) => v === b[i]);

/** Read a stable signed candidate and its bounded contiguous history. The core authenticates every signature. */
export async function readDeviceListHistory(routes: ReaderRoutes, userId: Id, cachedVersion: bigint): Promise<{ head: Uint8Array; history: Uint8Array }> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const candidate = await routes.getDeviceList(userId);
    if (candidate === null || candidate.version < 1n || candidate.version < cachedVersion) throw new CoreError('E_DEVICE_LIST_STALE');
    let after = cachedVersion > 0n ? cachedVersion - 1n : 0n;
    const rows: CborValue[] = [];
    let bytes = 0;
    while (after < candidate.version) {
      const page = await routes.getDeviceListHistory(userId, after);
      const got = arr(decode(page.raw));
      if (got.length === 0 || got.length > PAGE || got.length !== page.count) throw new CoreError('E_DEVICE_LIST_STALE');
      for (const value of got) {
        const row = arr(value, 4);
        const version = u64(row[0]);
        if (version !== after + 1n || version > candidate.version) throw new CoreError('E_DEVICE_LIST_STALE');
        bin(row[1]); bin(row[2], 64); bin(row[3], 32);
        rows.push(row);
        after = version;
      }
      if (page.lastVersion !== after) throw new CoreError('E_DEVICE_LIST_STALE');
      bytes += page.raw.length;
      if (rows.length > MAX_VERSIONS || bytes > MAX_BYTES) throw new CoreError('E_DEVICE_LIST_STALE');
    }
    const last = arr(rows[rows.length - 1], 4);
    if (!equal(bin(last[1]), candidate.blob)) throw new CoreError('E_DEVICE_LIST_STALE');
    const rechecked = await routes.getDeviceList(userId);
    if (rechecked !== null && rechecked.version === candidate.version && equal(rechecked.blob, candidate.blob)) {
      const history = encode(rows);
      if (history.length > MAX_BYTES) throw new CoreError('E_DEVICE_LIST_STALE');
      return { head: candidate.blob, history };
    }
  }
  throw new CoreError('E_DEVICE_LIST_STALE');
}
