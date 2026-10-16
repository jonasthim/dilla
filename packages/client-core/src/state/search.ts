import { arr, bin, opt, str, u64 } from '../cbor';
import { decodeBoundedArray } from './bounded';
import { CoreError, type SearchCursor, type SearchHit, type SearchScope } from '../core-port';

const invalid = (): never => { throw new CoreError('E_CORE_INPUT'); };
const malformed = (error: unknown): never => { throw new CoreError('E_CORE_WASM', String(error)); };
const id = (value: unknown): boolean => value instanceof Uint8Array && value.length === 16;

export function validateSearch(scope: SearchScope, query: string, cursor: SearchCursor | null, limit: number): void {
  if ((scope.kind !== 'channel' && scope.kind !== 'community' && scope.kind !== 'all') ||
    (scope.kind === 'all' ? scope.id !== null : !id(scope.id)) ||
    typeof query !== 'string' || new TextEncoder().encode(query.trim()).length < 1 ||
    new TextEncoder().encode(query.trim()).length > 128 || !Number.isInteger(limit) || limit < 1 || limit > 50) invalid();
  if (cursor !== null && (cursor.rank !== 0n || !id(cursor.groupId) || cursor.seq < 0n || cursor.seq > 0xffff_ffff_ffff_ffffn)) invalid();
}

export function decodeSearchHits(bytes: Uint8Array): SearchHit[] {
  try {
    const rows = decodeBoundedArray(bytes, 50);
    return rows.map((value) => {
      // Five elements since web3.7 fix round 1 (the 5th the thread root); four from a core before it.
      const row = arr(value);
      if (row.length !== 4 && row.length !== 5) malformed('hit length');
      const snippet = str(row[2]);
      if (Array.from(snippet).length > 160) malformed('snippet limit');
      const rank = u64(row[3]);
      if (rank !== 0n) malformed('rank');
      return { groupId: bin(row[0], 16), seq: u64(row[1]), snippet, rank, threadRoot: opt(row[4] ?? null, (x) => bin(x, 16)) };
    });
  } catch (error) { return malformed(error); }
}
