import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Every job the workflow must carry (interfaces §5). Ruling L added the two Go jobs: they landed with
 * Plan B task 8, and leaving them merely "checked if present" meant deleting them was the one way to
 * make the Go half of the tree ungated without this gate saying a word. The `go` job additionally has
 * to declare its `needs: rust-wasi` edge (see below).
 */
export const REQUIRED_JOBS = [
  'node',
  'ui',
  'rust-native',
  'rust-wasm-node',
  'rust-wasi',
  'vectors',
  'browser-spike',
  'browser-media',
  'deny',
  'go',
  // internal/ds under -race in a job of its own (fix wave, CI run 36697379567): it is the slowest
  // package by far, and in the go job it pushed a 4-vCPU runner past the job's 25 minutes.
  'go-ds',
  // The scenario harness in its own job with its own timeout (final review): it needs both the
  // wasi core and the testkit binary, and in the go job it pushed a 4-vCPU runner past its budget.
  'go-harness',
  // go-fts5-arm64 is created by plan-1a task 2 (interfaces §9.2): it cross-builds the SQLite FTS5
  // path for arm64. If it is ever missing, the fix is to add it there, not to drop it from this list.
  'go-fts5-arm64',
  'go-lint',
  'go-vuln',
  'go-sqlc',
  'go-postgres',
  'go-release',
  // Plan 2 task 18: the multi-arch container image, built on every run and pushed from main.
  'image',
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
  // The testkit artifact hand-off: rust-native builds and uploads it, go downloads it.
  'rust-native': [
    'cargo fmt --all --check',
    'cargo clippy --workspace --all-targets --all-features --locked -- -D warnings',
    'cargo test --workspace --all-features --locked',
    'cargo build -p dilla-testkit --release --locked',
    'name: dilla-testkit',
    'if-no-files-found: error',
  ],
  'rust-wasm-node': [
    'cargo test -p dilla-core-wasm --target wasm32-unknown-unknown --locked',
    // Task 17 (dilla-media): the media worker's wasm-backed tests, the BaseE2EEManager type contract and the
    // JS half of the signalling-schema contract (DEV-66) run where the web wasm is built.
    'wasm-pack build core/dilla-core-wasm --target web --release --mode no-install --out-dir ../../packages/media/wasm',
    'npm run typecheck -w @dilla/media',
    'npm run test:wasm -w @dilla/media',
    'npm run check:schema -w @dilla/media',
  ],
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
    'timeout-minutes: 20',
  ],
  'browser-media': [
    'actions/upload-artifact@v7',
    'if: failure()',
    'name: browser-media-results',
    'path: e2e/test-results',
    'if-no-files-found: error',
    'timeout-minutes: 25',
    'name: dilla-core-wasi',
    'path: internal/mlswasi/testdata',
    'name: dilla-testkit',
    'wasm-pack build core/dilla-core-wasm --target web --release --mode no-install --out-dir ../../packages/media/wasm',
    'go build -o target/dilla-mediabot ./cmd/dilla-mediabot',
    'node packages/media/scripts/extract-rnnoise-wasm.mjs',
    'npx playwright install --with-deps chromium firefox',
    'npm run test:e2e:media -w @dilla/e2e',
    'unsupported-sfu-codec.spec.ts',
    "DILLA_MEDIA_SFU_AV1: '1'",
    'DILLA_TESTKIT: ${{ github.workspace }}/artifacts/dilla-testkit',
  ],
  deny: ['cargo deny --all-features check advisories bans licenses sources'],
  // Ruling M. The first two lines are the hand-off from `rust-wasi`: without the download, or with it
  // landing anywhere but `internal/mlswasi/testdata`, the wazero tests skip themselves and the job is
  // green having proved nothing. The third is the only compile of the pinned LiveKit/wazero/sqlite
  // graph — `internal/deps` sits behind the `dillapins` tag precisely so no ordinary build pulls the
  // SFU in, which also means no other step in this workflow would notice that graph breaking. The
  // fourth is the race-detector run itself; it needs cgo, so it must never be reduced to a plain
  // `go test`.
  go: [
    'actions/download-artifact@v8',
    'path: internal/mlswasi/testdata',
    'CGO_ENABLED=0 go build -tags dillapins ./internal/deps',
    'go test -race -shuffle=on -timeout 15m $(go list ./... | grep -vx github.com/jonasthim/dilla/internal/ds)',
    'name: dilla-core-wasi',
    "go test -timeout 5m ./cmd/dilla-mediabot ./internal/media ./internal/sfu -run 'TestTwoBotsDecryptEachOtherThroughTheSFU|TestGoPublisherToGoSubscriberDecryptsThroughTheSFU|TestTheSFUOfferCarriesOnlyTheDillaCodecs|TestPromotionAddsTheVideoSourcesAndDemotionRemovesThem'",
  ],
  // The one package the go job leaves out, with the wasi core it needs and a budget of its own.
  'go-ds': [
    'timeout-minutes: 25',
    'actions/download-artifact@v8',
    'name: dilla-core-wasi',
    'path: internal/mlswasi/testdata',
    'go test -race -shuffle=on -timeout 20m ./internal/ds/...',
  ],
  // The harness job: both hand-offs, the binary, and a run that FAILS without it.
  'go-harness': [
    'timeout-minutes: 30',
    'actions/download-artifact@v8',
    'path: internal/mlswasi/testdata',
    'name: dilla-core-wasi',
    'name: dilla-testkit',
    'artifacts/dilla-testkit',
    'go test -race -shuffle=on -timeout 25m ./internal/testkit/...',
    'DILLA_TESTKIT',
    // `DILLA_TESTKIT` above is a prefix of this one, so both are named: without the second, a
    // missing binary would skip every scenario test and the job would stay green.
    'DILLA_TESTKIT_REQUIRED',
  ],
  // modernc.org/sqlite carries one generated translation unit per GOOS/GOARCH, so the FTS5
  // assertion is only actually *executed* on arm64 by a native arm64 runner (deviation B9): moved to
  // ubuntu-latest this job would silently re-run what the `go` job already ran.
  'go-fts5-arm64': ['runs-on: ubuntu-24.04-arm', 'go test ./internal/store/sqlite/...'],
  // The five W2-W5 gates. Each entry is a string the job carries and no other step of that job
  // already contains, so a silently gutted job is caught.
  'go-lint': ['golangci/golangci-lint-action@v9', 'version: v2.13.2'],
  'go-vuln': [
    'golang.org/x/vuln/cmd/govulncheck@v1.8.0 ./...',
    '-scan package -tags dillapins ./internal/deps',
  ],
  'go-sqlc': ['sqlc-dev/setup-sqlc@v5', "sqlc-version: '1.31.1'", 'sqlc diff', 'git diff --exit-code'],
  'go-postgres': [
    'postgres:18.6-alpine3.24',
    '--locale-provider=builtin --builtin-locale=C.UTF-8',
    'DILLA_TEST_PG',
    // I7 (fix wave): the packages with a Postgres leg, internal/ops's backup, restore and heal tests
    // among them, with an explicit -timeout that fits the job's budget.
    'go test -race -shuffle=on -timeout 20m ./internal/store/... ./internal/ops/...',
  ],
  'go-release': ['CGO_ENABLED=0', 'if-no-files-found: error'],
  // Task 18. The pins are the versions P2-11 resolved against the registries and the marketplace
  // release lists; `actions/checkout@v7` and `runs-on: ubuntu-latest` are the house style of every
  // other job. The download of rust-wasi's artifact is load-bearing: dillad loads the wasi core from
  // beside its binary and the Dockerfile copies it out of the build context, so without the download
  // the build fails (fail-closed) rather than shipping an image that cannot start.
  image: [
    'runs-on: ubuntu-latest',
    'actions/checkout@v7',
    'actions/download-artifact@v8',
    'name: dilla-core-wasi',
    'path: internal/mlswasi/testdata',
    'docker/setup-buildx-action@v4.4.1',
    'docker/login-action@v4.6.0',
    'docker/metadata-action@v6.2.0',
    'docker/build-push-action@v7.4.0',
    'platforms: linux/amd64,linux/arm64',
    'provenance: mode=max',
    'sbom: true',
    'timeout-minutes: 30',
    // I16 (fix wave): Compose and the deploy README pull `:latest`, and metadata-action generates it
    // only for tag events unless it is asked for on the default branch.
    'type=raw,value=latest,enable={{is_default_branch}}',
  ],
};

