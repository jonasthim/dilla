import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkWorkflow, NON_RACE_STEP, raceGatedTests } from './check-ci-workflow.mjs';

const SCRIPT_PATH = fileURLToPath(new URL('./check-ci-workflow.mjs', import.meta.url));

// The go job's test step: every package but internal/ds, which go-ds runs (CI budget, fix wave).
const GO_TEST = 'go test -race -shuffle=on -timeout 15m $(go list ./... | grep -vx github.com/jonasthim/dilla/internal/ds)';

const GOOD = `name: ci
on:
  push:
    branches: [main]
  pull_request:
concurrency:
  group: \${{ github.workflow }}-\${{ github.ref }}
  cancel-in-progress: true
env:
  CARGO_TERM_COLOR: always
jobs:
  node:
    runs-on: ubuntu-latest
    steps:
      - run: npm test
      - run: npm run test:ci-check
      - run: npm run test:wasm-size-check
  ui:
    runs-on: ubuntu-latest
    steps:
      - run: npm test -w packages/ui
  rust-native:
    runs-on: ubuntu-latest
    steps:
      - run: cargo fmt --all --check
      - run: cargo clippy --workspace --all-targets --all-features --locked -- -D warnings
      - run: cargo test --workspace --all-features --locked
      - run: cargo build -p dilla-testkit --release --locked
      - uses: actions/upload-artifact@v7
        with:
          name: dilla-testkit
          path: target/release/dilla-testkit
          if-no-files-found: error
  rust-wasm-node:
    runs-on: ubuntu-latest
    steps:
      - run: cargo test -p dilla-core-wasm --target wasm32-unknown-unknown --locked
      - run: wasm-pack build core/dilla-core-wasm --target web --profile wasm-release --mode no-install --out-dir ../../packages/media/wasm
      - run: wasm-pack build core/dilla-core-wasm --target web --profile wasm-release --mode no-install --out-dir ../../packages/core-wasm/pkg
      - run: node scripts/check-wasm-size.mjs packages/core-wasm/pkg/dilla_core_wasm_bg.wasm
      - run: npm ci
      - run: npm run typecheck -w @dilla/media
      - run: npm run test:wasm -w @dilla/media
      - run: npm run check:schema -w @dilla/media
  rust-wasi:
    runs-on: ubuntu-latest
    steps:
      - run: cargo build -p dilla-core-wasi --target wasm32-wasip1 --release --locked
      - uses: actions/upload-artifact@v7
        with:
          name: dilla-core-wasi
          path: target/wasm32-wasip1/release/dilla_core_wasi.wasm
          if-no-files-found: error
  vectors:
    runs-on: ubuntu-latest
    steps:
      - run: npm run vectors
      - run: git diff --exit-code -- protocol/vectors
      - run: cargo run -p dilla-testkit --bin dilla-testkit --locked -- vectors
  browser-spike:
    runs-on: ubuntu-latest
    timeout-minutes: 20
    steps:
      - run: wasm-pack build core/dilla-core-wasm --target web --profile wasm-release --mode no-install --out-dir spike/pkg
      - run: npm run test:e2e:matrix -w @dilla/e2e
  deny:
    runs-on: ubuntu-latest
    steps:
      - run: cargo deny --all-features check advisories bans licenses sources
  go:
    runs-on: ubuntu-latest
    needs: [rust-wasi]
    steps:
      - uses: actions/download-artifact@v8
        with:
          name: dilla-core-wasi
          path: internal/mlswasi/testdata
      - run: go vet ./...
      - run: CGO_ENABLED=0 go build -tags dillapins ./internal/deps
      - run: go test -race -shuffle=on -timeout 15m $(go list ./... | grep -vx github.com/jonasthim/dilla/internal/ds)
      - run: ${NON_RACE_STEP}
      - run: CGO_ENABLED=0 go build -trimpath -ldflags='-s -w' ./cmd/dillad

  browser-media:
    runs-on: ubuntu-latest
    timeout-minutes: 25
    needs: [rust-native, rust-wasi]
    steps:
      - uses: actions/download-artifact@v8
        with:
          name: dilla-core-wasi
          path: internal/mlswasi/testdata
      - uses: actions/download-artifact@v8
        with:
          name: dilla-testkit
          path: artifacts
      - run: wasm-pack build core/dilla-core-wasm --target web --profile wasm-release --mode no-install --out-dir ../../packages/media/wasm
      - run: go build -o target/dilla-mediabot ./cmd/dilla-mediabot
      - run: node packages/media/scripts/extract-rnnoise-wasm.mjs
      - run: npx playwright install --with-deps chromium firefox
      - run: sh scripts/ci-audio-server.sh
      - run: npm run test:e2e:media -w @dilla/e2e
        env:
          DILLA_TESTKIT: \${{ github.workspace }}/artifacts/dilla-testkit
      - run: npx playwright test --config e2e/playwright.media.config.ts --project=chromium-media unsupported-sfu-codec.spec.ts
        env:
          DILLA_MEDIA_SFU_AV1: '1'
          DILLA_TESTKIT: \${{ github.workspace }}/artifacts/dilla-testkit
      - uses: actions/upload-artifact@v7
        if: failure()
        with:
          name: browser-media-results
          path: e2e/test-results
          if-no-files-found: error

  go-ds:
    runs-on: ubuntu-latest
    timeout-minutes: 25
    needs: [rust-wasi]
    steps:
      - uses: actions/download-artifact@v8
        with:
          name: dilla-core-wasi
          path: internal/mlswasi/testdata
      - run: go test -race -shuffle=on -timeout 20m ./internal/ds/...

  go-harness:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    needs: [rust-wasi, rust-native]
    steps:
      - uses: actions/download-artifact@v8
        with:
          name: dilla-core-wasi
          path: internal/mlswasi/testdata
      - uses: actions/download-artifact@v8
        with:
          name: dilla-testkit
          path: artifacts
      - run: go test -race -shuffle=on -timeout 25m ./internal/testkit/...
        env:
          DILLA_TESTKIT: \${{ github.workspace }}/artifacts/dilla-testkit
          DILLA_TESTKIT_REQUIRED: '1'

  go-fts5-arm64:
    runs-on: ubuntu-24.04-arm
    steps:
      - run: go test ./internal/store/sqlite/...

  go-lint:
    runs-on: ubuntu-latest
    steps:
      - uses: golangci/golangci-lint-action@v9
        with:
          version: v2.13.2

  go-vuln:
    runs-on: ubuntu-latest
    steps:
      - run: go run golang.org/x/vuln/cmd/govulncheck@v1.8.0 ./...
      - run: go run golang.org/x/vuln/cmd/govulncheck@v1.8.0 -scan package -tags dillapins ./internal/deps

  go-sqlc:
    runs-on: ubuntu-latest
    steps:
      - uses: sqlc-dev/setup-sqlc@v5
        with:
          sqlc-version: '1.31.1'
      - run: sqlc diff
      - run: git diff --exit-code

  go-postgres:
    runs-on: ubuntu-latest
    needs: [rust-wasi]
    services:
      postgres:
        image: postgres:18.6-alpine3.24
        env:
          POSTGRES_INITDB_ARGS: --locale-provider=builtin --builtin-locale=C.UTF-8
    steps:
      - run: go test -race -shuffle=on -timeout 20m ./internal/store/... ./internal/ops/...
        env:
          DILLA_TEST_PG: postgres://dilla:dilla@127.0.0.1:5432/dilla?sslmode=disable

  go-release:
    runs-on: ubuntu-latest
    steps:
      - run: CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -o dist/dillad-linux-amd64 ./cmd/dillad
      - uses: actions/upload-artifact@v7
        with:
          name: dillad-binaries
          path: dist/
          if-no-files-found: error

  image:
    runs-on: ubuntu-latest
    needs: [go, go-ds, go-lint, rust-wasi]
    permissions: { contents: read, packages: write }
    timeout-minutes: 30
    steps:
      - uses: actions/checkout@v7
      - uses: actions/download-artifact@v8
        with:
          name: dilla-core-wasi
          path: internal/mlswasi/testdata
      - uses: docker/setup-buildx-action@v4.4.1
      - uses: docker/login-action@v4.6.0
      - uses: docker/metadata-action@v6.2.0
        id: meta
        with:
          images: ghcr.io/\${{ github.repository }}/dillad
          tags: |
            type=raw,value=latest,enable={{is_default_branch}}
            type=ref,event=branch
      - uses: docker/build-push-action@v7.4.0
        with:
          context: .
          platforms: linux/amd64,linux/arm64
          provenance: mode=max
          sbom: true
`;

