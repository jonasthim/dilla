import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ALLOWED_FILES, ROOTS, checkUiCopy, extractCopy, findForbidden } from './check-ui-copy.mjs';

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

function tree(files) {
  const root = mkdtempSync(join(tmpdir(), 'copy-lint-'));
  for (const [rel, text] of Object.entries(files)) {
    const path = join(root, ...rel.split('/'));
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, text);
  }
  return root;
}

const PLANTED = "export const line = 'messages are encrypted';\n";

test('scans the three roots of the web wave and allows one file', () => {
  assert.deepEqual(ROOTS, ['packages/ui/src', 'packages/web/src', 'packages/client-core/src']);
  assert.deepEqual(ALLOWED_FILES, ['packages/web/src/strings/privacy.ts']);
});

test('reports a planted word in every root', (t) => {
  const files = ['packages/ui/src/A.tsx', 'packages/web/src/screens/B.tsx', 'packages/client-core/src/c.ts'];
  const root = tree(Object.fromEntries(files.map((f) => [f, PLANTED])));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const problems = checkUiCopy(root);
  assert.equal(problems.length, 3);
  for (const rel of files) {
    assert.ok(problems.some((p) => p.startsWith(join(root, ...rel.split('/')) + ': "encrypted"')), rel);
  }
});

test('scans test files and stories too', (t) => {
  const root = tree({
    'packages/client-core/src/x.test.ts': "it('speaks MLS', () => {});\n",
    'packages/ui/src/X/X.stories.tsx': "export default { title: 'E2EE badge' };\n",
  });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const problems = checkUiCopy(root);
  assert.equal(problems.length, 2);
  assert.ok(problems.some((p) => p.includes('"MLS"')));
  assert.ok(problems.some((p) => p.includes('"E2E"')));
});

test('exempts only the allow-listed privacy strings', (t) => {
  const root = tree({
    'packages/web/src/strings/privacy.ts': PLANTED,
    'packages/web/src/strings/en.ts': PLANTED,
  });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const problems = checkUiCopy(root);
  assert.equal(problems.length, 1);
  assert.ok(problems[0].startsWith(join(root, 'packages', 'web', 'src', 'strings', 'en.ts') + ':'));
});

test('skips a root that does not exist', (t) => {
  const root = tree({ 'packages/ui/src/A.tsx': "export const ok = 'Message #loot';\n" });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.deepEqual(checkUiCopy(root), []);
});
