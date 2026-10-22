import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  atLeastBaseline, buildReleaseJson, compareTags, compatGate, compatPlan, notesRow, pickRun, previousLevel, previousTag, sfuRestart, tagKey,
} from './release-meta.mjs';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const META = join(HERE, 'release-meta.mjs');
const FETCH = join(HERE, 'fetch-previous-release.sh');
const tmp = () => mkdtempSync(join(tmpdir(), 'release-meta-'));
const version = (o = {}) => ({ version: '0.1.0-web3.12', revision: 'abc', wire: [2], schema: 24, media_level: 2, min_sfu_media_level: 1, media_capabilities: ['turn'], ...o });
const cli = (...args) => spawnSync('node', [META, ...args], { encoding: 'utf8' });

test('tags order on the web3 line: web3.9 < web3.10 < web3.11 < web3.12 < web3.12.1 < v0.1.0; noise tags have no place', () => {
  const order = ['v0.1.0-web3.9', 'v0.1.0-web3.10', 'v0.1.0-web3.10.1', 'v0.1.0-web3.11', 'v0.1.0-web3.12', 'v0.1.0-web3.12.3', 'v0.1.0'];
  for (let i = 1; i < order.length; i++) assert.ok(compareTags(order[i - 1], order[i]) < 0, `${order[i - 1]} < ${order[i]}`);
  assert.equal(tagKey('v0.1.0-noise-beta.5'), null);
  assert.throws(() => compareTags('v0.1.0-noise-beta.5', 'v0.1.0-web3.11'));
});

test('web3.11 and later count as the baseline; older releases and other lines do not', () => {
  for (const t of ['v0.1.0-web3.11', 'v0.1.0-web3.12.3', 'v0.1.0-web3.13', 'v0.1.0', 'v0.2.0-web3.1']) assert.equal(atLeastBaseline(t), true, t);
  for (const t of ['v0.1.0-web3.10.1', 'v0.1.0-web3.9', 'v0.1.0-noise-beta.5', '', 'latest']) assert.equal(atLeastBaseline(t), false, t);
});

test('a previous release.json says its level; none means web3.11 = level 1; older with none is unknown', () => {
  assert.equal(previousLevel({ tag: 'v0.1.0-web3.12', json: { media_level: 2 } }), 2);
  assert.equal(previousLevel({ tag: 'v0.1.0-web3.11', json: null }), 1);
  assert.equal(previousLevel({ tag: 'v0.1.0-web3.12.3', json: null }), 1);
  assert.equal(previousLevel({ tag: 'v0.1.0-web3.10.1', json: null }), null);
  assert.throws(() => previousLevel({ tag: 'v0.1.0-web3.12', json: {} }), /media_level/);
});

test('sfu_restart: web3.12 after web3.11 (no file, level 1, needs 1) is when-idle', () => {
  assert.equal(sfuRestart({ previous: { tag: 'v0.1.0-web3.11', json: null }, minSfuMediaLevel: 1 }), 'when-idle');
  assert.equal(sfuRestart({ previous: { tag: 'v0.1.0-web3.12.3', json: null }, minSfuMediaLevel: 1 }), 'when-idle');
});

test('sfu_restart: a release that needs a newer SFU than the previous runs is required', () => {
  assert.equal(sfuRestart({ previous: { tag: 'v0.1.0-web3.11', json: null }, minSfuMediaLevel: 2 }), 'required');
  assert.equal(sfuRestart({ previous: { tag: 'v0.1.0-web3.12', json: { media_level: 2 } }, minSfuMediaLevel: 2 }), 'when-idle');
  assert.equal(sfuRestart({ previous: { tag: 'v0.1.0-web3.12', json: { media_level: 2 } }, minSfuMediaLevel: 3 }), 'required');
});

test('sfu_restart: older than web3.11 with no file, and no previous release at all, are required', () => {
  assert.equal(sfuRestart({ previous: { tag: 'v0.1.0-web3.10.1', json: null }, minSfuMediaLevel: 0 }), 'required');
  assert.equal(sfuRestart({ previous: { tag: '', json: null }, minSfuMediaLevel: 0 }), 'required');
  assert.equal(sfuRestart({ previous: null, minSfuMediaLevel: 1 }), 'required');
  assert.throws(() => sfuRestart({ previous: { tag: 'v0.1.0-web3.11', json: null }, minSfuMediaLevel: 'x' }), /not a number/);
});