// The race-gated Go tests of the repository (ruling I8), as GOOD's non-race step names them.
const GATED = [
  ['cmd/dilla-loadrig', 'TestALoopbackCellDecryptsEverything'],
  ['cmd/dilla-mediabot', 'TestTwoBotsDecryptEachOtherThroughTheSFU'],
  ['internal/media', 'TestGoPublisherToGoSubscriberDecryptsThroughTheSFU'],
  ['internal/sfu', 'TestTheSFUOfferCarriesOnlyTheDillaCodecs'],
  ['internal/sfu', 'TestPromotionAddsTheVideoSourcesAndDemotionRemovesThem'],
];

function gatedTest(name) {
  return `package x\n\nimport "testing"\n\nfunc ${name}(t *testing.T) {\n\tif raceEnabled {\n\t\tt.Skip("upstream livekit-server data race in updateRidsFromSDP; runs in the non-race step")\n\t}\n}\n`;
}

// A repository root holding ci.yml and, as Go test files, the race-gated tests in `gated`.
function fixture(body, gated = GATED) {
  const dir = mkdtempSync(join(tmpdir(), 'dilla-ci-'));
  mkdirSync(join(dir, '.github', 'workflows'), { recursive: true });
  writeFileSync(join(dir, '.github', 'workflows', 'ci.yml'), body);
  for (const [pkg, name] of gated) {
    mkdirSync(join(dir, pkg), { recursive: true });
    writeFileSync(join(dir, pkg, `${name}_test.go`), gatedTest(name));
  }
  return dir;
}

test('the real workflow passes every rule', () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  assert.deepEqual(checkWorkflow(root), []);
});

