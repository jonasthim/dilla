import { appendFileSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Release metadata (calls-survive-upgrade, R-UP2, UP4). ONE place holds the rule that decides what an upgrade does to the
 * running media server (SFU), and release.yml, ci.yml's sfu-compat job and scripts/check-release-meta.mjs all call it:
 *
 *   - The previous release's release.json says its own media_level.
 *   - A previous release with NO release.json is a release from before the scheme. From v0.1.0-web3.11 on it counts as
 *     media level 1 (web3.11 is the baseline CI proves; web3.12 to .4 shipped no file and kept its contract).
 *   - A release older than web3.11 with no file counts as "required": nothing says what its SFU speaks.
 *   - So the new release's sfu_restart is "when-idle" when the previous level is at least its min_sfu_media_level, and
 *     "required" otherwise (and when there is no previous release at all).
 *
 * Nobody writes release.json by hand: `write` generates it from the built binary's `dillad version --json`.
 */
export const BASELINE_TAG = 'v0.1.0-web3.11';
export const BASELINE_LEVEL = 1;
export const RESTART_VALUES = ['when-idle', 'required'];

const TAG_RE = /^v?(\d+)\.(\d+)\.(\d+)(?:-(.+))?$/;

/**
 * The sort key of a release tag, or null for a tag that is not on the web3 line (noise-beta and others). A final release
 * (v0.1.0, no prerelease part) sorts above every prerelease of its number, and web3.N.M above web3.N.
 */
export function tagKey(tag) {
  const m = TAG_RE.exec(tag);
  if (m === null) return null;
  const base = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (m[4] === undefined) return [...base, 1, 0, 0];
  const w = /^web3\.(\d+)(?:\.(\d+))?$/.exec(m[4]);
  if (w === null) return null;
  return [...base, 0, Number(w[1]), Number(w[2] ?? 0)];
}

/** Negative, zero or positive like Array.sort; both tags must have a key. */
export function compareTags(a, b) {
  const ka = tagKey(a);
  const kb = tagKey(b);
  if (ka === null || kb === null) throw new Error(`cannot order ${ka === null ? a : b}: not a release tag on the web3 line`);
  for (let i = 0; i < ka.length; i++) if (ka[i] !== kb[i]) return ka[i] - kb[i];
  return 0;
}

/** True when the tag is v0.1.0-web3.11 or later (the first line of releases whose SFU has a known media level). */
export function atLeastBaseline(tag) {
  const k = tagKey(tag);
  return k !== null && compareTags(tag, BASELINE_TAG) >= 0;
}

/** A previous release's media level: its release.json says, else web3.11 or later is level 1, else null (unknown). */
export function previousLevel({ tag, json }) {
  if (json !== null && json !== undefined) {
    if (!Number.isInteger(json.media_level) || json.media_level < 0) throw new Error(`the previous release.json has no usable media_level (${JSON.stringify(json.media_level)})`);
    return json.media_level;
  }
  return atLeastBaseline(tag ?? '') ? BASELINE_LEVEL : null;
}

/** "when-idle" when the previous release's SFU can keep running under the new release, else "required". */
export function sfuRestart({ previous, minSfuMediaLevel }) {
  if (!Number.isInteger(minSfuMediaLevel) || minSfuMediaLevel < 0) throw new Error(`min_sfu_media_level is not a number: ${JSON.stringify(minSfuMediaLevel)}`);
  if (previous === null || previous === undefined || previous.tag === '' || previous.tag === undefined) return 'required';
  const level = previousLevel(previous);
  return level !== null && level >= minSfuMediaLevel ? 'when-idle' : 'required';
}

/** The release.json object (R-UP2's shape and key order) for a built binary's `version --json`. */
export function buildReleaseJson({ tag, versionJson, previous }) {
  const v = versionJson;
  if (typeof tag !== 'string' || tagKey(tag) === null) throw new Error(`${JSON.stringify(tag)} is not a release tag`);
  if (v.version !== tag.replace(/^v/, '')) throw new Error(`the binary says it is ${v.version}, but the tag is ${tag}`);
  for (const key of ['wire', 'schema', 'media_level', 'min_sfu_media_level', 'media_capabilities']) {
    if (v[key] === undefined) throw new Error(`dillad version --json has no ${key}`);
  }
  return {
    format: 1,
    tag,
    version: v.version,
    wire: v.wire,
    schema: v.schema,
    media_level: v.media_level,
    min_sfu_media_level: v.min_sfu_media_level,
    media_capabilities: v.media_capabilities,
    sfu_restart: sfuRestart({ previous, minSfuMediaLevel: v.min_sfu_media_level }),
  };
}

/**
 * Whether sfu-compat can run: the previous release's SFU must speak a level the new API works with. When it cannot, the
 * release is incompatible BY DESIGN and announced as such; the job then only checks the notes say "required".
 */
export function compatPlan({ versionJson, previous }) {
  const min = versionJson.min_sfu_media_level;
  const level = previous === null || previous === undefined || previous.tag === '' ? null : previousLevel(previous);
  if (level === null) {
    return { run: false, previousLevel: null, reason: `the previous release (${previous?.tag || 'none'}) has no release.json and is older than ${BASELINE_TAG}: its media server's level is unknown, so a restart is required` };
  }
  if (min > level) {
    return { run: false, previousLevel: level, reason: `this tree needs a media server of level ${min} or later, and ${previous.tag} runs level ${level}: an incompatible release, announced as "required"` };
  }
  return { run: true, previousLevel: level, reason: `${previous.tag} runs media level ${level}, and this tree needs ${min} or later` };
}

/** The "Media server (SFU)" row of a release notes Versions table: its sfu_restart word and the first "level N" it names. */
export function notesRow(text) {
  for (const line of text.split('\n')) {
    if (!line.startsWith('|')) continue;
    const cells = line.split('|').slice(1, -1).map((c) => c.replace(/[*`]/g, '').trim());
    if (!/^Media server \(SFU\)$/.test(cells[0] ?? '')) continue;
    const value = cells[1] ?? '';
    const words = RESTART_VALUES.filter((w) => new RegExp(`(?<![\\w-])${w}(?![\\w-])`).test(value));
    const level = /\blevel (\d+)/.exec(value);
    return { restart: words.length === 1 ? words[0] : null, level: level === null ? null : Number(level[1]), value };
  }
  return null;
}

/** The notes files of docs/deploy/releases on the web3 line, newest first: [{ tag, text, row }]. */
export function notesNewestFirst(dir) {
  const files = readdirSync(dir).filter((f) => /^v.*\.md$/.test(f)).map((f) => f.slice(0, -3)).filter((t) => tagKey(t) !== null);
  files.sort((a, b) => compareTags(b, a));
  return files.map((tag) => {
    const text = readFileSync(join(dir, `${tag}.md`), 'utf8');
    return { tag, text, row: notesRow(text) };
  });
}

/** The tree's own levels, read from internal/sfu/level.go (the guard test TestMediaLevelGuard keeps them honest). */
export function treeLevels(root) {
  const text = readFileSync(join(root, 'internal', 'sfu', 'level.go'), 'utf8');
  const get = (name) => {
    const m = new RegExp(`^const ${name} = (\\d+)$`, 'm').exec(text);
    if (m === null) throw new Error(`internal/sfu/level.go has no "const ${name} = N"`);
    return Number(m[1]);
  };
  return { mediaLevel: get('MediaLevel'), minSfuMediaLevel: get('MinSFUMediaLevel') };
}

/**
 * The tag a release counts as "previous" for `tag`: the highest published release below it on the web3 line (a rebuild of
 * an old tag compares with the one before it, not with the newest), or with no tag the highest published one.
 */
export function previousTag(published, tag) {
  const below = published.filter((t) => tagKey(t) !== null && (tag === undefined || tag === '' || (tagKey(tag) !== null && compareTags(t, tag) < 0)));
  below.sort(compareTags);
  return below.at(-1) ?? '';
}

/** The previous release as a directory written by scripts/fetch-previous-release.sh: previous-tag, and release.json if it had one. */
export function readPrevious(dir) {
  if (dir === undefined || dir === '') return { tag: '', json: null };
  const tagFile = join(dir, 'previous-tag');
  const tag = existsSync(tagFile) ? readFileSync(tagFile, 'utf8').trim() : '';
  const jsonFile = join(dir, 'release.json');
  return { tag, json: existsSync(jsonFile) ? JSON.parse(readFileSync(jsonFile, 'utf8')) : null };
}

/**
 * The release gate: ci.yml's sfu-compat job must have run green on the commit being released. A job that was skipped, or one
 * that is missing, is not a pass: a skipped job means the whole e2e area was off, which a push never does.
 */
export function compatGate(jobs) {
  const found = jobs.filter((j) => j.name === 'sfu-compat');
  if (found.length === 0) return { ok: false, reason: 'ci.yml ran no sfu-compat job on this commit' };
  const bad = found.filter((j) => j.conclusion !== 'success');
  if (bad.length > 0) return { ok: false, reason: `sfu-compat concluded ${bad.map((j) => j.conclusion ?? j.status).join(', ')} on this commit` };
  return { ok: true, reason: 'sfu-compat passed on this commit' };
}

/** The CI run to look at: the newest completed ci.yml push run of the commit. */
export function pickRun(runs) {
  const done = runs.filter((r) => r.status === 'completed' && r.event === 'push');
  done.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  return done[0] ?? null;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

/** The jobs of a CI run: GitHub's jobs answer ({ jobs }), or one job object per line (gh api --paginate --jq '.jobs[]'). */
export function readJobs(path) {
  const text = readFileSync(path, 'utf8').trim();
  if (text.startsWith('{') && !text.includes('\n')) {
    const one = JSON.parse(text);
    return Array.isArray(one.jobs) ? one.jobs : [one];
  }
  return text === '' ? [] : text.split('\n').map((l) => JSON.parse(l));
}

function setOutput(name, value) {
  process.stdout.write(`${name}=${value}\n`);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
}

function flags(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('--')) throw new Error(`${argv[i]} needs a value`);
      out[argv[i].slice(2)] = v;
      i++;
    } else out._.push(argv[i]);
  }
  return out;
}

const need = (f, name) => {
  if (f[name] === undefined) throw new Error(`missing --${name}`);
  return f[name];
};

/** The CLI. Returns the exit code; prints its answer on stdout and its refusal on stderr. */
export function main(argv) {
  const [cmd, ...rest] = argv;
  const f = flags(rest);
  switch (cmd) {
    case 'write': {
      // write --tag T --version-json F --previous-dir D [--notes FILE] --out F
      const tag = need(f, 'tag');
      const previous = readPrevious(f['previous-dir']);
      const meta = buildReleaseJson({ tag, versionJson: readJson(need(f, 'version-json')), previous });
      if (f.notes !== undefined && !existsSync(f.notes) && meta.sfu_restart === 'required') {
        throw new Error(`${f.notes} does not exist, and this release needs a media server restart ("required" against ${previous.tag || 'no previous release'}): its notes must announce it`);
      }
      if (f.notes !== undefined && existsSync(f.notes)) {
        const row = notesRow(readFileSync(f.notes, 'utf8'));
        if (row === null) throw new Error(`${f.notes} has no "Media server (SFU)" row in its Versions table; release.json says ${meta.sfu_restart}`);
        if (row.restart !== meta.sfu_restart) throw new Error(`${f.notes} says the media server is "${row.restart ?? row.value}", but release.json computes "${meta.sfu_restart}" against ${previous.tag || 'no previous release'}`);
      }
      writeFileSync(need(f, 'out'), `${JSON.stringify(meta)}\n`);
      process.stdout.write(`release.json: ${meta.tag}, media level ${meta.media_level}, needs ${meta.min_sfu_media_level}, sfu_restart ${meta.sfu_restart} (previous ${previous.tag || 'none'})\n`);
      return 0;
    }
    case 'compat': {
      // compat --version-json F --previous-dir D
      const plan = compatPlan({ versionJson: readJson(need(f, 'version-json')), previous: readPrevious(f['previous-dir']) });
      setOutput('run', String(plan.run));
      setOutput('previous_level', plan.previousLevel === null ? '' : String(plan.previousLevel));
      if (!plan.run) process.stdout.write(`::notice title=sfu-compat skipped::${plan.reason}\n`);
      else process.stdout.write(`sfu-compat runs: ${plan.reason}\n`);
      return 0;
    }
    case 'notes-required': {
      // notes-required DIR: the newest notes that have a Media server row must say "required".
      const notes = notesNewestFirst(f._[0] ?? 'docs/deploy/releases').find((n) => n.row !== null);
      if (notes === undefined) throw new Error('no release notes file has a "Media server (SFU)" row, so none announces the restart');
      if (notes.row.restart !== 'required') throw new Error(`${notes.tag}.md says the media server is "${notes.row.restart ?? notes.row.value}", but this release is incompatible with the previous media server: its notes must say "required"`);
      process.stdout.write(`${notes.tag}.md says "required"\n`);
      return 0;
    }
    case 'previous-tag': {
      // previous-tag --list FILE [--exclude-from TAG]: FILE is `gh release list --json tagName`.
      const published = readJson(need(f, 'list')).map((r) => r.tagName);
      process.stdout.write(`${previousTag(published, f['exclude-from'])}\n`);
      return 0;
    }
    case 'lists-release-json': {
      // lists-release-json SHA256SUMS: exit 0 when exactly one line names release.json.
      const lines = readFileSync(f._[0], 'utf8').split('\n').filter((l) => /^[0-9a-f]{64} [ *]release\.json$/.test(l));
      return lines.length === 1 ? 0 : 1;
    }
    case 'gate': {
      // gate --jobs FILE: FILE is the jobs of the CI run (GitHub's jobs API answer).
      const verdict = compatGate(readJobs(need(f, 'jobs')));
      process.stdout.write(`${verdict.reason}\n`);
      return verdict.ok ? 0 : 1;
    }
    case 'pick-run': {
      const run = pickRun(readJson(need(f, 'runs')).workflow_runs ?? []);
      if (run === null) throw new Error('no completed ci.yml push run was found for this commit');
      process.stdout.write(`${run.id}\n`);
      return 0;
    }
    default:
      throw new Error(`usage: release-meta.mjs write|compat|notes-required|previous-tag|lists-release-json|gate|pick-run ...`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (e) {
    process.stderr.write(`release-meta: ${e.message}\n`);
    process.exit(1);
  }
}