test('release.json has R-UP2 shape and key order', () => {
  const json = buildReleaseJson({ tag: 'v0.1.0-web3.12', versionJson: version(), previous: { tag: 'v0.1.0-web3.11', json: null } });
  assert.equal(JSON.stringify(json), '{"format":1,"tag":"v0.1.0-web3.12","version":"0.1.0-web3.12","wire":[2],"schema":24,"media_level":2,"min_sfu_media_level":1,"media_capabilities":["turn"],"sfu_restart":"when-idle"}');
});

test('release.json refuses a binary that is not the tag, and a version --json that lacks a field', () => {
  assert.throws(() => buildReleaseJson({ tag: 'v0.1.0-web3.13', versionJson: version(), previous: null }), /binary says it is 0\.1\.0-web3\.12/);
  assert.throws(() => buildReleaseJson({ tag: 'v0.1.0-web3.12', versionJson: version({ schema: undefined }), previous: null }), /no schema/);
  assert.throws(() => buildReleaseJson({ tag: 'latest', versionJson: version(), previous: null }), /not a release tag/);
});

test('sfu-compat runs only when the previous SFU is new enough, and says why it skips', () => {
  const web311 = { tag: 'v0.1.0-web3.11', json: null };
  assert.deepEqual(compatPlan({ versionJson: version(), previous: web311 }), { run: true, previousLevel: 1, reason: compatPlan({ versionJson: version(), previous: web311 }).reason });
  const incompatible = compatPlan({ versionJson: version({ min_sfu_media_level: 2 }), previous: web311 });
  assert.equal(incompatible.run, false);
  assert.match(incompatible.reason, /needs a media server of level 2 or later, and v0\.1\.0-web3\.11 runs level 1/);
  const unknown = compatPlan({ versionJson: version(), previous: { tag: 'v0.1.0-web3.10.1', json: null } });
  assert.equal(unknown.run, false);
  assert.equal(unknown.previousLevel, null);
  assert.equal(compatPlan({ versionJson: version(), previous: { tag: '', json: null } }).run, false);
});

test('the previous tag is the newest below the release on the web3 line', () => {
  const published = ['v0.1.0-noise-beta.5', 'v0.1.0-web3.10.1', 'v0.1.0-web3.11', 'v0.1.0-web3.12', 'v0.1.0-web3.12.3'];
  assert.equal(previousTag(published, ''), 'v0.1.0-web3.12.3');
  assert.equal(previousTag(published, undefined), 'v0.1.0-web3.12.3');
  assert.equal(previousTag(published, 'v0.1.0-web3.13'), 'v0.1.0-web3.12.3');
  assert.equal(previousTag(published, 'v0.1.0-web3.12.3'), 'v0.1.0-web3.12');
  assert.equal(previousTag(published, 'v0.1.0-web3.12'), 'v0.1.0-web3.11');
  assert.equal(previousTag(published, 'v0.1.0-web3.10.1'), '');
  assert.equal(previousTag([], 'v0.1.0-web3.12'), '');
});

test('the Versions row of the notes names its sfu_restart and its level', () => {
  const md = '## Versions\n\n| | web3.12 | Upgrade and rollback |\n|---|---|---|\n| Server schema | **23** | x |\n| **Media server (SFU)** | when-idle (level 2, keeps web3.11\'s level 1) | y |\n';
  assert.deepEqual(notesRow(md), { restart: 'when-idle', level: 2, value: "when-idle (level 2, keeps web3.11's level 1)" });
  assert.equal(notesRow('| Media server (SFU) | required (level 3) | x |').restart, 'required');
  assert.equal(notesRow('| Media server (SFU) | both when-idle and required | x |').restart, null);
  assert.equal(notesRow('| Media server (SFU) | restarts sometimes | x |').restart, null);
  assert.equal(notesRow('| Server schema | when-idle | x |'), null);
  assert.equal(notesRow('no table at all'), null);
});