test('a well-formed workflow passes', () => {
  assert.deepEqual(checkWorkflow(fixture(GOOD)), []);
});

test('a missing job is reported by name', () => {
  const problems = checkWorkflow(fixture(GOOD.replace(/  deny:[\s\S]*$/, '')));
  assert.ok(problems.some((p) => p.includes('deny')), problems.join('\n'));
});

test('|| true is reported with its line number', () => {
  const problems = checkWorkflow(fixture(GOOD.replace('- run: npm test\n', '- run: npm test || true\n')));
  assert.ok(problems.some((p) => /\|\| true/.test(p)), problems.join('\n'));
});

test('continue-on-error is reported', () => {
  const problems = checkWorkflow(fixture(GOOD.replace('  deny:\n', '  deny:\n    continue-on-error: true\n')));
  assert.ok(problems.some((p) => p.includes('continue-on-error')), problems.join('\n'));
});

test('if: always() is reported', () => {
  const problems = checkWorkflow(fixture(GOOD.replace('      - run: npm test\n', '      - if: always()\n        run: npm test\n')));
  assert.ok(problems.some((p) => p.includes('always()')), problems.join('\n'));
});

// Fix round 1, finding 1 (important): the explicit-expression spelling `if: ${{ always() }}` is just
// as valid as `if: always()` and just as capable of making a job non-blocking, so the R22 gate must
// catch it too.
test('if: ${{ always() }} is reported', () => {
  const problems = checkWorkflow(
    fixture(GOOD.replace('      - run: npm test\n', '      - if: ${{ always() }}\n        run: npm test\n')),
  );
  assert.ok(problems.some((p) => p.includes('always()')), problems.join('\n'));
});

test('a job that lost a required step is reported', () => {
  const problems = checkWorkflow(fixture(GOOD.replace('      - run: cargo fmt --all --check\n', '')));
  assert.ok(problems.some((p) => p.includes('cargo fmt')), problems.join('\n'));
});

test('a missing concurrency block is reported', () => {
  const problems = checkWorkflow(fixture(GOOD.replace(/concurrency:[\s\S]*?cancel-in-progress: true\n/, '')));
  assert.ok(problems.some((p) => p.includes('concurrency')), problems.join('\n'));
});

test('a workflow-level RUSTFLAGS is reported', () => {
  const problems = checkWorkflow(fixture(GOOD.replace('  CARGO_TERM_COLOR: always\n', '  CARGO_TERM_COLOR: always\n  RUSTFLAGS: -D warnings\n')));
  assert.ok(problems.some((p) => p.includes('RUSTFLAGS')), problems.join('\n'));
});

test('a rust-wasi job that lost if-no-files-found is reported', () => {
  const problems = checkWorkflow(fixture(GOOD.replace('          if-no-files-found: error\n', '')));
  assert.ok(problems.some((p) => p.includes('if-no-files-found')), problems.join('\n'));
});

test('a rust-wasi job that lost the artifact path is reported', () => {
  const problems = checkWorkflow(
    fixture(GOOD.replace('          path: target/wasm32-wasip1/release/dilla_core_wasi.wasm\n', '')),
  );
  assert.ok(problems.some((p) => p.includes('dilla_core_wasi.wasm')), problems.join('\n'));
});

test('a go job without needs: rust-wasi is reported', () => {
  const problems = checkWorkflow(fixture(GOOD.replace('    needs: [rust-wasi]\n', '    needs: [deny]\n')));
  assert.ok(problems.some((p) => p.includes('"go"') && p.includes('needs: rust-wasi')), problems.join('\n'));
});

test('a go-harness job without needs: rust-wasi is reported', () => {
  const problems = checkWorkflow(fixture(GOOD.replace('    needs: [rust-wasi, rust-native]\n', '    needs: [rust-native]\n')));
  assert.ok(problems.some((p) => p.includes('"go-harness"') && p.includes('needs: rust-wasi')), problems.join('\n'));
});

// The edges are order-independent to GitHub, so the ordering rule must accept either order.
test('a go-harness job whose needs: lists the two edges in the other order passes', () => {
  assert.deepEqual(
    checkWorkflow(fixture(GOOD.replace('needs: [rust-wasi, rust-native]', 'needs: [rust-native, rust-wasi]'))),
    [],
  );
});

// The go job has no testkit binary: requiring one there would fail every run.
test('a go job that requires the testkit it does not download is reported', () => {
  const problems = checkWorkflow(
    fixture(GOOD.replace(`      - run: ${GO_TEST}\n`,
      `      - run: ${GO_TEST}\n        env:\n          DILLA_TESTKIT_REQUIRED: '1'\n`)),
  );
  assert.ok(problems.some((p) => p.includes('go-harness\'s')), problems.join('\n'));
});

test('a workflow without the go-harness job is reported', () => {
  const problems = checkWorkflow(fixture(GOOD.replace(/  go-harness:[\s\S]*?\n\n/, '')));
  assert.ok(problems.some((p) => p.includes('missing job "go-harness"')), problems.join('\n'));
});

