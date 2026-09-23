import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkBrief, REQUIRED_HEADINGS, EXCLUSIONS } from './check-design-brief.mjs';

function fixture(body) {
  const dir = mkdtempSync(join(tmpdir(), 'dilla-brief-'));
  mkdirSync(join(dir, 'docs', 'design'), { recursive: true });
  writeFileSync(join(dir, 'docs', 'design', 'brief.md'), body);
  return dir;
}

test('a complete brief passes', () => {
  const body = ['# dilla design brief', ...REQUIRED_HEADINGS, '', ...EXCLUSIONS.map(e => `- ${e}`)].join('\n\n');
  assert.deepEqual(checkBrief(fixture(body)), []);
});

test('missing headings and exclusions are reported', () => {
  const problems = checkBrief(fixture('# dilla design brief\n\n## Purpose\n'));
  assert.ok(problems.some(p => p.includes('## Vocabulary')));
  assert.ok(problems.some(p => p.includes(EXCLUSIONS[0])));
});