test('the release gate wants a green sfu-compat job and takes nothing else for one', () => {
  assert.equal(compatGate([{ name: 'sfu-compat', conclusion: 'success' }, { name: 'go', conclusion: 'failure' }]).ok, true);
  assert.equal(compatGate([{ name: 'sfu-compat', conclusion: 'failure' }]).ok, false);
  assert.equal(compatGate([{ name: 'sfu-compat', conclusion: 'skipped' }]).ok, false);
  assert.equal(compatGate([{ name: 'sfu-compat', conclusion: null, status: 'in_progress' }]).ok, false);
  assert.match(compatGate([{ name: 'go', conclusion: 'success' }]).reason, /no sfu-compat job/);
  assert.equal(compatGate([]).ok, false);
});

test('the CI run is the newest completed push run', () => {
  assert.equal(pickRun([{ id: 1, status: 'completed', event: 'push', created_at: '2026-10-01' }, { id: 2, status: 'completed', event: 'push', created_at: '2026-10-02' }, { id: 3, status: 'in_progress', event: 'push', created_at: '2026-10-03' }, { id: 4, status: 'completed', event: 'pull_request', created_at: '2026-10-04' }]).id, 2);
  assert.equal(pickRun([]), null);
});

test('CLI write: release.json from a version file and a previous dir, refusing notes that disagree', () => {
  const dir = tmp();
  writeFileSync(join(dir, 'version.json'), JSON.stringify(version()));
  const prev = join(dir, 'previous');
  mkdirSync(prev);
  writeFileSync(join(prev, 'previous-tag'), 'v0.1.0-web3.12.3\n');
  const out = join(dir, 'release.json');
  const notes = join(dir, 'notes.md');
  writeFileSync(notes, '| Media server (SFU) | when-idle (level 2) | x |\n');
  let r = cli('write', '--tag', 'v0.1.0-web3.12', '--version-json', join(dir, 'version.json'), '--previous-dir', prev, '--notes', notes, '--out', out);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(readFileSync(out, 'utf8')).sfu_restart, 'when-idle');
  writeFileSync(notes, '| Media server (SFU) | required (level 2) | x |\n');
  r = cli('write', '--tag', 'v0.1.0-web3.12', '--version-json', join(dir, 'version.json'), '--previous-dir', prev, '--notes', notes, '--out', join(dir, 'x.json'));
  assert.equal(r.status, 1);
  assert.match(r.stderr, /says the media server is "required", but release\.json computes "when-idle"/);
  writeFileSync(notes, 'a release note with no row\n');
  r = cli('write', '--tag', 'v0.1.0-web3.12', '--version-json', join(dir, 'version.json'), '--previous-dir', prev, '--notes', notes, '--out', join(dir, 'x.json'));
  assert.equal(r.status, 1);
  assert.match(r.stderr, /no "Media server \(SFU\)" row/);
  // No notes file: nothing to compare with, release.json is still written.
  r = cli('write', '--tag', 'v0.1.0-web3.12', '--version-json', join(dir, 'version.json'), '--previous-dir', prev, '--notes', join(dir, 'missing.md'), '--out', join(dir, 'y.json'));
  assert.equal(r.status, 0, r.stderr);
});

test('CLI write reads the previous release.json when the previous release has one', () => {
  const dir = tmp();
  const prev = join(dir, 'previous');
  mkdirSync(prev);
  writeFileSync(join(prev, 'previous-tag'), 'v0.1.0-web3.12\n');
  writeFileSync(join(prev, 'release.json'), JSON.stringify({ media_level: 2 }));
  writeFileSync(join(dir, 'version.json'), JSON.stringify(version({ version: '0.1.0-web3.13', min_sfu_media_level: 2, media_level: 2 })));
  const r = cli('write', '--tag', 'v0.1.0-web3.13', '--version-json', join(dir, 'version.json'), '--previous-dir', prev, '--out', join(dir, 'release.json'));
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(readFileSync(join(dir, 'release.json'), 'utf8')).sfu_restart, 'when-idle');
});

