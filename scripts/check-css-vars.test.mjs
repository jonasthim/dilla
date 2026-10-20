import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkCssVars } from './check-css-vars.mjs';

function fixture(files) {
  const root = mkdtempSync(join(tmpdir(), 'css-vars-'));
  for (const [rel, text] of Object.entries(files)) {
    const p = join(root, ...rel.split('/'));
    mkdirSync(join(p, '..'), { recursive: true });
    writeFileSync(p, text);
  }
  return root;
}
const TOKENS = { 'packages/design-tokens/dist/tokens.css': ':root {\n  --fg: #fff;\n}\n' };

test('a var() with no fallback and no declaration fails and is named with file:line', () => {
  const root = fixture({ ...TOKENS, 'packages/web/src/a.css': '.a { color: var(--fg); }\n.b {\n  padding: var(--nope);\n}\n' });
  try {
    assert.deepEqual(checkCssVars(root), ['packages/web/src/a.css:3 var(--nope)']);
  } finally { rmSync(root, { recursive: true }); }
});

test('a var() with a fallback passes, also when the name is undeclared', () => {
  const root = fixture({ ...TOKENS, 'packages/ui/src/a.css': '.a { top: var(--d-vvtop, 0px); width: var( --d-sidebar-w , var(--fg)); }\n' });
  try {
    assert.deepEqual(checkCssVars(root), []);
  } finally { rmSync(root, { recursive: true }); }
});

test('a name declared in any scanned css file counts, and a comment is not a use', () => {
  const root = fixture({
    ...TOKENS,
    'packages/ui/src/a.css': '.a { --local: 1px; }\n/* var(--ghost) */\n.b { margin: var(--local); }\n',
    'packages/web/src/b.css': '.c { margin: var(--local); }\n',
  });
  try {
    assert.deepEqual(checkCssVars(root), []);
  } finally { rmSync(root, { recursive: true }); }
});

test('a custom property set in a TSX style object counts as declared', () => {
  const root = fixture({ ...TOKENS, 'packages/ui/src/a.css': '.a { color: hsl(var(--hue) 45% 42%); }\n', 'packages/ui/src/a.tsx': "const s = { ['--hue' as string]: '1' };\n" });
  try {
    assert.deepEqual(checkCssVars(root), []);
  } finally { rmSync(root, { recursive: true }); }
});

test('a quoted name in a story or a test file is not a declaration', () => {
  const root = fixture({
    ...TOKENS,
    'packages/ui/src/a.css': '.a { color: hsl(var(--hue) 45% 42%); padding: var(--gap); }\n',
    'packages/ui/src/a.stories.tsx': "const s = { ['--hue' as string]: '1' };\n",
    'packages/ui/src/a.test.ts': "const t = '--gap';\n",
  });
  try {
    assert.deepEqual(checkCssVars(root), ['packages/ui/src/a.css:1 var(--hue)', 'packages/ui/src/a.css:1 var(--gap)']);
  } finally { rmSync(root, { recursive: true }); }
});

test('the tree itself has no undefined custom property', () => {
  assert.deepEqual(checkCssVars(new URL('..', import.meta.url).pathname), []);
});
