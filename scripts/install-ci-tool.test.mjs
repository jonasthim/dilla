import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const script = join(dirname(fileURLToPath(import.meta.url)), 'install-ci-tool.sh');

test('an unapproved tool is refused before any download', () => {
  const result = spawnSync('bash', [script, 'unreviewed-installer'], { encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /unapproved CI tool/);
});

test('a changed publisher archive is refused before extraction', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dilla-tool-test-'));
  const archive = join(dir, 'wrong.tar.gz');
  writeFileSync(archive, 'wrong archive bytes');
  try {
    const result = spawnSync('bash', [script, 'binaryen', '--archive', archive], {
      encoding: 'utf8', env: { ...process.env, RUNNER_TEMP: dir },
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /SHA-256 mismatch/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