test('CLI compat: a notice and run=false when the previous SFU is too old; GITHUB_OUTPUT gets the answer', () => {
  const dir = tmp();
  const prev = join(dir, 'previous');
  mkdirSync(prev);
  writeFileSync(join(prev, 'previous-tag'), 'v0.1.0-web3.11\n');
  writeFileSync(join(dir, 'version.json'), JSON.stringify(version({ min_sfu_media_level: 2 })));
  const outFile = join(dir, 'gh-output');
  const r = spawnSync('node', [META, 'compat', '--version-json', join(dir, 'version.json'), '--previous-dir', prev], { encoding: 'utf8', env: { ...process.env, GITHUB_OUTPUT: outFile } });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^::notice title=sfu-compat skipped::/m);
  assert.equal(readFileSync(outFile, 'utf8'), 'run=false\nprevious_level=1\n');
  writeFileSync(join(dir, 'version.json'), JSON.stringify(version()));
  const ok = cli('compat', '--version-json', join(dir, 'version.json'), '--previous-dir', prev);
  assert.match(ok.stdout, /^run=true$/m);
});

test('CLI notes-required: the newest notes with a row must say required', () => {
  const dir = tmp();
  writeFileSync(join(dir, 'v0.1.0-web3.13.md'), '| Media server (SFU) | when-idle (level 3) | x |\n');
  writeFileSync(join(dir, 'v0.1.0-web3.12.md'), '| Media server (SFU) | required (level 2) | x |\n');
  let r = cli('notes-required', dir);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /v0\.1\.0-web3\.13\.md says the media server is "when-idle"/);
  writeFileSync(join(dir, 'v0.1.0-web3.13.md'), '| Media server (SFU) | required (level 3) | x |\n');
  r = cli('notes-required', dir);
  assert.equal(r.status, 0, r.stderr);
  const empty = tmp();
  writeFileSync(join(empty, 'v0.1.0-web3.13.md'), 'nothing\n');
  assert.equal(cli('notes-required', empty).status, 1);
});

test('CLI lists-release-json: exactly one exact line names it', () => {
  const dir = tmp();
  const h = 'a'.repeat(64);
  writeFileSync(join(dir, 'with'), `${h}  dillad-linux-amd64\n${h}  release.json\n`);
  writeFileSync(join(dir, 'without'), `${h}  dillad-linux-amd64\n${h}  not-release.json\n`);
  writeFileSync(join(dir, 'twice'), `${h}  release.json\n${h}  release.json\n`);
  assert.equal(cli('lists-release-json', join(dir, 'with')).status, 0);
  assert.equal(cli('lists-release-json', join(dir, 'without')).status, 1);
  assert.equal(cli('lists-release-json', join(dir, 'twice')).status, 1);
});

// ---- fetch-previous-release.sh against a fake gh --------------------------------------------------------------------

const sha = (s) => createHash('sha256').update(s).digest('hex');

/** A fake `gh` on PATH: `release list` prints LIST, `release download TAG --pattern P --dir D` copies from ASSETS/TAG/P. */
function fakeGh(base, releases) {
  const bin = join(base, 'bin');
  mkdirSync(bin);
  const assets = join(base, 'assets');
  writeFileSync(join(base, 'list.json'), JSON.stringify(Object.keys(releases).map((tagName) => ({ tagName }))));
  for (const [tag, files] of Object.entries(releases)) {
    mkdirSync(join(assets, tag), { recursive: true });
    for (const [name, body] of Object.entries(files)) writeFileSync(join(assets, tag, name), body);
  }
  writeFileSync(join(bin, 'gh'), [
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    'if [ "$1 $2" = "release list" ]; then cat "$FAKE_BASE/list.json"; exit 0; fi',
    'if [ "$1 $2" = "release download" ]; then tag=$3; pattern=$5; dir=$7; cp "$FAKE_BASE/assets/$tag/$pattern" "$dir/$pattern"; exit 0; fi',
    'echo "fake gh: unexpected $*" >&2; exit 9',
  ].join('\n'));
  chmodSync(join(bin, 'gh'), 0o755);
  return { PATH: `${bin}:${process.env.PATH}`, FAKE_BASE: base };
}
const sums = (files) => Object.entries(files).filter(([n]) => n !== 'SHA256SUMS').map(([n, b]) => `${sha(b)}  ${n}\n`).join('');
const fetchPrev = (env, dir, ...args) => spawnSync('bash', [FETCH, dir, ...args], { encoding: 'utf8', env: { ...process.env, ...env } });

