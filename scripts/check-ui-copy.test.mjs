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

test('does not read an identifier inside ${…} as copy', () => {
  // `kanal` here is a variable name, not a word on screen. Flagging it
  // would make the lint unusable in any component that interpolates.
  const copy = extractCopy('const label = `${kanal} unread`;');
  assert.ok(copy.includes('unread'));
  assert.ok(!copy.some(c => c.includes('kanal')));
  assert.deepEqual(findForbidden(copy), []);
});

test('still catches forbidden copy outside ${…} in a template literal', () => {
  const copy = extractCopy('const label = `${count} kanals`;');
  assert.deepEqual(findForbidden(copy).map(f => f.word), ['kanal']);
});

test('allows the readable glyph accessible name', () => {
  assert.deepEqual(findForbidden(['Readable by this server']), []);
});
