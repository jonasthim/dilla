import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { areasFor, classifyFile, computeAreas, gateExpression, JOB_GATES, jobRuns, reachableOutputs } from './ci-areas.mjs';

const SCRIPT = fileURLToPath(new URL('./ci-areas.mjs', import.meta.url));
const REPO_ROOT = join(dirname(SCRIPT), '..');

const NONE = { go: false, core: false, web: false, e2e: false, code: false };
const ALL = { go: true, core: true, web: true, e2e: true, code: true };
const BROWSERS = ['chromium-web', 'firefox-web', 'webkit-web'];
const ranJobs = (outputs) => Object.keys(JOB_GATES).filter((job) => jobRuns(job, outputs));

test('docs-only changes set no area', () => {
  for (const files of [
    ['README.md'],
    ['protocol/01-groups.md', 'protocol/09-http-api.md'],
    ['docs/deploy/README.md', 'docs/screenshots/channel.png'],
    ['internal/api/README.md'],
    ['CONTRIBUTING.md', 'docs/a.md', 'LICENSE'],
  ]) {
    assert.deepEqual(areasFor(files), NONE, files.join(' '));
    assert.deepEqual(ranJobs(areasFor(files)), [], files.join(' '));
  }
});

test('a UI-only change runs the web jobs and the browsers, no Go jobs', () => {
  const outputs = areasFor(['packages/ui/src/Button.tsx', 'packages/web/package.json']);
  assert.deepEqual(outputs, { go: false, core: false, web: true, e2e: true, code: true });
  const ran = ranJobs(outputs);
  for (const job of ['node', 'ui', 'browser-spike', 'browser-media', 'web-build', 'rust-native', 'rust-wasi', 'go-release', ...BROWSERS]) assert.ok(ran.includes(job), job);
  for (const job of ['rust-wasm-node', 'vectors', 'deny', 'image', 'go', 'go-ds', 'go-api', 'go-harness', 'go-fts5-arm64', 'go-lint', 'go-vuln', 'go-sqlc', 'go-postgres']) assert.ok(!ran.includes(job), job);
});

test('a Go-only change runs the Go jobs and the browsers, no rust or ui unit jobs', () => {
  const outputs = areasFor(['internal/api/messages.go', 'go.sum']);
  assert.deepEqual(outputs, { go: true, core: false, web: false, e2e: true, code: true });
  const ran = ranJobs(outputs);
  for (const job of ['go', 'go-ds', 'go-api', 'go-harness', 'go-lint', 'go-postgres', 'go-release', 'image', 'web-build', ...BROWSERS]) assert.ok(ran.includes(job), job);
  for (const job of ['ui', 'rust-wasm-node', 'vectors', 'deny', 'browser-spike']) assert.ok(!ran.includes(job), job);
});

test('a core change runs everything', () => {
  for (const file of ['core/dilla-core/src/lib.rs', 'Cargo.lock', 'testkit/src/main.rs', 'protocol/vectors/groups.json', 'deny.toml']) {
    assert.deepEqual(areasFor([file]), ALL, file);
    assert.deepEqual(ranJobs(areasFor([file])), Object.keys(JOB_GATES), file);
  }
});

test('a workflow or script change runs everything', () => {
  for (const file of ['.github/workflows/ci.yml', 'scripts/ci-areas.mjs', 'scripts/install-ci-tool.sh']) {
    assert.deepEqual(areasFor([file]), ALL, file);
    assert.deepEqual(ranJobs(areasFor([file])), Object.keys(JOB_GATES), file);
  }
});

test('an e2e-only change runs the browsers and what they download, not the unit jobs', () => {
  const outputs = areasFor(['e2e/tests/voice.spec.ts']);
  assert.deepEqual(outputs, { go: false, core: false, web: false, e2e: true, code: true });
  assert.ok(BROWSERS.every((job) => jobRuns(job, outputs)));
  assert.ok(!jobRuns('ui', outputs) && !jobRuns('go', outputs));
});

test('a mixed change is the union of its files, and docs files add nothing', () => {
  assert.deepEqual(areasFor(['docs/a.md', 'packages/web/src/a.ts']), { go: false, core: false, web: true, e2e: true, code: true });
  assert.deepEqual(areasFor(['README.md', 'cmd/dillad/main.go', 'packages/web/src/a.ts']), { go: true, core: false, web: true, e2e: true, code: true });
  assert.deepEqual(areasFor(['deploy/install.sh']), { go: true, core: false, web: false, e2e: true, code: true });
});

test('a file no rule names is code in every area', () => {
  assert.deepEqual(classifyFile('experiments/x.rs'), { unknown: true, areas: [] });
  assert.deepEqual(areasFor(['docs/a.md', 'experiments/x.rs']), ALL);
  assert.deepEqual(areasFor(['some/new/dir/file.txt']), ALL);
});

