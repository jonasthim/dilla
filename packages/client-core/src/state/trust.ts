import { arr, bin, decode, encode, str, u53, u64, type CborValue } from '../cbor';
import { decodeBoundedArray } from './bounded';
import { CoreError, type Id, type PendingLeaf, type TrustRecord } from '../core-port';
import type { Routes } from '../http/routes';

type ReaderRoutes = Pick<Routes, 'getDeviceList' | 'getDeviceListHistory'>;
const MAX_VERSIONS = 1024;
const MAX_BYTES = 4_194_304;
const PAGE = 64;
const MAX_REPLY_ROWS = 4096;
const equal = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((v, i) => v === b[i]);
const stale = (): never => { throw new CoreError('E_DEVICE_LIST_STALE'); };
const malformed = (error: unknown): never => { throw new CoreError('E_CORE_WASM', String(error)); };

export function decodePendingLeaves(bytes: Uint8Array): PendingLeaf[] {
  try {
    const rows = decodeBoundedArray(bytes, MAX_REPLY_ROWS);
    return rows.map((value) => {
      const row = arr(value, 5);
      const leafIndex = u53(row[1]);
      if (leafIndex > 0xffff_ffff) return malformed('leaf index');
      const reason = str(row[4]);
      if (reason !== 'unknown' && reason !== 'changed' && reason !== 'ready-refresh') return malformed('leaf reason');
      return { groupId: bin(row[0], 16), leafIndex, userId: bin(row[2], 16), cachedVersion: u64(row[3]), reason };
    });
  } catch (error) { return malformed(error); }
}

export function decodeTrustState(bytes: Uint8Array): TrustRecord[] {
  try {
    const rows = decodeBoundedArray(bytes, MAX_REPLY_ROWS);
    return rows.map((value) => {
      const row = arr(value, 5);
      const verified = u53(row[3]);
      if (verified !== 0 && verified !== 1) return malformed('verified bit');
      return { userId: bin(row[0], 16), umk: bin(row[1], 32), firstSeen: u64(row[2]), verified: verified === 1,
        changedUmk: row[4] === null ? null : bin(row[4], 32) };
    });
  } catch (error) { return malformed(error); }
}

/**
 * The core's `head_list`: the signed DeviceList inside the reader's candidate head row [version, list, ssk_signature,
 * prev_hash]. The core decodes and caches exactly these bytes (trust.rs `bounded_list`), as the native peer passes them.
 */
export function signedHeadList(head: Uint8Array): Uint8Array {
  try { return bin(arr(decode(head), 4)[1]); } catch { return stale(); }
}

/** The server supplies bytes; the Rust core authenticates all signatures and leaf evidence. */
export async function readDeviceListHistory(routes: ReaderRoutes, userId: Id, cachedVersion: bigint): Promise<{ head: Uint8Array; history: Uint8Array }> {
  if (!(userId instanceof Uint8Array) || userId.length !== 16 || cachedVersion < 0n) stale();
  let budgetBytes = 0;
  let budgetRows = 0;
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const candidate = await routes.getDeviceList(userId);
      if (candidate === null || candidate.raw.length > 1_048_576 || candidate.version < cachedVersion) return stale();
      const candidateRow = arr(decode(candidate.raw), 4);
      if (u64(candidateRow[0]) !== candidate.version || !equal(bin(candidateRow[1]), candidate.blob)) stale();
      bin(candidateRow[2], 64); bin(candidateRow[3], 32);
      if (candidate.version - cachedVersion > BigInt(MAX_VERSIONS)) stale();
      // Rust validates the cached signed row as the first history anchor before accepting newer rows.
      let after = cachedVersion > 0n ? cachedVersion - 1n : 0n;
      const rows: CborValue[] = [];
      if (candidate.version === cachedVersion) {
        rows.push(candidateRow);
        after = candidate.version;
        budgetRows += 1;
        budgetBytes += candidate.raw.length;
        if (budgetRows > MAX_VERSIONS || budgetBytes > MAX_BYTES) stale();
      }
      let overranCandidate = false;
      while (after < candidate.version) {
        const page = await routes.getDeviceListHistory(userId, after);
        budgetBytes += page.raw.length;
        if (page.raw.length > 1_048_576 || budgetBytes > MAX_BYTES || page.count < 1 || page.count > PAGE) stale();
        const got = decodeBoundedArray(page.raw, PAGE);
        if (got.length !== page.count || budgetRows + got.length > MAX_VERSIONS) stale();
        for (const value of got) {
          const row = arr(value, 4);
          const version = u64(row[0]);
          if (version !== after + 1n) stale();
          if (version > candidate.version) { overranCandidate = true; break; }
          bin(row[1]); bin(row[2], 64); bin(row[3], 32);
          rows.push(row);
          after = version;
        }
        budgetRows += got.length;
        if (overranCandidate) break;
        if (page.lastVersion !== after) stale();
      }
      if (rows.length < 1 || !equal(encode(rows[rows.length - 1]), candidate.raw)) stale();
      const head = await routes.getDeviceList(userId);
      if (overranCandidate && (head === null || head.version <= candidate.version)) stale();
      if (head !== null && head.version === candidate.version && equal(head.raw, candidate.raw)) {
        const history = encode(rows);
        if (history.length > MAX_BYTES) stale();
        return { head: candidate.raw, history };
      }
    }
  } catch { return stale(); }
  return stale();
}
