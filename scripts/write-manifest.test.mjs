import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MANIFEST_NAME, buildManifest, main } from './write-manifest.mjs';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'write-manifest.mjs');
const sha = (data) => createHash('sha256').update(data).digest('hex');

function tree() {
  const dir = mkdtempSync(join(tmpdir(), 'dilla-manifest-'));
  mkdirSync(join(dir, 'assets'));
  writeFileSync(join(dir, 'index.html'), '<!doctype html>');
  writeFileSync(join(dir, 'assets', 'b.js'), 'b');
  writeFileSync(join(dir, 'assets', 'a.wasm'), Buffer.from([0, 97, 115, 109]));
  writeFileSync(join(dir, 'Z.txt'), 'z');
  return dir;
}

test('lists every file but the manifest, sorted by path in byte order, with size and sha256', () => {
  const dir = tree();
  writeFileSync(join(dir, MANIFEST_NAME), 'stale');
  assert.deepEqual(buildManifest(dir), {
    v: 1,
    files: [
      { path: 'Z.txt', sha256: sha('z'), size: 1 },
      { path: 'assets/a.wasm', sha256: sha(Buffer.from([0, 97, 115, 109])), size: 4 },
      { path: 'assets/b.js', sha256: sha('b'), size: 1 },
      { path: 'index.html', sha256: sha('<!doctype html>'), size: 15 },
    ],
  });
});

test('main writes one line of JSON and a newline, and answers 0', () => {
  const dir = tree();
  assert.equal(main([dir]), 0);
  assert.equal(readFileSync(join(dir, MANIFEST_NAME), 'utf8'), `${JSON.stringify(buildManifest(dir))}\n`);
});

test('main refuses a directory without index.html and writes nothing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dilla-manifest-'));
  writeFileSync(join(dir, 'other.html'), 'x');
  assert.equal(main([dir]), 1);
  assert.equal(existsSync(join(dir, MANIFEST_NAME)), false);
  assert.equal(main([join(dir, 'missing')]), 1);
});

test('the command line prints its usage without an argument', () => {
  const r = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8' });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /usage: write-manifest\.mjs <dist-dir>/);
  const dir = tree();
  const ok = spawnSync(process.execPath, [SCRIPT, dir], { encoding: 'utf8' });
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(existsSync(join(dir, MANIFEST_NAME)), true);
});