test('a go-harness job that lost its own timeout is reported', () => {
  const problems = checkWorkflow(fixture(GOOD.replace('    timeout-minutes: 30\n', '')));
  assert.ok(problems.some((p) => p.includes('timeout-minutes: 30')), problems.join('\n'));
});

test('a node job that stopped running the checker\'s own tests is reported', () => {
  const problems = checkWorkflow(fixture(GOOD.replace('      - run: npm run test:ci-check\n', '')));
  assert.ok(problems.some((p) => p.includes('test:ci-check')), problems.join('\n'));
});

// Fix round 1, finding 3 (important): gap-31 §4 item 2 / NV-14 resolved the pairing as
// `upload-artifact@v7` with `download-artifact@v8` — pairing v7 with v4 (facts/plan-B.md's now-stale
// deviation B15 text) is the untested combination B15 existed to prevent. The checker owns the
// cross-plan ordering rule already, so it must own this half of the hand-off too.
test('a go-harness job without needs: rust-native is reported', () => {
  const problems = checkWorkflow(fixture(GOOD.replace('needs: [rust-wasi, rust-native]', 'needs: [rust-wasi]')));
  assert.ok(problems.some((p) => p.includes('needs: rust-native')), problems.join('\n'));
});

test('a rust-native job that stopped building the testkit is reported', () => {
  const problems = checkWorkflow(
    fixture(GOOD.replace('      - run: cargo build -p dilla-testkit --release --locked\n', '')),
  );
  assert.ok(problems.some((p) => p.includes('cargo build -p dilla-testkit')), problems.join('\n'));
});

test('a rust-native job that lost the testkit artifact name is reported', () => {
  const problems = checkWorkflow(fixture(GOOD.replace('          name: dilla-testkit\n          path: target', '          path: target')));
  assert.ok(problems.some((p) => p.includes('name: dilla-testkit')), problems.join('\n'));
});

test('a go-harness job that stopped receiving DILLA_TESTKIT is reported', () => {
  const problems = checkWorkflow(
    fixture(
      GOOD.replace(
        "        env:\n          DILLA_TESTKIT: \${{ github.workspace }}/artifacts/dilla-testkit\n          DILLA_TESTKIT_REQUIRED: '1'\n",
        '',
      ),
    ),
  );
  assert.ok(problems.some((p) => p.endsWith('is missing: DILLA_TESTKIT')), problems.join('\n'));
});

// `DILLA_TESTKIT` is a prefix of `DILLA_TESTKIT_REQUIRED`, so the first check alone would pass a
// go-harness job that dropped the second: a missing binary would then skip every scenario test, job
// still green.
test('a go-harness job that stopped requiring the testkit is reported', () => {
  const problems = checkWorkflow(fixture(GOOD.replace("          DILLA_TESTKIT_REQUIRED: '1'\n", '')));
  assert.ok(problems.some((p) => p.endsWith('is missing: DILLA_TESTKIT_REQUIRED')), problems.join('\n'));
});

// The wildcard is what picks up every new internal/... package without a workflow edit.
test('a go job whose test step is narrowed to a package list is reported', () => {
  const problems = checkWorkflow(
    fixture(GOOD.replace(GO_TEST, 'go test -race -shuffle=on -timeout 15m ./internal/store/...')),
  );
  assert.ok(problems.some((p) => p.includes('must be exactly')), problems.join('\n'));
});

// CI budget (fix wave): the go job leaves out internal/ds and nothing else, and go-ds runs it.
test('a go job that leaves out more than internal/ds is reported', () => {
  const problems = checkWorkflow(
    fixture(GOOD.replace('grep -vx github.com/jonasthim/dilla/internal/ds', 'grep -v -e /internal/ds -e /internal/api')),
  );
  assert.ok(problems.some((p) => p.includes('must be exactly')), problems.join('\n'));
});

test('a workflow without the go-ds job is reported', () => {
  const problems = checkWorkflow(fixture(GOOD.replace(/  go-ds:[\s\S]*?\n\n/, '')));
  assert.ok(problems.some((p) => p.includes('missing job "go-ds"')), problems.join('\n'));
});

test('a go-ds job that stopped running internal/ds is reported', () => {
  const problems = checkWorkflow(
    fixture(GOOD.replace('      - run: go test -race -shuffle=on -timeout 20m ./internal/ds/...\n', '')),
  );
  assert.ok(problems.some((p) => p.includes('"go-ds"') && p.includes('./internal/ds/...')), problems.join('\n'));
});

test('a go-ds job without needs: rust-wasi is reported', () => {
  const start = GOOD.indexOf('  go-ds:\n');
  const body = GOOD.slice(start, GOOD.indexOf('\n\n', start));
  const problems = checkWorkflow(fixture(GOOD.replace(body, () => body.replace('    needs: [rust-wasi]\n', ''))));
  assert.ok(problems.some((p) => p.includes('"go-ds"') && p.includes('rust-wasi')), problems.join('\n'));
});

test('an image job that does not wait for go-ds is reported', () => {
  const problems = checkWorkflow(fixture(GOOD.replace('needs: [go, go-ds, go-lint, rust-wasi]', 'needs: [go, go-lint, rust-wasi]')));
  assert.ok(problems.some((p) => p.includes('"image"') && p.includes('"go-ds"')), problems.join('\n'));
});

