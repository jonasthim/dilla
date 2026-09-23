import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractCopy, findForbidden } from './check-ui-copy.mjs';

test('extracts string literals and JSX text, not identifiers', () => {
  const src = `const team = 1; export function X() { return <span title="Leave voice">Message #loot {team} 'kanal'</span>; }`;
  const copy = extractCopy(src);
  assert.ok(copy.includes('Leave voice'));
  assert.ok(copy.includes('Message #loot'));
  assert.ok(copy.includes('kanal'));
  assert.ok(!copy.some(c => c.trim() === 'team'));
});

test('flags forbidden vocabulary and encryption markers, case-insensitively', () => {
  assert.deepEqual(findForbidden(['Message #loot']), []);
  assert.deepEqual(findForbidden(['Your kanals']).map(f => f.word), ['kanal']);
  assert.deepEqual(findForbidden(['messages are end-to-end encrypted']).map(f => f.word), ['end-to-end', 'encrypted']);
  assert.deepEqual(findForbidden(['E2E', 'SRTP · OPUS', 'Signal Protocol', 'SQLCipher', 'AES-256', 'via MLS', 'PMs']).map(f => f.word), ['E2E', 'SRTP', 'Signal Protocol', 'SQLCipher', 'AES-256', 'MLS', 'PMs']);
});

test('allows the readable glyph accessible name', () => {
  assert.deepEqual(findForbidden(['Readable by this server']), []);
});