test('fetch-previous-release: web3.12.3 (no release.json) gives a verified binary and no release.json', () => {
  const base = tmp();
  const files = { 'dillad-linux-amd64': 'the binary', 'dillad-linux-arm64': 'arm', 'dilla_core_wasi.wasm': 'wasm', 'install.sh': 'sh' };
  files.SHA256SUMS = sums(files);
  const env = fakeGh(base, { 'v0.1.0-web3.11': { ...files }, 'v0.1.0-web3.12.3': files });
  const dir = join(base, 'out');
  const r = fetchPrev(env, dir, '--binary');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readFileSync(join(dir, 'previous-tag'), 'utf8'), 'v0.1.0-web3.12.3\n');
  assert.equal(readFileSync(join(dir, 'dillad-linux-amd64'), 'utf8'), 'the binary');
  assert.throws(() => readFileSync(join(dir, 'release.json')));
});

test('fetch-previous-release: --exclude-from picks the release below it and fetches release.json when listed', () => {
  const base = tmp();
  const web312 = { 'dillad-linux-amd64': 'bin12', 'release.json': '{"media_level":2}\n' };
  web312.SHA256SUMS = sums(web312);
  const env = fakeGh(base, { 'v0.1.0-web3.12': web312, 'v0.1.0-web3.13': { 'dillad-linux-amd64': 'x', SHA256SUMS: '' } });
  const dir = join(base, 'out');
  const r = fetchPrev(env, dir, '--exclude-from', 'v0.1.0-web3.13');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readFileSync(join(dir, 'previous-tag'), 'utf8'), 'v0.1.0-web3.12\n');
  assert.equal(readFileSync(join(dir, 'release.json'), 'utf8'), '{"media_level":2}\n');
  assert.throws(() => readFileSync(join(dir, 'dillad-linux-amd64')), 'no --binary, no binary');
});

test('fetch-previous-release: a binary that does not match SHA256SUMS fails, and so does a missing line', () => {
  const base = tmp();
  const files = { 'dillad-linux-amd64': 'tampered', SHA256SUMS: `${sha('original')}  dillad-linux-amd64\n` };
  const env = fakeGh(base, { 'v0.1.0-web3.12.3': files });
  let r = fetchPrev(env, join(base, 'out'), '--binary');
  assert.notEqual(r.status, 0);
  assert.match(r.stdout + r.stderr, /FAILED|did NOT match/i);

  const base2 = tmp();
  const env2 = fakeGh(base2, { 'v0.1.0-web3.12.3': { 'dillad-linux-amd64': 'b', SHA256SUMS: `${sha('b')}  install.sh\n` } });
  r = fetchPrev(env2, join(base2, 'out'), '--binary');
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /exactly one SHA-256 line for dillad-linux-amd64/);
});

test('fetch-previous-release: a release.json that does not match its sum fails', () => {
  const base = tmp();
  const env = fakeGh(base, { 'v0.1.0-web3.12': { 'release.json': '{"media_level":9}', SHA256SUMS: `${sha('{"media_level":2}')}  release.json\n` } });
  const r = fetchPrev(env, join(base, 'out'));
  assert.notEqual(r.status, 0);
});

test('fetch-previous-release: no earlier release is an empty previous-tag, not a failure', () => {
  const base = tmp();
  const env = fakeGh(base, { 'v0.1.0-web3.12': { SHA256SUMS: '' } });
  const dir = join(base, 'out');
  const r = fetchPrev(env, dir, '--exclude-from', 'v0.1.0-web3.12');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readFileSync(join(dir, 'previous-tag'), 'utf8'), '\n');
});