for (const [job, needle] of [
  ['rust-wasm-node', 'wasm-pack build core/dilla-core-wasm --target web --profile wasm-release --mode no-install --out-dir ../../packages/media/wasm'],
  ['rust-wasm-node', 'wasm-pack build core/dilla-core-wasm --target web --profile wasm-release --mode no-install --out-dir ../../packages/core-wasm/pkg'],
  ['rust-wasm-node', 'node scripts/check-wasm-size.mjs packages/core-wasm/pkg/dilla_core_wasm_bg.wasm'],
  ['rust-wasm-node', 'npm run typecheck -w @dilla/media'],
  ['rust-wasm-node', 'npm run test:wasm -w @dilla/media'],
  ['rust-wasm-node', 'npm run check:schema -w @dilla/media'],
  ['go-harness', 'go test -race -shuffle=on -timeout 25m ./internal/testkit/...'],
  ['go-harness', 'name: dilla-testkit'],
  ['go-lint', 'version: v2.13.2'],
  ['go-vuln', '-scan package -tags dillapins ./internal/deps'],
  ['go-sqlc', 'sqlc diff'],
  ['go-postgres', 'postgres:18.6-alpine3.24'],
  ['go-postgres', '--locale-provider=builtin --builtin-locale=C.UTF-8'],
  ['go-postgres', 'DILLA_TEST_PG'],
  // I7 (fix wave): internal/ops holds the only Postgres backup, restore and heal tests; a step that
  // drops it skips them in every job. The -timeout is explicit so a slow package fails by name.
  ['go-postgres', 'go test -race -shuffle=on -timeout 20m ./internal/store/... ./internal/ops/...'],
  ['go-release', 'if-no-files-found: error'],
]) {
  test(`a ${job} job that lost "${needle}" is reported`, () => {
    const start = GOOD.indexOf(`  ${job}:\n`);
    const end = GOOD.indexOf('\n\n', start);
    const body = GOOD.slice(start, end === -1 ? undefined : end);
    assert.ok(body.includes(needle), 'fixture sanity: ' + needle);
    const gutted = body.split('\n').filter((l) => !l.includes(needle)).join('\n');
    const problems = checkWorkflow(fixture(GOOD.replace(body, () => gutted)));
    assert.ok(problems.some((p) => p.includes(`"${job}"`) && p.includes(needle)), problems.join('\n'));
  });
}

test('a go job with download-artifact@v4 instead of v8 is reported', () => {
  const problems = checkWorkflow(
    fixture(GOOD.replaceAll('actions/download-artifact@v8', 'actions/download-artifact@v4')),
  );
  assert.ok(problems.some((p) => p.includes('download-artifact@v8')), problems.join('\n'));
});

// Ruling L: the Go half of the tree is gated by this checker too, so a workflow that simply never
// declares the `go` job — the state this repository was in before Plan B task 8 — must be reported
// rather than silently accepted. Before this rule the checker passed such a workflow.
test('a workflow with no go job at all is reported', () => {
  const problems = checkWorkflow(fixture(GOOD.replace(/  go:[\s\S]*$/, '')));
  assert.ok(problems.some((p) => p.includes('missing job "go"')), problems.join('\n'));
  assert.ok(problems.some((p) => p.includes('missing job "go-fts5-arm64"')), problems.join('\n'));
  for (const job of ['go-lint', 'go-vuln', 'go-sqlc', 'go-postgres', 'go-release']) {
    assert.ok(problems.some((p) => p.includes(`missing job "${job}"`)), problems.join('\n'));
  }
});

// Ruling M: `internal/deps` is the only thing that compiles the pinned LiveKit/wazero/sqlite graph
// with the three pion `replace` directives, and it is behind the `dillapins` tag, so no other step
// in the workflow would notice the graph breaking.
test('a go job that lost the pinned-module-graph build is reported', () => {
  const problems = checkWorkflow(
    fixture(GOOD.replace('      - run: CGO_ENABLED=0 go build -tags dillapins ./internal/deps\n', '')),
  );
  assert.ok(problems.some((p) => p.includes('dillapins')), problems.join('\n'));
});

test('a go job that stopped running the race-detector tests is reported', () => {
  const problems = checkWorkflow(
    fixture(GOOD.replace(`      - run: ${GO_TEST}\n`, '')),
  );
  assert.ok(problems.some((p) => p.includes('-race')), problems.join('\n'));
});

test('a go-fts5-arm64 job that stopped running on arm is reported', () => {
  const problems = checkWorkflow(fixture(GOOD.replace('    runs-on: ubuntu-24.04-arm\n', '    runs-on: ubuntu-latest\n')));
  assert.ok(problems.some((p) => p.includes('ubuntu-24.04-arm')), problems.join('\n'));
});

// The CLI entry point at the bottom of check-ci-workflow.mjs, not `checkWorkflow` itself: this must
// be run as a subprocess from a cwd that is NOT the fixture root and has no .github/workflows of its
// own, so a script that silently fell back to process.cwd() (ignoring argv[2]) cannot pass by
// accident — it would fail to find ci.yml at all rather than happening to validate the right file.
function runCli(root, cwd) {
  return spawnSync(process.execPath, [SCRIPT_PATH, root], { cwd, encoding: 'utf8' });
}