test('an unknown or empty diff fails safe to everything', () => {
  assert.deepEqual(areasFor(null), ALL);
  assert.deepEqual(areasFor([]), ALL);
});

test('only a pull request is narrowed, and a failing diff fails safe', () => {
  const docsOnly = () => 'README.md\ndocs/a.md\n';
  assert.deepEqual(computeAreas({ eventName: 'pull_request', baseSha: 'abc', diff: docsOnly }), NONE);
  assert.deepEqual(computeAreas({ eventName: 'push', baseSha: 'abc', diff: docsOnly }), ALL);
  assert.deepEqual(computeAreas({ eventName: 'workflow_dispatch', baseSha: '', diff: docsOnly }), ALL);
  assert.deepEqual(computeAreas({ eventName: 'pull_request', baseSha: '', diff: docsOnly }), ALL);
  assert.deepEqual(computeAreas({ eventName: 'pull_request', baseSha: 'abc', diff: () => { throw new Error('bad object'); } }), ALL);
  assert.deepEqual(computeAreas({ eventName: 'pull_request', baseSha: 'abc', diff: () => '' }), ALL);
});

test('every browser job runs together, whenever any does', () => {
  for (const outputs of reachableOutputs()) {
    assert.equal(new Set(BROWSERS.map((job) => jobRuns(job, outputs))).size, 1, JSON.stringify(outputs));
  }
});

test('every job gate is an or of known outputs', () => {
  for (const job of Object.keys(JOB_GATES)) {
    assert.match(gateExpression(job), /^needs\.changes\.outputs\.(go|core|web|e2e|code) == 'true'( \|\| needs\.changes\.outputs\.(go|core|web|e2e|code) == 'true')*$/, job);
  }
});

test('JOB_GATES names exactly the jobs of ci.yml but changes and docs', () => {
  const ci = readFileSync(join(REPO_ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');
  const jobs = [...ci.slice(ci.indexOf('\njobs:')).matchAll(/^ {2}([A-Za-z0-9_-]+):\s*$/gm)].map((m) => m[1]).filter((job) => job !== 'changes' && job !== 'docs');
  assert.deepEqual(jobs.sort(), Object.keys(JOB_GATES).sort());
});

// The CLI against a real repository: the path ci.yml takes.
function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'dilla-areas-'));
  const git = (...args) => execFileSync('git', ['-c', 'user.email=a@b.c', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args], { cwd: dir, encoding: 'utf8' });
  git('init', '-q');
  mkdirSync(join(dir, 'internal'));
  writeFileSync(join(dir, 'internal', 'a.go'), 'package a\n');
  writeFileSync(join(dir, 'README.md'), 'x\n');
  git('add', '.');
  git('commit', '-q', '-m', 'base');
  return { dir, git, base: git('rev-parse', 'HEAD').trim() };
}

function runCli(dir, env) {
  const out = join(dir, 'github-output');
  writeFileSync(out, '');
  const result = spawnSync('node', [SCRIPT], { cwd: dir, env: { ...process.env, GITHUB_OUTPUT: out, ...env }, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return Object.fromEntries(readFileSync(out, 'utf8').trim().split('\n').map((line) => line.split('=')).map(([k, v]) => [k, v === 'true']));
}

test('the CLI reads the diff against the base: docs-only, then code', () => {
  const { dir, git, base } = repo();
  writeFileSync(join(dir, 'README.md'), 'changed\n');
  mkdirSync(join(dir, 'docs'));
  writeFileSync(join(dir, 'docs', 'a.md'), 'new\n');
  git('add', '.');
  git('commit', '-q', '-m', 'docs');
  assert.deepEqual(runCli(dir, { EVENT_NAME: 'pull_request', BASE_SHA: base }), NONE);
  writeFileSync(join(dir, 'internal', 'a.go'), 'package b\n');
  git('commit', '-q', '-a', '-m', 'code');
  assert.deepEqual(runCli(dir, { EVENT_NAME: 'pull_request', BASE_SHA: base }), { go: true, core: false, web: false, e2e: true, code: true });
});

test('the CLI treats moving code into docs/ as a code change', () => {
  const { dir, git, base } = repo();
  mkdirSync(join(dir, 'docs'));
  git('mv', 'internal/a.go', 'docs/a.go');
  git('commit', '-q', '-m', 'move');
  assert.deepEqual(runCli(dir, { EVENT_NAME: 'pull_request', BASE_SHA: base }), { go: true, core: false, web: false, e2e: true, code: true });
});

test('the CLI fails safe: a base commit that is not in the clone, a push, no base', () => {
  const { dir } = repo();
  assert.deepEqual(runCli(dir, { EVENT_NAME: 'pull_request', BASE_SHA: '0'.repeat(40) }), ALL);
  assert.deepEqual(runCli(dir, { EVENT_NAME: 'pull_request', BASE_SHA: '' }), ALL);
  assert.deepEqual(runCli(dir, { EVENT_NAME: 'push', BASE_SHA: '' }), ALL);
});
