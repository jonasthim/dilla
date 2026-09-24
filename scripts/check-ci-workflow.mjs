import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Every job the workflow must carry (interfaces §5). `go` is Plan B task 8's, so it is not *required*
 * here — but if it exists, `checkGoOrdering` below insists on its `needs: rust-wasi` edge.
 */
export const REQUIRED_JOBS = [
  'node',
  'ui',
  'rust-native',
  'rust-wasm-node',
  'rust-wasi',
  'vectors',
  'browser-spike',
  'deny',
];

/**
 * R22: no escape hatch anywhere in the workflow. Both `always()` spellings are equally valid GitHub
 * Actions syntax and equally able to make a step run (and so a job pass) regardless of an earlier
 * failure, so the gate matches `always()` anywhere on an `if:` line rather than only the bare
 * `if: always()` form — `if: ${{ always() }}` is the more common of the two in practice.
 */
const FORBIDDEN = [
  { re: /\|\|\s*true/, what: '|| true' },
  { re: /continue-on-error/, what: 'continue-on-error' },
  { re: /if:.*always\(\)/, what: 'if: always()' },
];

/** One load-bearing command per job, so a silently gutted job is caught. */
const REQUIRED_STEPS = {
  'rust-native': [
    'cargo fmt --all --check',
    'cargo clippy --workspace --all-targets --all-features --locked -- -D warnings',
    'cargo test --workspace --all-features --locked',
  ],
  'rust-wasm-node': ['cargo test -p dilla-core-wasm --target wasm32-unknown-unknown --locked'],
  // Each entry must be a string the job carries and no other step of that job already contains.
  // `'dilla-core-wasi'` would be useless here: the cargo build line above already contains it, so the
  // artifact's `name:` would go unchecked. The three `with:` lines are named in full instead, which is
  // what makes step 9's argument — that `if-no-files-found: error` is what stops Plan B being handed
  // an empty directory — an enforced rule rather than prose.
  'rust-wasi': [
    'cargo build -p dilla-core-wasi --target wasm32-wasip1 --release --locked',
    'actions/upload-artifact@v7',
    'name: dilla-core-wasi',
    'path: target/wasm32-wasip1/release/dilla_core_wasi.wasm',
    'if-no-files-found: error',
  ],
  // The repository's pattern is that every scripts/check-*.mjs gate runs its own unit tests in the
  // `node` job (test:docs-check, test:brief-check, test:copy-check). This gate enforces that for
  // itself, so it cannot silently rot.
  node: ['npm run test:ci-check'],
  vectors: [
    'npm run vectors',
    'git diff --exit-code -- protocol/vectors',
    'cargo run -p dilla-testkit --bin dilla-testkit --locked -- vectors',
  ],
  // Only the matrix run: it already includes the chromium project, so also running `test:e2e` would
  // execute the 10-hand-over test twice per CI run for no added signal.
  'browser-spike': [
    'wasm-pack build core/dilla-core-wasm --target web --release --mode no-install --out-dir spike/pkg',
    'npm run test:e2e:matrix -w @dilla/e2e',
  ],
  deny: ['cargo deny --all-features check advisories bans licenses sources'],
};

/** Splits the `jobs:` mapping into `{ name: body }` by two-space job keys. */
function splitJobs(text) {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => l === 'jobs:');
  const jobs = {};
  if (start < 0) return jobs;
  let current = null;
  for (const line of lines.slice(start + 1)) {
    const key = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line);
    if (key !== null) {
      current = key[1];
      jobs[current] = [];
      continue;
    }
    if (current !== null) jobs[current].push(line);
  }
  return Object.fromEntries(Object.entries(jobs).map(([k, v]) => [k, v.join('\n')]));
}

export function checkWorkflow(root) {
  const path = join(root, '.github', 'workflows', 'ci.yml');
  const text = readFileSync(path, 'utf8');
  const problems = [];

  text.split('\n').forEach((line, i) => {
    for (const { re, what } of FORBIDDEN) {
      if (re.test(line)) problems.push(`ci.yml:${i + 1}: forbidden "${what}" — CI is fail-closed (R22)`);
    }
  });

  if (!/^concurrency:$/m.test(text) || !/cancel-in-progress: true/.test(text)) {
    problems.push('ci.yml: missing the workflow-level concurrency block with cancel-in-progress: true');
  }
  // gap-29 §4 ii: a workflow-level RUSTFLAGS overrides every target.*.rustflags outright.
  if (/^\s{2}RUSTFLAGS:/m.test(text)) {
    problems.push('ci.yml: workflow-level RUSTFLAGS overrides .cargo/config.toml — use cargo clippy -- -D warnings');
  }
  if (!/^\s{2}CARGO_TERM_COLOR: always$/m.test(text)) {
    problems.push('ci.yml: missing env CARGO_TERM_COLOR: always');
  }

  const jobs = splitJobs(text);
  for (const name of REQUIRED_JOBS) {
    if (!(name in jobs)) {
      problems.push(`ci.yml: missing job "${name}"`);
      continue;
    }
    for (const step of REQUIRED_STEPS[name] ?? []) {
      if (!jobs[name].includes(step)) problems.push(`ci.yml: job "${name}" is missing: ${step}`);
    }
  }

  // Plan B task 8 owns the `go` job; this plan owns `rust-wasi`. `actions/download-artifact@v8`
  // fetches from the same workflow run, so GitHub schedules `go` after `rust-wasi` only if a `needs:`
  // says so, and whichever plan lands second has to add the edge. Nobody owned that rule, so it lives
  // here: the moment a `go` job exists, it must declare the dependency.
  if ('go' in jobs) {
    if (!/^\s*needs:.*rust-wasi/m.test(jobs.go)) {
      problems.push('ci.yml: job "go" downloads the rust-wasi artifact but has no "needs: rust-wasi"');
    }
    // gap-31 §4 item 2 / NV-14 (resolved): the current majors deliberately pair
    // `actions/upload-artifact@v7` (this file's `rust-wasi` job) with `actions/download-artifact@v8`.
    // Nobody else owns this half of the hand-off either — a `go` job written from facts/plan-B.md's
    // now-stale deviation B15 text (`download-artifact@v4`) would pair v7 with v4, the untested
    // combination B15 was created to avoid, and neither this checker nor Plan B's own Go test would
    // catch it unless this rule lives here.
    if (!jobs.go.includes('actions/download-artifact@v8')) {
      problems.push(
        'ci.yml: job "go" must use actions/download-artifact@v8 to pair with rust-wasi\'s actions/upload-artifact@v7 (gap-31 §4 item 2)',
      );
    }
  }

  return problems;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const problems = checkWorkflow(process.cwd());
  for (const p of problems) console.error(p);
  process.exit(problems.length === 0 ? 0 : 1);
}