test('the CLI honours a root argument passed from a different cwd', () => {
  const root = fixture(GOOD);
  const cwd = mkdtempSync(join(tmpdir(), 'dilla-ci-cwd-'));
  const result = runCli(root, cwd);
  assert.equal(result.status, 0, `stdout: ${result.stdout}\nstderr: ${result.stderr}`);
});

test('the CLI reports problems in a workflow at the given root, run from elsewhere', () => {
  const root = fixture(GOOD.replace(/  deny:[\s\S]*$/, ''));
  const cwd = mkdtempSync(join(tmpdir(), 'dilla-ci-cwd-'));
  const result = runCli(root, cwd);
  assert.equal(result.status, 1, `stdout: ${result.stdout}\nstderr: ${result.stderr}`);
  assert.match(result.stderr, /deny/);
});

// Task 18: the image job.
test('a workflow without the image job is reported', () => {
  const problems = checkWorkflow(fixture(GOOD.replace(/  image:[\s\S]*$/, '')));
  assert.ok(problems.some((p) => p.includes('missing job "image"')), problems.join('\n'));
});

for (const needle of [
  'docker/setup-buildx-action@v4.4.1',
  'docker/login-action@v4.6.0',
  'docker/metadata-action@v6.2.0',
  'docker/build-push-action@v7.4.0',
  'platforms: linux/amd64,linux/arm64',
  'actions/checkout@v7',
  'actions/download-artifact@v8',
  'path: internal/mlswasi/testdata',
  'provenance: mode=max',
  'sbom: true',
  'timeout-minutes: 30',
  // I16 (fix wave): metadata-action generates `latest` only for tag events, so without this line a
  // push to main publishes `:main` alone and Compose's `:latest` pull fails with "manifest unknown".
  'type=raw,value=latest,enable={{is_default_branch}}',
]) {
  test(`an image job that lost "${needle}" is reported`, () => {
    const start = GOOD.indexOf('  image:\n');
    const body = GOOD.slice(start);
    assert.ok(body.includes(needle), 'fixture sanity: ' + needle);
    const gutted = body.split('\n').filter((l) => !l.includes(needle)).join('\n');
    const problems = checkWorkflow(fixture(GOOD.replace(body, () => gutted)));
    assert.ok(problems.some((p) => p.includes('"image"') && p.includes(needle)), problems.join('\n'));
  });
}

test('setup-qemu-action anywhere in the workflow is reported', () => {
  const problems = checkWorkflow(
    fixture(GOOD.replace('      - uses: docker/setup-buildx-action@v4.4.1\n', '      - uses: docker/setup-qemu-action@v4\n      - uses: docker/setup-buildx-action@v4.4.1\n')),
  );
  assert.ok(problems.some((p) => p.includes('setup-qemu-action')), problems.join('\n'));
});

// `go` is a prefix of `go-lint`: an image job that waits only for go-lint and rust-wasi must still be
// reported as not waiting for go.
test('an image job that does not wait for the go job is reported', () => {
  const problems = checkWorkflow(fixture(GOOD.replace('needs: [go, go-ds, go-lint, rust-wasi]', 'needs: [go-ds, go-lint, rust-wasi]')));
  assert.ok(problems.some((p) => p.includes('"image"') && p.includes('"go"')), problems.join('\n'));
});

test('an image job that does not wait for go-lint is reported', () => {
  const problems = checkWorkflow(fixture(GOOD.replace('needs: [go, go-ds, go-lint, rust-wasi]', 'needs: [go, go-ds, rust-wasi]')));
  assert.ok(problems.some((p) => p.includes('"image"') && p.includes('"go-lint"')), problems.join('\n'));
});

// The rule that covers a job added tomorrow: no job is named in REQUIRED_STEPS, yet its upload-artifact
// step is still held to the fail-closed setting.
test('an upload-artifact step in any job without if-no-files-found: error is reported', () => {
  const extra = '\n  extra:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/upload-artifact@v7\n        with:\n          name: x\n          path: y\n      - run: echo after\n';
  const problems = checkWorkflow(fixture(GOOD + extra));
  assert.deepEqual(
    problems.map((p) => p.replace(/^ci\.yml:\d+: /, '')),
    ['actions/upload-artifact without "if-no-files-found: error" — CI is fail-closed'],
  );
  // The same step with the setting is clean.
  assert.deepEqual(checkWorkflow(fixture(GOOD + extra.replace('          path: y\n', '          path: y\n          if-no-files-found: error\n'))), []);
});

// Task 21: the browser E2EE suite.
test('a workflow without the browser-media job is reported', () => {
  const problems = checkWorkflow(fixture(GOOD.replace(/  browser-media:[\s\S]*?\n\n/, '')));
  assert.ok(problems.some((p) => p.includes('missing job "browser-media"')), problems.join('\n'));
});

test('browser-media must explicitly extract RNNoise wasm before Playwright', () => {
  const step = '      - run: node packages/media/scripts/extract-rnnoise-wasm.mjs\n';
  assert.deepEqual(checkWorkflow(fixture(GOOD)), []);
  const problems = checkWorkflow(fixture(GOOD.replace(step, '')));
  assert.ok(problems.some((p) => p.includes('extract-rnnoise-wasm.mjs')), problems.join('\n'));
});

