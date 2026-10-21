// @vitest-environment node
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const script = fileURLToPath(new URL('../../../scripts/gen-profile-text-tables.mjs', import.meta.url));
const NAMES = ['DerivedCombiningClass', 'DerivedCoreProperties', 'DerivedGeneralCategory', 'DerivedJoiningType', 'PropList', 'Scripts', 'emoji-data',
  'emoji-sequences', 'emoji-zwj-sequences'].map((n) => `${n}.txt`);

describe('the generated profile-text tables', () => {
  it('stop the generator when an input is not the pinned file (sha256 pinned in the script)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dilla-ucd-bad-'));
    for (const name of NAMES) writeFileSync(join(dir, name), 'not the Unicode file\n');
    const run = spawnSync(process.execPath, [script, '--check', dir], { encoding: 'utf8' });
    expect(run.status).not.toBe(0);
    expect(run.stderr).toMatch(/is not the pinned/);
  });

  it('are what the pinned Unicode inputs generate (the checked-in files are current)', (ctx) => {
    // The inputs are downloaded once from their versioned unicode.org URLs and verified against the pinned checksums;
    // set DILLA_UCD_DIR to reuse a directory (CI downloads into one). Offline, the check is skipped here and runs in CI.
    const dir = process.env.DILLA_UCD_DIR ?? join(tmpdir(), 'dilla-ucd-17.0.0');
    mkdirSync(dir, { recursive: true });
    const run = spawnSync(process.execPath, [script, '--download', '--check', dir], { encoding: 'utf8', timeout: 120_000 });
    if (/fetch failed|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ETIMEDOUT/.test(run.stderr)) { ctx.skip(); return; }
    expect(run.stderr).toBe('');
    expect(run.status).toBe(0);
    expect(run.stdout).toMatch(/tables are current \(Unicode 17\.0\.0\)/);
  }, 130_000);
});
