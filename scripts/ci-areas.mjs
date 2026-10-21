import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Which parts of the tree a change touches, and so which jobs of .github/workflows/ci.yml it runs. The `changes` job
 * runs this file and writes one boolean output per area; every other job is gated on the outputs named for it in
 * JOB_GATES (scripts/check-ci-workflow.mjs holds ci.yml to that table). A skipped job counts as passed for a required
 * check, so branch protection keeps working.
 *
 * Areas: go, core, web, e2e. `code` is true when anything other than docs changed. Docs-only changes (every file
 * under docs/ or a *.md at any depth, README.md and protocol/*.md included) set no area, so only the `docs` job runs.
 *
 * Fail safe: a push, any event that is not a pull request, a diff that cannot be computed, an empty diff and a file
 * no rule names all turn every area on.
 */
export const AREAS = ['go', 'core', 'web', 'e2e'];

/**
 * The path table. A pattern with a slash matches the whole path (`**` crosses directories, `*` does not); a pattern
 * without one matches the file name at any depth. `docs` is checked first: a file that matches it never counts as code.
 * `ci` is a pseudo-area that forces every area.
 */
export const PATH_RULES = [
  { area: 'docs', patterns: ['docs/**', '*.md', 'LICENSE', 'LICENSE-APACHE', 'DCO'] },
  { area: 'ci', patterns: ['.github/**', 'scripts/**'] },
  { area: 'go', patterns: ['internal/**', 'cmd/**', 'go.mod', 'go.sum', 'sqlc*', 'deploy/**', 'Dockerfile', '.dockerignore', '.golangci.yml'] },
  { area: 'core', patterns: ['core/**', 'testkit/**', 'Cargo.*', 'rust-toolchain.toml', 'deny.toml', '.cargo/**', 'protocol/vectors/**'] },
  { area: 'web', patterns: ['packages/**', 'package*.json', '.nvmrc', 'eslint.config.js'] },
  { area: 'e2e', patterns: ['e2e/**'] },
];

/** What an area drags in with it: the WASI core is used by the Go tests, and the browser suites run the server and the client together. */
export const FORCES = {
  ci: ['go', 'core', 'web', 'e2e'],
  core: ['go', 'web', 'e2e'],
  go: ['e2e'],
  web: ['e2e'],
  e2e: [],
};

/**
 * The outputs each job of ci.yml is gated on (OR). A job missing here is `changes` or `docs`, which always run.
 * Because the areas imply each other (FORCES), `e2e` is in practice "any code" and `web` is "web or core".
 * - rust-native and rust-wasi run for any code: go-harness and the browser suites download the testkit binary and
 *   the WASI core they build. rust-native's lint and test steps are gated on core at step level.
 * - image needs the go jobs, so it cannot run without them; go-release builds the embedded client.
 */
export const JOB_GATES = {
  node: ['code'],
  ui: ['web'],
  'rust-native': ['code'],
  'rust-wasm-node': ['core'],
  'rust-wasi': ['code'],
  vectors: ['core'],
  'browser-spike': ['web'],
  'browser-media': ['e2e'],
  'web-build': ['e2e'],
  'chromium-web': ['e2e'],
  'firefox-web': ['e2e'],
  'webkit-web': ['e2e'],
  deny: ['core'],
  go: ['go'],
  'go-ds': ['go'],
  'go-api': ['go'],
  'go-harness': ['go'],
  'go-fts5-arm64': ['go'],
  'go-lint': ['go'],
  'go-vuln': ['go'],
  'go-sqlc': ['go'],
  'go-postgres': ['go'],
  'go-release': ['go', 'web'],
  image: ['go'],
};

/** The `if:` expression ci.yml must carry for a job. */
export function gateExpression(job) {
  return JOB_GATES[job].map((output) => `needs.changes.outputs.${output} == 'true'`).join(' || ');
}

/** Whether a job runs for a set of outputs (as areasFor returns them). */
export function jobRuns(job, outputs) {
  return JOB_GATES[job].some((output) => outputs[output]);
}

function matches(pattern, file) {
  const subject = pattern.includes('/') ? file : file.slice(file.lastIndexOf('/') + 1);
  const re = pattern
    .split('**')
    .map((part) => part.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*'))
    .join('.*');
  return new RegExp(`^${re}$`).test(subject);
}

/** `docs`, a list of areas (maybe `ci`), or `unknown` for a file no rule names. */
export function classifyFile(file) {
  const hit = PATH_RULES.filter((rule) => rule.patterns.some((pattern) => matches(pattern, file)));
  if (hit.some((rule) => rule.area === 'docs')) return { docs: true, areas: [] };
  if (hit.length === 0) return { unknown: true, areas: [] };
  return { areas: hit.map((rule) => rule.area) };
}

const everything = () => ({ go: true, core: true, web: true, e2e: true, code: true });

/**
 * The outputs for a list of changed files. `null` (the diff could not be computed), an empty list and an unnamed
 * file all fail safe to everything.
 */
export function areasFor(files) {
  if (files === null || files.length === 0) return everything();
  const on = new Set();
  for (const file of files) {
    const result = classifyFile(file);
    if (result.unknown) return everything();
    for (const area of result.areas) {
      on.add(area);
      for (const forced of FORCES[area]) on.add(forced);
    }
  }
  return { ...Object.fromEntries(AREAS.map((area) => [area, on.has(area)])), code: on.size > 0 };
}

const SAMPLE_FILES = ['docs/a.md', 'scripts/x.mjs', 'internal/x.go', 'core/x.rs', 'packages/x.ts', 'e2e/x.ts', 'no-rule-names-this'];

/** Every distinct set of outputs some diff can produce, found by classifying each subset of one sample file per rule. */
export function reachableOutputs() {
  const seen = new Map();
  for (let mask = 0; mask < 1 << SAMPLE_FILES.length; mask++) {
    const files = SAMPLE_FILES.filter((_, i) => mask & (1 << i));
    const outputs = areasFor(files);
    seen.set(JSON.stringify(outputs), outputs);
  }
  return [...seen.values()];
}

/**
 * The outputs for an event. Only a pull request is narrowed; a push (main) runs everything. `diff` returns the
 * newline-separated changed paths and may throw.
 */
export function computeAreas({ eventName, baseSha, diff }) {
  if (eventName !== 'pull_request' || !baseSha) return everything();
  try {
    return areasFor(diff(baseSha).split('\n').filter((line) => line !== ''));
  } catch {
    return everything();
  }
}

// --no-renames lists both paths of a rename, so moving code into docs/ is still a code change.
const gitDiff = (base, head) => execFileSync('git', ['diff', '--name-only', '--no-renames', '-z', base, head], { encoding: 'utf8', maxBuffer: 64 << 20 }).split('\0').join('\n');

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { EVENT_NAME, BASE_SHA, HEAD_SHA = 'HEAD', GITHUB_OUTPUT } = process.env;
  const outputs = computeAreas({ eventName: EVENT_NAME, baseSha: BASE_SHA, diff: (base) => gitDiff(base, HEAD_SHA) });
  const lines = Object.entries(outputs).map(([name, value]) => `${name}=${value}`);
  console.error(`changes: ${lines.join(' ')}`);
  if (GITHUB_OUTPUT) appendFileSync(GITHUB_OUTPUT, `${lines.join('\n')}\n`);
  else console.log(lines.join('\n'));
}