test('browser-media extraction must precede the media suite', () => {
  const step = '      - run: node packages/media/scripts/extract-rnnoise-wasm.mjs\n';
  const moved = GOOD.replace(step, '').replace('      - run: npm run test:e2e:media -w @dilla/e2e\n', '      - run: npm run test:e2e:media -w @dilla/e2e\n' + step);
  const problems = checkWorkflow(fixture(moved));
  assert.ok(problems.some((p) => p.includes('RNNoise extraction') && p.includes('before')), problems.join('\n'));
});

test('browser-media must start an audio server before the media suite', () => {
  const step = '      - run: sh scripts/ci-audio-server.sh\n';
  const missing = checkWorkflow(fixture(GOOD.replace(step, '')));
  assert.ok(missing.some((p) => p.includes('ci-audio-server.sh')), missing.join('\n'));
  const moved = GOOD.replace(step, '').replace('      - run: npm run test:e2e:media -w @dilla/e2e\n', '      - run: npm run test:e2e:media -w @dilla/e2e\n' + step);
  const late = checkWorkflow(fixture(moved));
  assert.ok(late.some((p) => p.includes('audio server') && p.includes('before')), late.join('\n'));
});

test('the browser-media job requires the real-SFU AV1 leg', () => {
  const stripped = GOOD.replace(/      - run: npx playwright test --config e2e\/playwright\.media\.config\.ts --project=chromium-media unsupported-sfu-codec\.spec\.ts\n        env:\n          DILLA_MEDIA_SFU_AV1: '1'\n          DILLA_TESTKIT: \$\{\{ github\.workspace \}\}\/artifacts\/dilla-testkit\n/, '');
  const problems = checkWorkflow(fixture(stripped));
  assert.ok(problems.some((p) => p.includes('unsupported-sfu-codec.spec.ts')), problems.join('\n'));
});

for (const [need, kept] of [['rust-wasi', 'rust-native'], ['rust-native', 'rust-wasi']]) {
  test(`a browser-media job without needs: ${need} is reported`, () => {
    const problems = checkWorkflow(fixture(GOOD.replace('    needs: [rust-native, rust-wasi]\n', `    needs: [${kept}]\n`)));
    assert.ok(problems.some((p) => p.includes('"browser-media"') && p.includes(`needs: ${need}`)), problems.join('\n'));
  });
}

for (const needle of [
  'timeout-minutes: 25',
  'name: dilla-core-wasi',
  'path: internal/mlswasi/testdata',
  'name: dilla-testkit',
  'wasm-pack build core/dilla-core-wasm --target web --profile wasm-release --mode no-install --out-dir ../../packages/media/wasm',
  'go build -o target/dilla-mediabot ./cmd/dilla-mediabot',
  'npx playwright install --with-deps chromium firefox',
  'npm run test:e2e:media -w @dilla/e2e',
  'DILLA_TESTKIT: ${{ github.workspace }}/artifacts/dilla-testkit',
]) {
  test(`a browser-media job that lost "${needle}" is reported`, () => {
    const start = GOOD.indexOf('  browser-media:\n');
    const body = GOOD.slice(start, GOOD.indexOf('\n\n', start));
    assert.ok(body.includes(needle), 'fixture sanity: ' + needle);
    const gutted = body.split('\n').filter((l) => !l.includes(needle)).join('\n');
    const problems = checkWorkflow(fixture(GOOD.replace(body, () => gutted)));
    assert.ok(problems.some((p) => p.includes('"browser-media"') && p.includes(needle)), problems.join('\n'));
  });
}

test('a browser-spike job without its timeout is reported', () => {
  const problems = checkWorkflow(fixture(GOOD.replace('    timeout-minutes: 20\n', '')));
  assert.ok(problems.some((p) => p.includes('"browser-spike"') && p.includes('timeout-minutes: 20')), problems.join('\n'));
});

test('the video publishing tests retain a non-race CI step', () => {
  const problems = checkWorkflow(fixture(GOOD.replace(NON_RACE_STEP, 'go test ./cmd/dilla-mediabot')));
  assert.ok(problems.some((p) => p.includes('job "go"') && p.includes(NON_RACE_STEP)), problems.join('\n'));
  assert.ok(problems.some((p) => p.includes('no non-race') && p.includes('5 race-gated')), problems.join('\n'));
});

// Ruling I8, the CI run on main after PR #7: TestALoopbackCellDecryptsEverything published VP8 under
// -race. The repository's gated tests are exactly the ones the non-race step names.
test('the repository gates exactly the tests the non-race step names', () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const found = raceGatedTests(root).map((g) => [g.pkg.slice(2), g.name]);
  assert.deepEqual(found.toSorted(), GATED.toSorted());
});

test('a race-gated test the non-race step does not name is reported', () => {
  const extra = [...GATED, ['internal/api', 'TestANewVideoPublisher']];
  const problems = checkWorkflow(fixture(GOOD, extra));
  assert.ok(problems.some((p) => p.includes('does not name race-gated TestANewVideoPublisher')), problems.join('\n'));
  assert.ok(problems.some((p) => p.includes('does not run ./internal/api')), problems.join('\n'));
});