/**
 * The `go` job's test step is a module-wide wildcard on purpose: every new internal/… package is
 * picked up with zero workflow edits. Narrowing it to a package list is how a whole subsystem
 * silently stops being tested, so the exact text is pinned. It leaves out exactly one package,
 * internal/ds, by its full import path, and only because the go-ds job (whose step is pinned in
 * REQUIRED_STEPS) runs it: the union of the two is still the whole module.
 */
function assertTestStepIsNotNarrowed(workflow, fail) {
  const line = 'go test -race -shuffle=on -timeout 15m $(go list ./... | grep -vx github.com/jonasthim/dilla/internal/ds)';
  if (!workflow.includes(line)) {
    fail(`the go job's test step must be exactly "${line}"`);
  }
}

/**
 * Every `actions/upload-artifact` step sets `if-no-files-found: error` (Global Constraints: CI is
 * fail-closed). The per-job REQUIRED_STEPS pin it for the jobs that exist today; this rule is the
 * one that covers a job added tomorrow. A step is its `- ` list item and every line indented deeper.
 */
function assertEveryUploadFailsOnNoFiles(text, problems) {
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (!/uses:\s*actions\/upload-artifact@/.test(lines[i])) continue;
    // The step's own indent: the column of its `- ` marker, which may be on this line or above it.
    let start = i;
    while (start > 0 && !/^\s*- /.test(lines[start])) start--;
    const indent = /^(\s*)- /.exec(lines[start])?.[1].length ?? 0;
    let end = i + 1;
    while (end < lines.length && lines[end].trim() !== '' && !new RegExp(`^\\s{0,${indent}}\\S`).test(lines[end])) end++;
    const step = lines.slice(start, end).join('\n');
    if (!/if-no-files-found:\s*error/.test(step)) {
      problems.push(`ci.yml:${i + 1}: actions/upload-artifact without "if-no-files-found: error" — CI is fail-closed`);
    }
  }
}

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

  assertTestStepIsNotNarrowed(text, (msg) => problems.push(`ci.yml: ${msg}`));
  assertEveryUploadFailsOnNoFiles(text, problems);

  // Task 18. The Dockerfile cross-compiles with GOOS/GOARCH from a $BUILDPLATFORM builder, so
  // nothing runs under emulation and setup-qemu-action would only add a slow, useless step.
  if (text.includes('setup-qemu-action')) {
    problems.push('ci.yml: setup-qemu-action is not needed: the image cross-compiles from $BUILDPLATFORM');
  }
  if ('image' in jobs) {
    // A push of an image nobody tested would be a release of untested code: the two Go gates come first.
    // rust-wasi is named too, because the job downloads its artifact.
    for (const need of ['go', 'go-ds', 'go-lint', 'rust-wasi']) {
      if (!new RegExp(`^\\s*needs:.*(?<![\\w-])${need}(?![\\w-])`, 'm').test(jobs.image)) {
        problems.push(`ci.yml: job "image" must list "${need}" in its needs:`);
      }
    }
  }

  // Plan B task 8 owns the `go` job; this plan owns `rust-wasi`. `actions/download-artifact@v8`
  // fetches from the same workflow run, so GitHub schedules `go` after `rust-wasi` only if a `needs:`
  // says so, and whichever plan lands second has to add the edge. Nobody owned that rule, so it lives
  // here. The job is required above; the guard keeps this block from piling a second, confusing
  // complaint on top of the plain "missing job" one.
  if ('go' in jobs) {
    if (!/^\s*needs:.*rust-wasi/m.test(jobs.go)) {
      problems.push('ci.yml: job "go" downloads the rust-wasi artifact but has no "needs: rust-wasi"');
    }
    // The go job has no testkit binary, so requiring one there fails every run.
    if (jobs.go.includes('DILLA_TESTKIT_REQUIRED')) {
      problems.push('ci.yml: job "go" requires the testkit but does not download it; the harness is go-harness\'s');
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

  if ('go-ds' in jobs && !/^\s*needs:.*rust-wasi/m.test(jobs['go-ds'])) {
    problems.push('ci.yml: job "go-ds" downloads the rust-wasi artifact but has no "needs: rust-wasi"');
  }

  if ('go-harness' in jobs) {
    const harness = jobs['go-harness'];
    if (!/^\s*needs:.*rust-wasi/m.test(harness)) {
      problems.push('ci.yml: job "go-harness" downloads the rust-wasi artifact but has no "needs: rust-wasi"');
    }
    // The testkit binary is built by `rust-native` and downloaded by `go-harness`; without the
    // edge the download finds nothing in the run and the job is red on every push.
    if (!/^\s*needs:.*rust-native/m.test(harness)) {
      problems.push('ci.yml: job "go-harness" downloads the rust-native testkit artifact but has no "needs: rust-native"');
    }
  }

  if ('browser-media' in jobs) {
    const extractAt = jobs['browser-media'].indexOf('node packages/media/scripts/extract-rnnoise-wasm.mjs');
    const suiteAt = jobs['browser-media'].indexOf('npm run test:e2e:media -w @dilla/e2e');
    if (extractAt !== -1 && suiteAt !== -1 && extractAt > suiteAt) {
      problems.push('ci.yml: browser-media RNNoise extraction must run before the media suite');
    }
    for (const need of ['rust-wasi', 'rust-native']) {
      if (!new RegExp(`^\\s*needs:.*(?<![\\w-])${need}(?![\\w-])`, 'm').test(jobs['browser-media'])) {
        problems.push(`ci.yml: job "browser-media" downloads the ${need} artifact but has no "needs: ${need}"`);
      }
    }
  }

  return problems;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const problems = checkWorkflow(process.argv[2] ?? process.cwd());
  for (const p of problems) console.error(p);
  process.exit(problems.length === 0 ? 0 : 1);
}
