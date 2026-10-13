import { expect, it } from 'vitest';
import { encode } from '../cbor';
import { decodeSearchHits, validateSearch } from './search';
const gid = new Uint8Array(16).fill(7);
it('rejects unbounded hits and snippets', () => {
  expect(decodeSearchHits(encode([[gid, 2, 'boat', 0]]))).toMatchObject([{ seq: 2n, snippet: 'boat', rank: 0n }]);
  expect(() => decodeSearchHits(encode(Array.from({ length: 51 }, () => [gid, 2, 'boat', 0])))).toThrow();
  expect(() => decodeSearchHits(encode([[gid, 2, 'a'.repeat(161), 0]]))).toThrow();
  expect(() => decodeSearchHits(Uint8Array.of(0x98, 51))).toThrow('limit');
});
it('checks UTF-8 query bytes and the zero-rank cursor', () => {
  expect(() => validateSearch({ kind: 'all', id: null }, 'å'.repeat(65), null, 50)).toThrow('E_CORE_INPUT');
  expect(() => validateSearch({ kind: 'all', id: null }, 'boat', { rank: 1n, groupId: gid, seq: 2n }, 50)).toThrow('E_CORE_INPUT');
  expect(() => validateSearch({ kind: 'channel', id: null }, 'boat', null, 50)).toThrow('E_CORE_INPUT');
});