test('a non-race step that lost a gated package is reported', () => {
  const step = NON_RACE_STEP.replace(' ./cmd/dilla-loadrig', '');
  const problems = checkWorkflow(fixture(GOOD.replace(NON_RACE_STEP, step)));
  assert.ok(
    problems.some((p) => p.includes('does not run ./cmd/dilla-loadrig') && p.includes('TestALoopbackCellDecryptsEverything')),
    problems.join('\n'),
  );
});

test('a non-race step that lost a gated test name is reported', () => {
  const step = NON_RACE_STEP.replace('TestALoopbackCellDecryptsEverything|', '');
  const problems = checkWorkflow(fixture(GOOD.replace(NON_RACE_STEP, step)));
  assert.ok(problems.some((p) => p.includes('does not name race-gated TestALoopbackCellDecryptsEverything')), problems.join('\n'));
});

// A renamed or deleted test leaves an alternative that matches nothing, and go test passes that.
test('a non-race step naming a test that is not gated is reported', () => {
  const problems = checkWorkflow(fixture(GOOD, GATED.slice(1)));
  assert.ok(problems.some((p) => p.includes('names TestALoopbackCellDecryptsEverything, which is no race-gated test')), problems.join('\n'));
});

test('a non-race step that gained -race is reported', () => {
  const problems = checkWorkflow(fixture(GOOD.replace(NON_RACE_STEP, NON_RACE_STEP.replace('go test ', 'go test -race '))));
  assert.ok(problems.some((p) => p.includes('no non-race')), problems.join('\n'));
});

test('a raceEnabled gate outside a Test function is reported', () => {
  const root = fixture(GOOD);
  writeFileSync(join(root, 'internal', 'sfu', 'helper_test.go'), 'package x\n\nfunc helper() {\n\tif raceEnabled {\n\t\treturn\n\t}\n}\n');
  const problems = checkWorkflow(root);
  assert.ok(problems.some((p) => p.includes('internal/sfu/helper_test.go') && p.includes('outside a Test function')), problems.join('\n'));
});

test('race gates under node_modules and dot-directories are not the module\'s', () => {
  const root = fixture(GOOD);
  for (const dir of ['node_modules/x', '.claude/worktrees/other']) {
    mkdirSync(join(root, dir), { recursive: true });
    writeFileSync(join(root, dir, 'gate_test.go'), gatedTest('TestElsewhere'));
  }
  assert.deepEqual(checkWorkflow(root), []);
});

test('browser-media must upload failure traces and host logs', () => {
  const problems = checkWorkflow(fixture(GOOD.replace('name: browser-media-results', 'name: removed-results')));
  assert.ok(problems.some((p) => p.includes('browser-media') && p.includes('browser-media-results')), problems.join('\n'));
});

test('a node job that stopped running the wasm size checker\'s own tests is reported', () => {
  const problems = checkWorkflow(fixture(GOOD.replace('      - run: npm run test:wasm-size-check\n', '')));
  assert.ok(problems.some((p) => p.includes('"node"') && p.includes('npm run test:wasm-size-check')), problems.join('\n'));
});

test('a browser-spike job that lost its size-profile wasm-pack line is reported', () => {
  const line = 'wasm-pack build core/dilla-core-wasm --target web --profile wasm-release --mode no-install --out-dir spike/pkg';
  const problems = checkWorkflow(fixture(GOOD.replace(`      - run: ${line}\n`, '')));
  assert.ok(problems.some((p) => p.includes('"browser-spike"') && p.includes(line)), problems.join('\n'));
});

test('a wasm-pack build with --release instead of the size profile is reported with its line', () => {
  const body = GOOD.replace(
    'wasm-pack build core/dilla-core-wasm --target web --profile wasm-release --mode no-install --out-dir spike/pkg',
    'wasm-pack build core/dilla-core-wasm --target web --release --mode no-install --out-dir spike/pkg',
  );
  assert.notEqual(body, GOOD, 'fixture sanity');
  const lineNo = body.split('\n').findIndex((l) => l.includes('--release --mode no-install --out-dir spike/pkg')) + 1;
  const problems = checkWorkflow(fixture(body));
  assert.ok(
    problems.includes(`ci.yml:${lineNo}: wasm-pack build must use --profile wasm-release, not --release (C16)`),
    problems.join('\n'),
  );
});

test('a wasm-pack build with no profile at all is reported', () => {
  const body = GOOD.replace(
    'wasm-pack build core/dilla-core-wasm --target web --profile wasm-release --mode no-install --out-dir ../../packages/core-wasm/pkg',
    'wasm-pack build core/dilla-core-wasm --target web --mode no-install --out-dir ../../packages/core-wasm/pkg',
  );
  assert.notEqual(body, GOOD, 'fixture sanity');
  const problems = checkWorkflow(fixture(body));
  assert.ok(problems.some((p) => p.endsWith('wasm-pack build must use --profile wasm-release, not --release (C16)')), problems.join('\n'));
});
