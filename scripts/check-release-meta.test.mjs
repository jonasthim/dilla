import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { checkReleaseMeta } from './check-release-meta.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** A tree with internal/sfu/level.go at the given min level and the given notes ({ tag: row-or-null }). */
function tree({ min = 1, notes }) {
  const root = mkdtempSync(join(tmpdir(), 'check-release-meta-'));
  mkdirSync(join(root, 'internal', 'sfu'), { recursive: true });
  mkdirSync(join(root, 'docs', 'deploy', 'releases'), { recursive: true });
  writeFileSync(join(root, 'internal', 'sfu', 'level.go'), `package sfu\n\nconst MediaLevel = 2\n\nconst MinSFUMediaLevel = ${min}\n`);
  for (const [tag, row] of Object.entries(notes)) {
    writeFileSync(join(root, 'docs', 'deploy', 'releases', `${tag}.md`), `# ${tag}\n\n## Versions\n\n| | x | y |\n|---|---|---|\n${row === null ? '' : `| Media server (SFU) | ${row} | z |\n`}`);
  }
  return root;
}

test('the real tree passes', () => {
  assert.deepEqual(checkReleaseMeta(REPO_ROOT), []);
});

test('web3.12 after web3.11: no file means level 1, so min 1 is when-idle and a row saying required is refused', () => {
  assert.deepEqual(checkReleaseMeta(tree({ notes: { 'v0.1.0-web3.11': null, 'v0.1.0-web3.12': "when-idle (level 2, keeps web3.11's level 1)" } })), []);
  const problems = checkReleaseMeta(tree({ notes: { 'v0.1.0-web3.11': null, 'v0.1.0-web3.12': 'required (level 2)' } }));
  assert.equal(problems.length, 1);
  assert.match(problems[0], /v0\.1\.0-web3\.12\.md: .*says required, but min_sfu_media_level 1 against v0\.1\.0-web3\.11 \(no release\.json: web3\.11 = media level 1\) is when-idle/);
});

test('a tree whose min is above the baseline must announce required', () => {
  assert.deepEqual(checkReleaseMeta(tree({ min: 2, notes: { 'v0.1.0-web3.12': 'required (level 2)' } })), []);
  assert.equal(checkReleaseMeta(tree({ min: 2, notes: { 'v0.1.0-web3.12': 'when-idle (level 2)' } })).length, 1);
});

test('the previous release is the next older notes with a row, and its level counts', () => {
  const notes = { 'v0.1.0-web3.12': 'when-idle (level 2)', 'v0.1.0-web3.12.1': null, 'v0.1.0-web3.13': 'when-idle (level 3)' };
  assert.deepEqual(checkReleaseMeta(tree({ min: 2, notes })), []);
  assert.equal(checkReleaseMeta(tree({ min: 3, notes })).length, 1);
});

test('a row without exactly one of the two words, or a previous row without its level, is refused', () => {
  assert.match(checkReleaseMeta(tree({ notes: { 'v0.1.0-web3.12': 'sometimes' } }))[0], /exactly one of when-idle or required/);
  assert.match(checkReleaseMeta(tree({ notes: { 'v0.1.0-web3.12': 'when-idle', 'v0.1.0-web3.13': 'when-idle (level 3)' } }))[0], /web3\.12\.md: .*"level N"/);
});

test('notes with no row anywhere pass: older releases have none', () => {
  assert.deepEqual(checkReleaseMeta(tree({ notes: { 'v0.1.0-web3.11': null, 'v0.1.0-web3.12': null } })), []);
});

test('the CLI exits 1 with the problem on stderr', () => {
  const root = tree({ notes: { 'v0.1.0-web3.12': 'required (level 2)' } });
  const r = spawnSync('node', [join(REPO_ROOT, 'scripts', 'check-release-meta.mjs'), root], { encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /says required/);
});
