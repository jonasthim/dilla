import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BROWSER_WEB_JOBS, checkReleaseWorkflow, checkWorkflow, jobSteps, MIN_BROWSER_WEB_TIMEOUT, NON_RACE_STEP, raceGatedTests, WASM_CLANG_ENV_BLOCK, WASM_CLANG_STEP, WASM_LLVM_KEY_FPR, WASM_LLVM_VERSION } from './check-ci-workflow.mjs';

const SCRIPT_PATH = fileURLToPath(new URL('./check-ci-workflow.mjs', import.meta.url));
const REPO_ROOT = join(dirname(SCRIPT_PATH), '..');
const REAL_CI = readFileSync(join(REPO_ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');
const REAL_RELEASE = readFileSync(join(REPO_ROOT, '.github', 'workflows', 'release.yml'), 'utf8');

// The go job's test step: every package but internal/ds, which go-ds runs (CI budget, fix wave).
const GO_TEST = 'go test -race -shuffle=on -timeout 15m $(go list ./... | grep -vx github.com/jonasthim/dilla/internal/ds)';

const GOOD_BASE = `name: ci
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
      - run: npm run test:manifest-writer
      - run: npm run test:install
  ui:
    runs-on: ubuntu-latest
    steps:
      - run: npm test -w packages/ui
      - run: node packages/ui/scripts/shoot-stories.mjs 6016 target/ui-screens/web-2b form- ceremony- shell- conversation- settings- screens- primitives-channelrow-- conversation-messagetoolbar-- conversation-attachmentcard-- screens-conversation--
      - uses: actions/upload-artifact@v7
        with:
          name: ui-screens
          path: target/ui-screens/web-2b
          if-no-files-found: error
      - run: node packages/ui/scripts/shoot-stories.mjs 6027 target/ui-screens/web-2c/desktop trust-safetycompare-- trust-trustalert-- search-searchpalette-- status-typingindicator-- settings-diagnosticspanel-- shell-tabhand-over-- screens-trustandpolish--
      - run: node packages/ui/scripts/shoot-stories.mjs 6027 target/ui-screens/web-2c/phone trust-safetycompare-- trust-trustalert-- search-searchpalette-- status-typingindicator-- settings-diagnosticspanel-- shell-tabhand-over-- screens-trustandpolish-- --viewport=360x740
      - uses: actions/upload-artifact@v7
        with:
          name: ui-screens-web-2c
          path: |
            target/ui-screens/web-2c/desktop/**
            target/ui-screens/web-2c/phone/**
          if-no-files-found: error
      - run: node packages/ui/scripts/shoot-stories.mjs 6038 target/ui-screens/web-3/desktop voice- media-mediaplayer-- screens-voice--
      - run: node packages/ui/scripts/shoot-stories.mjs 6038 target/ui-screens/web-3/phone voice- media-mediaplayer-- screens-voice-- --viewport=360x740
      - uses: actions/upload-artifact@v7
        with:
          name: ui-screens-web-3
          path: target/ui-screens/web-3/**
          if-no-files-found: error
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
      - uses: dtolnay/rust-toolchain@a2627de80e5819949c7e1c83ed99b29085fc9bc4 # 1.98.1
        with:
          targets: wasm32-unknown-unknown
          components: clippy
      - run: cargo test -p dilla-core-wasm --target wasm32-unknown-unknown --locked
      - run: cargo clippy -p dilla-core-wasm --target wasm32-unknown-unknown --lib --locked -- -D warnings
      - run: wasm-pack build core/dilla-core-wasm --target web --profile wasm-release --mode no-install --out-dir ../../packages/media/wasm
      - run: wasm-pack build core/dilla-core-wasm --target web --profile wasm-release --mode no-install --out-dir ../../packages/core-wasm/pkg
      - run: node scripts/check-wasm-size.mjs packages/core-wasm/pkg/dilla_core_wasm_bg.wasm
      - run: npm ci
      - run: npm run typecheck -w @dilla/media
      - run: npm run typecheck -w @dilla/core-wasm
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

  web-build:
    runs-on: ubuntu-latest
    timeout-minutes: 15
    steps:
      - run: wasm-pack build core/dilla-core-wasm --target web --profile wasm-release --mode no-install --out-dir ../../packages/core-wasm/pkg
      - run: node scripts/check-wasm-size.mjs packages/core-wasm/pkg/dilla_core_wasm_bg.wasm
      - run: npm run typecheck -w @dilla/client-core
      - run: npm run typecheck -w @dilla/web
      - run: npm run build -w @dilla/web
      - run: npm run build:harness -w @dilla/client-core
      - run: go test -tags webdist ./internal/web/...
      - uses: actions/upload-artifact@v7
        with:
          name: dilla-web-dist
          path: packages/web/dist/
          if-no-files-found: error
      - uses: actions/upload-artifact@v7
        with:
          name: dilla-core-harness
          path: packages/client-core/harness-dist/
          if-no-files-found: error

  chromium-web:
    runs-on: ubuntu-latest
    timeout-minutes: ${BROWSER_WEB_JOBS['chromium-web'].timeout}
    needs: [rust-native, rust-wasi, web-build]
    steps:
      - uses: actions/download-artifact@v8
        with:
          name: dilla-core-wasi
          path: internal/mlswasi/testdata
      - uses: actions/download-artifact@v8
        with:
          name: dilla-testkit
          path: artifacts
      - uses: actions/download-artifact@v8
        with:
          name: dilla-web-dist
          path: packages/web/dist
      - uses: actions/download-artifact@v8
        with:
          name: dilla-core-harness
          path: packages/client-core/harness-dist
      - run: npx playwright install --with-deps chromium
      - run: npm run test:e2e:core:chromium -w @dilla/e2e
        env:
          DILLA_TESTKIT: \${{ github.workspace }}/artifacts/dilla-testkit
      - run: npm run test:e2e:web:chromium -w @dilla/e2e
        env:
          DILLA_TESTKIT: \${{ github.workspace }}/artifacts/dilla-testkit
      - run: npm run test:e2e:voice:chromium -w @dilla/e2e
        env:
          DILLA_TESTKIT: \${{ github.workspace }}/artifacts/dilla-testkit
      - uses: actions/upload-artifact@v7
        if: failure()
        with:
          name: browser-web-results-chromium
          path: e2e/test-results
          if-no-files-found: error

  firefox-web:
    runs-on: ubuntu-latest
    timeout-minutes: ${BROWSER_WEB_JOBS['firefox-web'].timeout}
    needs: [rust-native, rust-wasi, web-build]
    steps:
      - uses: actions/download-artifact@v8
        with:
          name: dilla-core-wasi
          path: internal/mlswasi/testdata
      - uses: actions/download-artifact@v8
        with:
          name: dilla-testkit
          path: artifacts
      - uses: actions/download-artifact@v8
        with:
          name: dilla-web-dist
          path: packages/web/dist
      - uses: actions/download-artifact@v8
        with:
          name: dilla-core-harness
          path: packages/client-core/harness-dist
      - run: npx playwright install --with-deps firefox
      - run: npm run test:e2e:core:firefox -w @dilla/e2e
        env:
          DILLA_TESTKIT: \${{ github.workspace }}/artifacts/dilla-testkit
      - run: npm run test:e2e:web:firefox -w @dilla/e2e
        env:
          DILLA_TESTKIT: \${{ github.workspace }}/artifacts/dilla-testkit
      - run: sh scripts/ci-audio-server.sh
      - run: npm run test:e2e:voice:firefox -w @dilla/e2e
        env:
          DILLA_TESTKIT: \${{ github.workspace }}/artifacts/dilla-testkit
      - uses: actions/upload-artifact@v7
        if: failure()
        with:
          name: browser-web-results-firefox
          path: e2e/test-results
          if-no-files-found: error

  webkit-web:
    runs-on: ubuntu-latest
    timeout-minutes: ${BROWSER_WEB_JOBS['webkit-web'].timeout}
    needs: [rust-native, rust-wasi, web-build]
    steps:
      - uses: actions/download-artifact@v8
        with:
          name: dilla-core-wasi
          path: internal/mlswasi/testdata
      - uses: actions/download-artifact@v8
        with:
          name: dilla-testkit
          path: artifacts
      - uses: actions/download-artifact@v8
        with:
          name: dilla-web-dist
          path: packages/web/dist
      - uses: actions/download-artifact@v8
        with:
          name: dilla-core-harness
          path: packages/client-core/harness-dist
      - run: npx playwright install --with-deps webkit
      - run: npm run test:e2e:web:webkit -w @dilla/e2e
        env:
          DILLA_TESTKIT: \${{ github.workspace }}/artifacts/dilla-testkit
      - uses: actions/upload-artifact@v7
        if: failure()
        with:
          name: browser-web-results-webkit
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
      - uses: golangci/golangci-lint-action@ba0d7d2ec06a0ea1cb5fa41b2e4a3ab91d21278a # v9
        with:
          version: v2.14.0

  go-vuln:
    runs-on: ubuntu-latest
    steps:
      - run: go run golang.org/x/vuln/cmd/govulncheck@v1.8.0 ./...
      - run: go run golang.org/x/vuln/cmd/govulncheck@v1.8.0 -scan package -tags dillapins ./internal/deps

  go-sqlc:
    runs-on: ubuntu-latest
    steps:
      - uses: sqlc-dev/setup-sqlc@bac53b7fb28c039a6c7f5736fd1e89744021bdd6 # v5
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
    needs: [web-build]
    steps:
      - run: rm -rf internal/web/dist
      - name: Fetch the web client built by the web-build job
        uses: actions/download-artifact@v8
        with:
          name: dilla-web-dist
          path: internal/web/dist
      - run: |
          test -f internal/web/dist/index.html
          if grep -q 'content="placeholder"' internal/web/dist/index.html; then echo "internal/web/dist still holds the placeholder client"; exit 1; fi
      - name: the downloaded client passes the manifest check
        run: go test -tags webdist ./internal/web/...
        env:
          DILLA_WEB_DIST: \${{ github.workspace }}/internal/web/dist
      - run: CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -o dist/dillad-linux-amd64 ./cmd/dillad
      - uses: actions/upload-artifact@v7
        with:
          name: dillad-binaries
          path: dist/
          if-no-files-found: error

  image:
    runs-on: ubuntu-latest
    needs: [go, go-ds, go-lint, rust-wasi, web-build]
    permissions: { contents: read, packages: write }
    timeout-minutes: 30
    steps:
      - uses: actions/checkout@v7
      - uses: actions/download-artifact@v8
        with:
          name: dilla-core-wasi
          path: internal/mlswasi/testdata
      - run: rm -rf internal/web/dist
      - name: Fetch the web client into the image's build context
        uses: actions/download-artifact@v8
        with:
          name: dilla-web-dist
          path: internal/web/dist
      - name: The image embeds the real client, not the placeholder
        run: |
          test -f internal/web/dist/index.html
          if grep -q 'content="placeholder"' internal/web/dist/index.html; then echo "internal/web/dist still holds the placeholder client"; exit 1; fi
      - uses: docker/setup-buildx-action@f87e5991a6d7451dcb8d9637bfbc97413f497069 # v4.4.1
      - uses: docker/login-action@dbcb813823bdd20940b903addbd779551569679f # v4.6.0
      - uses: docker/metadata-action@dc802804100637a589fabce1cb79ff13a1411302 # v6.2.0
        id: meta
        with:
          images: ghcr.io/\${{ github.repository }}/dillad
          tags: |
            type=raw,value=latest,enable={{is_default_branch}}
            type=ref,event=branch
      - uses: docker/build-push-action@c3c9e263c25d99ce0380d002d59b67737d91b0dc # v7.4.0
        with:
          context: .
          platforms: linux/amd64,linux/arm64
          provenance: mode=max
          sbom: true
`;

// The four jobs that build for wasm32-unknown-unknown, as ci.yml writes them: the canonical clang 23 job env and,
// right after checkout, the canonical pinned install step (ruling of 2026-10-13; hardened after the d3429ce lead).
const WASM_JOBS = ['rust-wasm-node', 'browser-spike', 'browser-media', 'web-build'];

function withWasmClang(text) {
  const out = [];
  let job = null;
  for (const line of text.split('\n')) {
    const key = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line);
    if (key) job = key[1];
    if (WASM_JOBS.includes(job) && line === '    steps:') {
      out.push(WASM_CLANG_ENV_BLOCK, line, '      - uses: actions/checkout@v7', WASM_CLANG_STEP);
      continue;
    }
    out.push(line);
  }
  return out.join('\n');
}

const GOOD = withWasmClang(GOOD_BASE);

const BUDGET = MIN_BROWSER_WEB_TIMEOUT;

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
  // The CLI also checks release.yml.
  writeFileSync(join(dir, '.github', 'workflows', 'release.yml'), REAL_RELEASE);
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
  const problems = checkWorkflow(fixture(GOOD.replace('  go-harness:\n    runs-on: ubuntu-latest\n    timeout-minutes: 30\n', '  go-harness:\n    runs-on: ubuntu-latest\n')));
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
  const problems = checkWorkflow(fixture(GOOD.replace('needs: [go, go-ds, go-lint, rust-wasi, web-build]', 'needs: [go, go-lint, rust-wasi]')));
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
  ['go-lint', 'version: v2.14.0'],
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
  // The real ci.yml: the CLI also checks release.yml, whose actions must be ci.yml's at the same versions.
  const root = fixture(REAL_CI);
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
  'docker/setup-buildx-action@f87e5991a6d7451dcb8d9637bfbc97413f497069 # v4.4.1',
  'docker/login-action@dbcb813823bdd20940b903addbd779551569679f # v4.6.0',
  'docker/metadata-action@dc802804100637a589fabce1cb79ff13a1411302 # v6.2.0',
  'docker/build-push-action@c3c9e263c25d99ce0380d002d59b67737d91b0dc # v7.4.0',
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
    fixture(GOOD.replace('      - uses: docker/setup-buildx-action@f87e5991a6d7451dcb8d9637bfbc97413f497069 # v4.4.1\n', '      - uses: docker/setup-qemu-action@v4\n      - uses: docker/setup-buildx-action@f87e5991a6d7451dcb8d9637bfbc97413f497069 # v4.4.1\n')),
  );
  assert.ok(problems.some((p) => p.includes('setup-qemu-action')), problems.join('\n'));
});

// `go` is a prefix of `go-lint`: an image job that waits only for go-lint and rust-wasi must still be
// reported as not waiting for go.
test('an image job that does not wait for the go job is reported', () => {
  const problems = checkWorkflow(fixture(GOOD.replace('needs: [go, go-ds, go-lint, rust-wasi, web-build]', 'needs: [go-ds, go-lint, rust-wasi]')));
  assert.ok(problems.some((p) => p.includes('"image"') && p.includes('"go"')), problems.join('\n'));
});

test('an image job that does not wait for go-lint is reported', () => {
  const problems = checkWorkflow(fixture(GOOD.replace('needs: [go, go-ds, go-lint, rust-wasi, web-build]', 'needs: [go, go-ds, rust-wasi]')));
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

// Task 26 (web-1): the web client's build, its browser suites, and its hand-off to release and image.

/** One job of GOOD, from its key line to the line before the next job key. */
function jobBody(job) {
  const lines = GOOD.split('\n');
  const from = lines.indexOf(`  ${job}:`);
  assert.ok(from !== -1, `fixture sanity: job ${job}`);
  let to = from + 1;
  while (to < lines.length && !/^ {2}[A-Za-z0-9_-]+:\s*$/.test(lines[to])) to++;
  return lines.slice(from, to).join('\n');
}

const PLACEHOLDER_GUARD_IMAGE =
  '      - name: The image embeds the real client, not the placeholder\n' +
  '        run: |\n' +
  '          test -f internal/web/dist/index.html\n' +
  `          if grep -q 'content="placeholder"' internal/web/dist/index.html; then echo "internal/web/dist still holds the placeholder client"; exit 1; fi\n`;

for (const job of ['web-build', ...Object.keys(BROWSER_WEB_JOBS)]) {
  test(`a workflow without the ${job} job is reported`, () => {
    const problems = checkWorkflow(fixture(GOOD.replace(jobBody(job), '')));
    assert.ok(problems.some((p) => p.includes(`missing job "${job}"`)), problems.join('\n'));
  });
}

for (const [job, needle] of [
  ['web-build', 'timeout-minutes: 15'],
  ['web-build', 'wasm-pack build core/dilla-core-wasm --target web --profile wasm-release --mode no-install --out-dir ../../packages/core-wasm/pkg'],
  ['web-build', 'node scripts/check-wasm-size.mjs packages/core-wasm/pkg/dilla_core_wasm_bg.wasm'],
  ['web-build', 'npm run typecheck -w @dilla/client-core'],
  ['web-build', 'npm run typecheck -w @dilla/web'],
  ['web-build', 'npm run build -w @dilla/web'],
  ['web-build', 'npm run build:harness -w @dilla/client-core'],
  ['web-build', 'go test -tags webdist ./internal/web/...'],
  ['web-build', 'name: dilla-web-dist'],
  ['web-build', 'path: packages/web/dist/'],
  ['web-build', 'name: dilla-core-harness'],
  ['web-build', 'path: packages/client-core/harness-dist/'],
  ...Object.entries(BROWSER_WEB_JOBS).flatMap(([job, { engine, core, voice, timeout }]) => [
    [job, `timeout-minutes: ${timeout}`],
    ...(voice ? [[job, `npm run test:e2e:voice:${engine} -w @dilla/e2e`]] : []),
    ...(voice && engine === 'firefox' ? [[job, 'sh scripts/ci-audio-server.sh']] : []),
    [job, 'name: dilla-core-wasi'],
    [job, 'path: internal/mlswasi/testdata'],
    [job, 'name: dilla-testkit'],
    [job, 'name: dilla-web-dist'],
    [job, 'path: packages/web/dist'],
    [job, 'name: dilla-core-harness'],
    [job, 'path: packages/client-core/harness-dist'],
    [job, `npx playwright install --with-deps ${engine}`],
    ...(core ? [[job, `npm run test:e2e:core:${engine} -w @dilla/e2e`]] : []),
    [job, `npm run test:e2e:web:${engine} -w @dilla/e2e`],
    [job, 'DILLA_TESTKIT: ${{ github.workspace }}/artifacts/dilla-testkit'],
    [job, 'if: failure()'],
    [job, `name: browser-web-results-${engine}`],
    [job, 'path: e2e/test-results'],
  ]),
  ['go-release', 'name: dilla-web-dist'],
  ['go-release', 'path: internal/web/dist'],
  ['go-release', 'content="placeholder"'],
  ['go-release', 'go test -tags webdist ./internal/web/...'],
  ['image', 'name: dilla-web-dist'],
  ['image', 'path: internal/web/dist'],
  ['image', 'content="placeholder"'],
  ['node', 'npm run test:manifest-writer'],
  ['node', 'npm run test:install'],
  ['rust-wasm-node', 'npm run typecheck -w @dilla/core-wasm'],
  ['rust-wasm-node', 'cargo clippy -p dilla-core-wasm --target wasm32-unknown-unknown --lib --locked -- -D warnings'],
  ['rust-wasm-node', 'components: clippy'],
]) {
  test(`a ${job} job that lost "${needle}" is reported (web-1)`, () => {
    const body = jobBody(job);
    assert.ok(body.includes(needle), 'fixture sanity: ' + needle);
    const gutted = body.split('\n').filter((l) => !l.includes(needle)).join('\n');
    const problems = checkWorkflow(fixture(GOOD.replace(body, () => gutted)));
    assert.ok(problems.some((p) => p.includes(`"${job}"`) && p.includes(needle)), problems.join('\n'));
  });
}

for (const job of Object.keys(BROWSER_WEB_JOBS)) {
  for (const need of ['rust-native', 'rust-wasi', 'web-build']) {
    test(`a ${job} job without needs: ${need} is reported`, () => {
      const body = jobBody(job);
      const kept = ['rust-native', 'rust-wasi', 'web-build'].filter((n) => n !== need).join(', ');
      const cut = body.replace('    needs: [rust-native, rust-wasi, web-build]\n', `    needs: [${kept}]\n`);
      assert.notEqual(cut, body, 'fixture sanity: needs');
      const problems = checkWorkflow(fixture(GOOD.replace(body, () => cut)));
      assert.ok(problems.some((p) => p.includes(`"${job}"`) && p.includes(`needs: ${need}`)), problems.join('\n'));
    });
  }
}

// Ruling of 2026-10-13: browser-web is one job per engine. Dropping an engine's job, folding the engines back into
// one job, or two engines uploading one artifact name (upload-artifact v4+ refuses a duplicate) is reported.
test('a workflow missing one engine job is reported, also when another job runs that engine', () => {
  const firefox = jobBody('firefox-web');
  const problems = checkWorkflow(fixture(GOOD.replace(firefox, '')));
  assert.ok(problems.some((p) => p.includes('missing job "firefox-web"')), problems.join('\n'));
  const merged = jobBody('chromium-web')
    .replace('npx playwright install --with-deps chromium', 'npx playwright install --with-deps chromium firefox')
    .replace('npm run test:e2e:web:chromium -w @dilla/e2e', 'npm run test:e2e:web -w @dilla/e2e');
  const folded = checkWorkflow(fixture(GOOD.replace(firefox, '').replace(jobBody('chromium-web'), () => merged)));
  assert.ok(folded.some((p) => p.includes('missing job "firefox-web"')), folded.join('\n'));
  assert.ok(folded.some((p) => p.includes('"chromium-web"') && p.includes('test:e2e:web:chromium')), folded.join('\n'));
});

// Web-3 task 10: Firefox's voice suite runs after the audio server, as browser-media's does.
test('firefox-web must start an audio server before the voice suite', () => {
  const body = jobBody('firefox-web');
  const audio = '      - run: sh scripts/ci-audio-server.sh\n';
  const voice = '      - run: npm run test:e2e:voice:firefox -w @dilla/e2e\n';
  assert.ok(body.includes(audio) && body.includes(voice), 'fixture sanity: the audio server and the voice suite');
  const late = body.replace(audio, '').replace(voice, voice + audio);
  const problems = checkWorkflow(fixture(GOOD.replace(body, () => late)));
  assert.ok(problems.some((p) => p.includes('firefox-web') && p.includes('audio server') && p.includes('before')), problems.join('\n'));
});

// Web-3 task 10 (review M10): the voice rules match steps, so a comment never satisfies them, and the voice step's own
// env is required.
for (const engine of ['chromium', 'firefox']) {
  const job = `${engine}-web`;
  const voice = `      - run: npm run test:e2e:voice:${engine} -w @dilla/e2e\n`;
  test(`a ${job} voice step that is only a comment is reported`, () => {
    const body = jobBody(job);
    assert.ok(body.includes(voice), 'fixture sanity: the voice step');
    const commented = body.replace(voice, `      # - run: npm run test:e2e:voice:${engine} -w @dilla/e2e\n`);
    const problems = checkWorkflow(fixture(GOOD.replace(body, () => commented)));
    assert.ok(problems.some((p) => p.includes(`"${job}" is missing: npm run test:e2e:voice:${engine}`)), problems.join('\n'));
  });
  test(`a ${job} voice step without its own DILLA_TESTKIT env is reported, though the web step has one`, () => {
    const body = jobBody(job);
    const env = '        env:\n          DILLA_TESTKIT: ${{ github.workspace }}/artifacts/dilla-testkit\n';
    assert.ok(body.includes(voice + env), 'fixture sanity: the voice step and its env');
    const bare = body.replace(voice + env, voice);
    const problems = checkWorkflow(fixture(GOOD.replace(body, () => bare)));
    assert.ok(problems.some((p) => p.includes(`"${job}"`) && p.includes('without its own env')), problems.join('\n'));
  });
}

test('a comment naming the audio server above the voice step does not stand in for the real step after it', () => {
  const body = jobBody('firefox-web');
  const audio = '      - run: sh scripts/ci-audio-server.sh\n';
  const voice = '      - run: npm run test:e2e:voice:firefox -w @dilla/e2e\n';
  const env = '        env:\n          DILLA_TESTKIT: ${{ github.workspace }}/artifacts/dilla-testkit\n';
  assert.ok(body.includes(audio + voice + env), 'fixture sanity: the audio server, then the voice suite');
  const sneaky = body.replace(audio + voice + env, `      # sh scripts/ci-audio-server.sh\n${voice}${env}${audio}`);
  const problems = checkWorkflow(fixture(GOOD.replace(body, () => sneaky)));
  assert.ok(problems.some((p) => p.includes('firefox-web') && p.includes('audio server') && p.includes('before')), problems.join('\n'));
  const commentOnly = body.replace(audio, '      # - run: sh scripts/ci-audio-server.sh\n');
  const missing = checkWorkflow(fixture(GOOD.replace(body, () => commentOnly)));
  assert.ok(missing.some((p) => p.includes('"firefox-web"') && p.includes('ci-audio-server.sh')), missing.join('\n'));
});

test('jobSteps drops comment lines and keeps each step\'s own lines', () => {
  const steps = jobSteps('    steps:\n      # - run: a\n      - run: b\n        env:\n          X: 1\n      # c\n      - uses: d\n');
  assert.deepEqual(steps, [['run: b', 'env:', 'X: 1'], ['uses: d']]);
});

test('the voice budgets are derived from the measured voice minutes and stay under one runner\'s 45 minutes', () => {
  for (const job of ['chromium-web', 'firefox-web']) {
    const { timeout } = BROWSER_WEB_JOBS[job];
    assert.ok(timeout >= MIN_BROWSER_WEB_TIMEOUT && timeout <= 45, `${job}: ${timeout}`);
  }
  assert.equal(BROWSER_WEB_JOBS['webkit-web'].voice, false);
});

test('two engine jobs uploading one artifact name are reported', () => {
  const body = jobBody('firefox-web');
  const shared = body.replace('name: browser-web-results-firefox', 'name: browser-web-results-chromium');
  const problems = checkWorkflow(fixture(GOOD.replace(body, () => shared)));
  assert.ok(problems.some((p) => p.includes('"firefox-web"') && p.includes('browser-web-results-firefox')), problems.join('\n'));
});

test('go-release must point the webdist test at the downloaded client', () => {
  const line = '          DILLA_WEB_DIST: ${{ github.workspace }}/internal/web/dist\n';
  const body = jobBody('go-release');
  assert.ok(body.includes(line), 'fixture sanity: the DILLA_WEB_DIST line');
  const problems = checkWorkflow(fixture(GOOD.replace(body, () => body.replace(line, ''))));
  assert.ok(
    problems.some((p) => p.includes('"go-release"') && p.includes('DILLA_WEB_DIST: ${{ github.workspace }}/internal/web/dist')),
    problems.join('\n'),
  );
});

test('a go-release job without needs: web-build is reported', () => {
  const body = jobBody('go-release');
  const problems = checkWorkflow(fixture(GOOD.replace(body, () => body.replace('    needs: [web-build]\n', ''))));
  assert.ok(problems.some((p) => p.includes('"go-release"') && p.includes('needs: web-build')), problems.join('\n'));
});

test('an image job that does not wait for web-build is reported', () => {
  const problems = checkWorkflow(fixture(GOOD.replace('needs: [go, go-ds, go-lint, rust-wasi, web-build]', 'needs: [go, go-ds, go-lint, rust-wasi]')));
  assert.ok(problems.some((p) => p.includes('"image"') && p.includes('"web-build"')), problems.join('\n'));
});

// The plan's named mutation for this task: the whole download step, not one line of it.
test('an image job without the dilla-web-dist download step is reported by name', () => {
  const step =
    '      - name: Fetch the web client into the image\'s build context\n' +
    '        uses: actions/download-artifact@v8\n' +
    '        with:\n' +
    '          name: dilla-web-dist\n' +
    '          path: internal/web/dist\n';
  const body = jobBody('image');
  assert.ok(body.includes(step), 'fixture sanity: the image download step');
  const problems = checkWorkflow(fixture(GOOD.replace(body, () => body.replace(step, ''))));
  assert.ok(problems.some((p) => p.includes('"image"') && p.includes('name: dilla-web-dist')), problems.join('\n'));
});

test('a go-release job that builds before it fetches the web client is reported', () => {
  const build = '      - run: CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -o dist/dillad-linux-amd64 ./cmd/dillad\n';
  const body = jobBody('go-release');
  assert.ok(body.includes(build), 'fixture sanity: the amd64 build');
  const moved = body.replace(build, '').replace('    steps:\n', `    steps:\n${build}`);
  const problems = checkWorkflow(fixture(GOOD.replace(body, () => moved)));
  assert.ok(problems.some((p) => p.includes('"go-release"') && p.includes('before it builds')), problems.join('\n'));
});

test('an image job that checks for the placeholder only after the build is reported', () => {
  assert.ok(GOOD.includes(PLACEHOLDER_GUARD_IMAGE), 'fixture sanity: the image guard');
  // image is the last job of GOOD, so appending puts the guard after docker/build-push-action.
  const problems = checkWorkflow(fixture(GOOD.replace(PLACEHOLDER_GUARD_IMAGE, '') + PLACEHOLDER_GUARD_IMAGE));
  assert.ok(problems.some((p) => p.includes('"image"') && p.includes('before it builds')), problems.join('\n'));
});

// web-2b task 11 (L-CI-20, L-CI-21): the screenshots of the web-2b stories and the re-derived browser budget.
const UI_SHOTS_2B = 'node packages/ui/scripts/shoot-stories.mjs 6016 target/ui-screens/web-2b form- ceremony- shell- conversation- settings- screens- primitives-channelrow-- conversation-messagetoolbar-- conversation-attachmentcard-- screens-conversation--';

for (const needle of [UI_SHOTS_2B, 'name: ui-screens', 'path: target/ui-screens/web-2b']) {
  test(`a ui job that lost "${needle}" is reported (web-2b)`, () => {
    const body = jobBody('ui');
    assert.ok(body.includes(needle), 'fixture sanity: ' + needle);
    const gutted = body.split('\n').filter((l) => !l.includes(needle)).join('\n');
    const problems = checkWorkflow(fixture(GOOD.replace(body, () => gutted)));
    assert.ok(problems.some((p) => p.includes('"ui"') && p.includes(needle)), problems.join('\n'));
  });
}

for (const prefix of ['form-', 'ceremony-', 'shell-', 'conversation-', 'settings-', 'screens-', 'primitives-channelrow--', 'conversation-messagetoolbar--', 'conversation-attachmentcard--', 'screens-conversation--']) {
  test(`a ui screenshot step that dropped the ${prefix} prefix is reported (web-2b)`, () => {
    const body = jobBody('ui');
    const narrowed = body.replace(` ${prefix}`, '');
    assert.notEqual(narrowed, body, `fixture sanity: the ${prefix} prefix`);
    const problems = checkWorkflow(fixture(GOOD.replace(body, () => narrowed)));
    assert.ok(problems.some((p) => p.includes('"ui"') && p.includes(UI_SHOTS_2B)), problems.join('\n'));
  });
}

test('a ui job still capturing into an earlier directory is reported (web-2b)', () => {
  for (const earlier of ['web-1', 'web-2a']) {
    const body = jobBody('ui');
    const old = body.replaceAll('target/ui-screens/web-2b', `target/ui-screens/${earlier}`);
    assert.notEqual(old, body, 'fixture sanity: the web-2b directory');
    const problems = checkWorkflow(fixture(GOOD.replace(body, () => old)));
    assert.ok(
      problems.some((p) => p.includes('"ui"') && p.includes('path: target/ui-screens/web-2b')),
      `${earlier}: ${problems.join('\n')}`,
    );
  }
});

test('neither the checker nor the fixture names an earlier screenshot directory (web-2b)', () => {
  const checker = readFileSync(SCRIPT_PATH, 'utf8');
  for (const earlier of ['target/ui-screens/web-1', 'target/ui-screens/web-2a']) {
    assert.ok(!checker.includes(earlier), `check-ci-workflow.mjs still names ${earlier}`);
    assert.ok(!GOOD.includes(earlier), `GOOD still names ${earlier}`);
  }
});

for (const [job, { timeout }] of Object.entries(BROWSER_WEB_JOBS)) {
  test(`a ${job} job off its derived budget is reported (web-2c)`, () => {
    const body = jobBody(job);
    const off = body.replace(`    timeout-minutes: ${timeout}\n`, `    timeout-minutes: ${timeout - 5}\n`);
    assert.notEqual(off, body, 'fixture sanity: the derived budget');
    const problems = checkWorkflow(fixture(GOOD.replace(body, () => off)));
    assert.ok(problems.some((p) => p.includes(`"${job}"`) && p.includes(`timeout-minutes: ${timeout}`)), problems.join('\n'));
  });
}

// web-2c task 11 (L-CI-22): the seven new story families at both viewports, both upload paths and the budget.
test('web-2c captures, both paths and timeout are required independently', () => {
  const desktop = 'node packages/ui/scripts/shoot-stories.mjs 6027 target/ui-screens/web-2c/desktop trust-safetycompare-- trust-trustalert-- search-searchpalette-- status-typingindicator-- settings-diagnosticspanel-- shell-tabhand-over-- screens-trustandpolish--';
  const phone = 'node packages/ui/scripts/shoot-stories.mjs 6027 target/ui-screens/web-2c/phone trust-safetycompare-- trust-trustalert-- search-searchpalette-- status-typingindicator-- settings-diagnosticspanel-- shell-tabhand-over-- screens-trustandpolish-- --viewport=360x740';
  const required = [
    ['desktop step', GOOD.replace(`      - run: ${desktop}\n`, '')],
    ['phone step', GOOD.replace(`      - run: ${phone}\n`, '')],
    ['desktop path', GOOD.replace('target/ui-screens/web-2c/desktop/**', 'target/ui-screens/web-2b/desktop/**')],
    ['phone path', GOOD.replace('target/ui-screens/web-2c/phone/**', 'target/ui-screens/web-2b/phone/**')],
    ['timeout', GOOD.replace(`timeout-minutes: ${BUDGET}`, `timeout-minutes: ${BUDGET - 1}`)],
  ];
  for (const [name, workflow] of required) {
    const problems = checkWorkflow(fixture(workflow));
    assert.ok(problems.length > 0, `${name}: checker accepted a missing gate`);
    assert.match(problems.join('\n'), /web-2c|screenshot|browser-web|timeout/i, name);
  }
});

// web-3 task 11: the voice, ring and media-player families at both viewports, uploaded from target/ui-screens/web-3.
test('web-3 captures and the web-3 upload path are required independently', () => {
  const desktop = 'node packages/ui/scripts/shoot-stories.mjs 6038 target/ui-screens/web-3/desktop voice- media-mediaplayer-- screens-voice--';
  const phone = 'node packages/ui/scripts/shoot-stories.mjs 6038 target/ui-screens/web-3/phone voice- media-mediaplayer-- screens-voice-- --viewport=360x740';
  assert.deepEqual(checkWorkflow(fixture(GOOD)), [], 'fixture sanity: GOOD passes');
  const required = [
    ['desktop step', GOOD.replace(`      - run: ${desktop}\n`, ''), desktop],
    ['phone step', GOOD.replace(`      - run: ${phone}\n`, ''), phone],
    ['narrowed prefixes', GOOD.replace(` voice- media-mediaplayer-- screens-voice--\n`, ' voice-\n'), desktop],
    ['upload path', GOOD.replace('path: target/ui-screens/web-3/**', 'path: target/ui-screens/web-2c/**'), 'path: target/ui-screens/web-3/**'],
    ['artifact name', GOOD.replace('name: ui-screens-web-3\n', 'name: ui-screens-web-2d\n'), 'name: ui-screens-web-3'],
  ];
  for (const [name, workflow, needle] of required) {
    assert.notEqual(workflow, GOOD, `fixture sanity: ${name}`);
    const problems = checkWorkflow(fixture(workflow));
    assert.ok(problems.some((p) => p.includes('"ui"') && p.includes(needle)), `${name}: ${problems.join('\n')}`);
  }
});

// Ruling of 2026-10-13 (web-2c D5 in CI), hardened after the d3429ce scanner lead: every wasm32-unknown-unknown
// build compiles SQLite with one exact clang 23 build, and the checker compares whole blocks, not substrings.
/** GOOD with one job's body passed through `edit`. */
function editJob(job, edit) {
  const body = jobBody(job);
  const edited = edit(body);
  assert.notEqual(edited, body, `fixture sanity: the edit of ${job} changed nothing`);
  return GOOD.replace(body, edited);
}

const STEP_RULE = (job) =>
  `ci.yml: job "${job}" builds for wasm32-unknown-unknown; its second step, right after actions/checkout@v7, must be exactly the pinned clang 23 step (WASM_CLANG_STEP)`;
const ENV_RULE = (job) =>
  `ci.yml: job "${job}" builds for wasm32-unknown-unknown; its job-level env must be exactly:\n${WASM_CLANG_ENV_BLOCK}`;

const LLVM_PACKAGES = ['clang-23', 'llvm-23', 'libllvm23', 'libclang-cpp23', 'libclang1-23', 'libclang-common-23-dev', 'llvm-23-linker-tools', 'llvm-23-runtime'];

test('the canonical step pins every llvm-toolchain-23 package at one version and reads each back', () => {
  assert.ok(WASM_CLANG_STEP.includes(`          v='${WASM_LLVM_VERSION}'`));
  assert.match(WASM_LLVM_VERSION, /^1:23\.\d+\.\d+~/);
  const install = WASM_CLANG_STEP.split('\n').find((l) => l.includes('apt-get install'));
  for (const p of LLVM_PACKAGES) {
    assert.ok(install.includes(` "${p}=$v"`), `${p} is not installed at the pinned version`);
  }
  assert.ok(!/\s(clang-23|llvm-23)(\s|$)/.test(install), 'an unpinned package name in the install line');
  assert.ok(WASM_CLANG_STEP.includes(`          for p in ${LLVM_PACKAGES.join(' ')}; do test "$(dpkg-query -W -f='\${Version}' "$p")" = "$v"; done`));
  assert.ok(WASM_CLANG_STEP.includes('          apt-cache policy clang-23 llvm-23'));
});

test('the canonical step checks the fingerprint on the keyring apt is pointed at', () => {
  const lines = WASM_CLANG_STEP.split('\n').map((l) => l.trim());
  const dearmor = lines.indexOf('gpg --dearmor -o "$RUNNER_TEMP/apt-llvm.gpg" "$RUNNER_TEMP/llvm-snapshot.asc"');
  const check = lines.indexOf(`test "$primaries" = ${WASM_LLVM_KEY_FPR}`);
  const install = lines.indexOf('sudo install -m 0644 "$RUNNER_TEMP/apt-llvm.gpg" /usr/share/keyrings/apt-llvm.gpg');
  const same = lines.indexOf('cmp "$RUNNER_TEMP/apt-llvm.gpg" /usr/share/keyrings/apt-llvm.gpg');
  const source = lines.findIndex((l) => l.includes('[signed-by=/usr/share/keyrings/apt-llvm.gpg]'));
  assert.ok(dearmor !== -1 && dearmor < check && check < install && install < same && same < source, lines.join('\n'));
  assert.ok(lines[check - 1].startsWith('primaries=$(gpg --show-keys --with-colons "$RUNNER_TEMP/apt-llvm.gpg"'));
  assert.ok(WASM_CLANG_ENV_BLOCK.includes('CC_wasm32_unknown_unknown: /usr/bin/clang-23'));
  assert.ok(WASM_CLANG_ENV_BLOCK.includes('AR_wasm32_unknown_unknown: /usr/bin/llvm-ar-23'));
});

for (const job of WASM_JOBS) {
  test(`a ${job} job without the clang 23 job env is reported`, () => {
    const problems = checkWorkflow(fixture(editJob(job, (b) => b.replace(`${WASM_CLANG_ENV_BLOCK}\n`, ''))));
    assert.ok(problems.includes(ENV_RULE(job)), problems.join('\n'));
  });
  test(`a ${job} job whose CC is a bare clang-23 that PATH resolves is reported`, () => {
    const problems = checkWorkflow(fixture(editJob(job, (b) => b.replace(': /usr/bin/clang-23', ': clang-23'))));
    assert.ok(problems.includes(ENV_RULE(job)), problems.join('\n'));
  });
  test(`a ${job} job env with an extra compiler flag is reported`, () => {
    const problems = checkWorkflow(fixture(editJob(job, (b) => b.replace(WASM_CLANG_ENV_BLOCK, `${WASM_CLANG_ENV_BLOCK}\n      CFLAGS_wasm32_unknown_unknown: -O0`))));
    assert.ok(problems.includes(ENV_RULE(job)), problems.join('\n'));
  });
  test(`a ${job} job installing an unpinned clang is reported`, () => {
    const problems = checkWorkflow(fixture(editJob(job, (b) => b.replace(' "clang-23=$v"', ' clang-23'))));
    assert.ok(problems.includes(STEP_RULE(job)), problems.join('\n'));
  });
  test(`a ${job} job pinned to another build is reported`, () => {
    const problems = checkWorkflow(fixture(editJob(job, (b) => b.replace(WASM_LLVM_VERSION, WASM_LLVM_VERSION.replace('23.1.4', '23.1.3')))));
    assert.ok(problems.includes(STEP_RULE(job)), problems.join('\n'));
  });
  test(`a ${job} job checking another key fingerprint is reported`, () => {
    const problems = checkWorkflow(fixture(editJob(job, (b) => b.replace(WASM_LLVM_KEY_FPR, '0'.repeat(40)))));
    assert.ok(problems.includes(STEP_RULE(job)), problems.join('\n'));
  });
  test(`a ${job} job that skips the clang 23 step with an if: is reported`, () => {
    const problems = checkWorkflow(fixture(editJob(job, (b) => b.replace('      - name: clang 23 for the wasm C build\n', '      - name: clang 23 for the wasm C build\n        if: false\n'))));
    assert.ok(problems.includes(STEP_RULE(job)), problems.join('\n'));
  });
  test(`a ${job} job that installs clang 23 after other steps is reported`, () => {
    const moved = editJob(job, (b) => {
      const without = b.replace(`${WASM_CLANG_STEP}\n`, '');
      return `${without.replace(/\n*$/, '')}\n${WASM_CLANG_STEP}\n`;
    });
    const problems = checkWorkflow(fixture(moved));
    assert.ok(problems.includes(STEP_RULE(job)), problems.join('\n'));
  });
}

// The validator differential of the d3429ce lead: the earlier rule matched substrings, so this job passed it while
// running no install at all, with the required strings in a comment and in an echo.
test('an evading job that only names the pinned strings in a comment and an echo is reported', () => {
  const evading = editJob('web-build', (b) =>
    b.replace(
      `${WASM_CLANG_STEP}\n`,
      `      # ${WASM_CLANG_STEP.split('\n').map((l) => l.trim()).join(' ; ')}\n` +
        `      - run: echo '${WASM_CLANG_STEP.split('\n').filter((l) => l.includes('apt-get install')).join('').trim()}'\n`,
    ),
  );
  const problems = checkWorkflow(fixture(evading));
  assert.ok(problems.includes(STEP_RULE('web-build')), problems.join('\n'));
});

for (const [what, edit, expected] of [
  [
    'the hyphenated target variable on a step, which cc reads before the underscored one',
    (b) => b.replace('      - run: wasm-pack build', '      - env:\n          CC_wasm32-unknown-unknown: /usr/bin/gcc\n        run: wasm-pack build'),
    /names a C toolchain variable outside the canonical clang 23 job env/,
  ],
  [
    'a TARGET_CC in a flow-style step env',
    (b) => b.replace('      - run: wasm-pack build', '      - env: { TARGET_CC: gcc }\n        run: wasm-pack build'),
    /names a C toolchain variable outside the canonical clang 23 job env/,
  ],
  [
    'a quoted CC key on a step',
    (b) => b.replace('      - run: wasm-pack build', '      - env:\n          "CC": gcc\n        run: wasm-pack build'),
    /names a C toolchain variable outside the canonical clang 23 job env/,
  ],
  [
    'a step that exports the compiler through GITHUB_ENV',
    (b) => b.replace('      - run: wasm-pack build', '      - run: echo "CC_wasm32_unknown_unknown=/usr/bin/gcc" >> "$GITHUB_ENV"\n      - run: wasm-pack build'),
    /writes GITHUB_ENV or GITHUB_PATH/,
  ],
  [
    'a step that puts another clang first on PATH',
    (b) => b.replace('      - run: wasm-pack build', '      - run: echo "$RUNNER_TEMP/fake" >> "$GITHUB_PATH"\n      - run: wasm-pack build'),
    /writes GITHUB_ENV or GITHUB_PATH/,
  ],
]) {
  test(`web-build with ${what} is reported`, () => {
    const problems = checkWorkflow(fixture(editJob('web-build', edit)));
    assert.ok(problems.some((p) => expected.test(p)), problems.join('\n'));
  });
}

test('a compiler variable in the workflow-level env is reported', () => {
  const problems = checkWorkflow(fixture(GOOD.replace('env:\n  CARGO_TERM_COLOR: always\n', 'env:\n  CARGO_TERM_COLOR: always\n  CC: gcc\n')));
  assert.ok(problems.some((p) => /names a C toolchain variable outside the canonical clang 23 job env/.test(p)), problems.join('\n'));
});

test('a YAML anchor and alias that would reuse an env block is reported', () => {
  const anchored = GOOD.replace('env:\n  CARGO_TERM_COLOR: always\n', 'env: &shared\n  CARGO_TERM_COLOR: always\n').replace(
    '  deny:\n    runs-on: ubuntu-latest\n',
    '  deny:\n    runs-on: ubuntu-latest\n    env: *shared\n',
  );
  const problems = checkWorkflow(fixture(anchored));
  assert.ok(problems.some((p) => p.includes('YAML anchors, aliases and merge keys are not allowed')), problems.join('\n'));
});

test('a wasm job added tomorrow without the pinned clang 23 is reported', () => {
  const extra =
    '  wasm-extra:\n' +
    '    runs-on: ubuntu-latest\n' +
    '    steps:\n' +
    '      - uses: actions/checkout@v7\n' +
    '      - run: cargo build -p dilla-core --target wasm32-unknown-unknown --locked\n';
  const problems = checkWorkflow(fixture(GOOD.replace('  deny:\n', `${extra}  deny:\n`)));
  assert.ok(problems.includes(ENV_RULE('wasm-extra')), problems.join('\n'));
  assert.ok(problems.includes(STEP_RULE('wasm-extra')), problems.join('\n'));
});

test('jobs that build no wasm need no clang 23', () => {
  assert.deepEqual(checkWorkflow(fixture(GOOD)), []);
});

// install-release (2026-10-14): the release workflow, checked against the real ci.yml it must match.
function releaseFixture(release) {
  const dir = mkdtempSync(join(tmpdir(), 'dilla-release-'));
  mkdirSync(join(dir, '.github', 'workflows'), { recursive: true });
  writeFileSync(join(dir, '.github', 'workflows', 'ci.yml'), REAL_CI);
  writeFileSync(join(dir, '.github', 'workflows', 'release.yml'), release);
  return dir;
}

function releaseProblems(edit) {
  const edited = edit(REAL_RELEASE);
  assert.notEqual(edited, REAL_RELEASE, 'the edit changed nothing; the fixture drifted from release.yml');
  return checkReleaseWorkflow(releaseFixture(edited));
}

function assertReported(problems, needle) {
  assert.ok(problems.some((p) => p.includes(needle)), `want a problem naming ${needle}:\n${problems.join('\n')}`);
}

test('the real release workflow passes every rule', () => {
  assert.deepEqual(checkReleaseWorkflow(REPO_ROOT), []);
});

test('a release workflow without the release job is reported', () => {
  assertReported(releaseProblems((t) => t.replace(/\n {2}release:\n[\s\S]*$/, '\n')), 'missing job "release"');
});

test('a release that no longer attaches install.sh is reported', () => {
  assertReported(releaseProblems((t) => t.replace('release/install.sh release/SHA256SUMS', 'release/SHA256SUMS')), 'release/install.sh');
});

test('SHA256SUMS that leaves an asset out is reported', () => {
  assertReported(
    releaseProblems((t) => t.replace('sha256sum dillad-linux-amd64 dillad-linux-arm64 dilla_core_wasi.wasm install.sh > SHA256SUMS', 'sha256sum dillad-linux-amd64 dillad-linux-arm64 > SHA256SUMS')),
    '> SHA256SUMS',
  );
});

test('a release job without contents: write is reported', () => {
  assertReported(releaseProblems((t) => t.replace('    permissions:\n      contents: write\n', '')), 'contents: write');
});

test('contents: write on a build job is reported', () => {
  assertReported(releaseProblems((t) => t.replace('  rust-wasi:\n    runs-on: ubuntu-latest\n', '  rust-wasi:\n    runs-on: ubuntu-latest\n    permissions:\n      contents: write\n')), 'only the release job writes');
});

test('a container image in the release workflow is reported', () => {
  assertReported(releaseProblems((t) => `${t}\n  image:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: docker/setup-buildx-action@f87e5991a6d7451dcb8d9637bfbc97413f497069 # v4.4.1\n`), 'container image');
});

test('a dispatch input expanded inside a script is reported', () => {
  assertReported(releaseProblems((t) => t.replace('tag="${INPUT_TAG:-$GITHUB_REF_NAME}"', 'tag="${{ inputs.tag }}"')), 'outside an env: key');
});

test('an action at a version ci.yml does not use is reported', () => {
  assertReported(releaseProblems((t) => t.replace('  rust-wasi:\n    runs-on: ubuntu-latest\n    needs: [tag]\n    steps:\n      - uses: actions/checkout@v7', '  rust-wasi:\n    runs-on: ubuntu-latest\n    needs: [tag]\n    steps:\n      - uses: actions/checkout@main')), 'actions/checkout@main');
});

test('a tag job that no longer checks the ref is reported', () => {
  assertReported(releaseProblems((t) => t.replace(/ {10}test "\$GITHUB_REF" = .*\n/, '')), 'refs/tags/$tag');
});

test('a release web-build without the clang 23 pin is reported', () => {
  assertReported(releaseProblems((t) => t.replace('      - name: clang 23 for the wasm C build\n', '      - name: clang for the wasm C build\n')), 'clang 23');
});

test('a release go-release that builds before the placeholder guard is reported', () => {
  assertReported(releaseProblems((t) => t.replace(/ {6}- name: The binaries embed the real client[^\n]*\n {8}run: \|\n(?: {10}[^\n]*\n)+/, '')), 'refuse the placeholder');
});

test('a release go-release that does not wait for web-build is reported', () => {
  assertReported(releaseProblems((t) => t.replace('needs: [tag, web-build]', 'needs: [tag]')), '"web-build" in its needs');
});

test('|| true in the release workflow is reported', () => {
  assertReported(releaseProblems((t) => t.replace('sha256sum -c --strict SHA256SUMS', 'sha256sum -c --strict SHA256SUMS || true')), '|| true');
});

test('a release workflow that no longer runs on v* tags is reported', () => {
  assertReported(releaseProblems((t) => t.replace("tags: ['v*']", "tags: ['*']")), "tags 'v*'");
});

test('a third-party action pinned by tag in the release workflow is reported', () => {
  const problems = releaseProblems((t) => t.replace(/taiki-e\/install-action@[0-9a-f]{40} # v2/, 'taiki-e/install-action@' + 'v2'));
  assertReported(problems, 'taiki-e/install-action@' + 'v2 is a third-party action not pinned');
});

test('a third-party action pinned by SHA but without its tag comment is reported', () => {
  const problems = releaseProblems((t) => t.replace(/(dtolnay\/rust-toolchain@[0-9a-f]{40}) # 1\.98\.1/, '$1'));
  assertReported(problems, 'not pinned to a 40-hex commit SHA');
});

test('every third-party action in release.yml is pinned to a commit', () => {
  const thirdParty = REAL_RELEASE.split('\n').filter((l) => /uses:/.test(l) && !/uses:\s*actions\//.test(l));
  assert.ok(thirdParty.length > 0);
  for (const line of thirdParty) assert.match(line, /@[0-9a-f]{40} # \S+$/, line);
});

test('a release that attaches an unstamped install.sh is reported', () => {
  assertReported(releaseProblems((t) => t.replace(/ {10}sed -i "s\/\^DILLA_RELEASE_TAG=.*\n/, '')), 'DILLA_RELEASE_TAG');
});

test('a release that does not check the stamp landed is reported', () => {
  assertReported(releaseProblems((t) => t.replace(/ {10}test "\$\(grep -c "\^DILLA_RELEASE_TAG=.*\n/, '')), 'grep -c');
});

test('a release that does not refuse an existing release by name is reported', () => {
  assertReported(releaseProblems((t) => t.replace(/ {10}if gh release view "\$TAG".*\n/, '')), 'gh release view');
});

test('a tag job that releases a commit off main is reported', () => {
  assertReported(releaseProblems((t) => t.replace(/ {10}git merge-base --is-ancestor .*\n/, '')), 'origin/main');
});

test('a build cache in the release workflow is reported', () => {
  assertReported(releaseProblems((t) => t.replace('          node-version-file: .nvmrc\n', '          node-version-file: .nvmrc\n          cache: npm\n')), 'build cache');
});

test('a release setup-go without cache: false is reported', () => {
  assertReported(releaseProblems((t) => t.replace('          cache: false\n', '')), 'setup-go caches by default');
});

// v0.1.0-web3.1: the release stamps its tag (without the leading v) into dillad at link time; ci.yml's builds never do.
test('a release build without the version stamp is reported', () => {
  assertReported(releaseProblems((t) => t.replace(' -X main.Version=${VERSION}" -o dist/dillad-linux-arm64', '" -o dist/dillad-linux-arm64')),
    'go build without -X main.Version=${VERSION}');
});

test('an extra release go build without the version stamp is reported', () => {
  const extra = "      - name: linux/riscv64\n        run: CGO_ENABLED=0 GOOS=linux GOARCH=riscv64 go build -trimpath -ldflags='-s -w' -o dist/dillad-linux-riscv64 ./cmd/dillad\n";
  assertReported(releaseProblems((t) => t.replace('      - name: linux/arm64\n', `${extra}      - name: linux/arm64\n`)),
    'go build without -X main.Version=${VERSION}');
});

test('a release that does not check the stamped version is reported', () => {
  assertReported(releaseProblems((t) => t.replace(/ {10}test "\$\(dist\/dillad-linux-amd64 version .*\n/, '')), 'dillad-linux-amd64 version');
});

test('a release build whose version does not come from the tag job is reported', () => {
  assertReported(releaseProblems((t) => t.replace(/( {6}- name: linux\/arm64\n {8}env:\n {10}VERSION: )\$\{\{ needs\.tag\.outputs\.version \}\}/, '$1${{ github.ref_name }}')),
    'uses the version without its own env VERSION: ${{ needs.tag.outputs.version }}');
});

test('a release whose tag job does not output the version is reported', () => {
  assertReported(releaseProblems((t) => t.replace('      version: ${{ steps.tag.outputs.version }}\n', '')), 'must output version');
  assertReported(releaseProblems((t) => t.replace('          echo "version=${tag#v}" >> "$GITHUB_OUTPUT"\n', '')), 'is missing: echo "version=${tag#v}"');
});

test('a ci.yml build that stamps a version is reported', () => {
  const stamped = GOOD.replace("go build -trimpath -ldflags='-s -w' ./cmd/dillad", "go build -trimpath -ldflags='-s -w -X main.Version=1.2.3' ./cmd/dillad");
  assert.notEqual(stamped, GOOD);
  const problems = checkWorkflow(fixture(stamped));
  assert.ok(problems.some((p) => p.includes('main.Version')), problems.join('\n'));
});

// Task 3 m2: a quoted symbol after -X, and the -X= spelling, stamp a version all the same.
test('a ci.yml build that stamps a quoted version is reported', () => {
  for (const flag of ["-X 'main.Version=1.2.3'", '-X "main.Version=1.2.3"', '-X=main.Version=1.2.3', "-X='main.Version=1.2.3'"]) {
    const stamped = GOOD.replace("go build -trimpath -ldflags='-s -w' ./cmd/dillad", `go build -trimpath -ldflags="-s -w ${flag}" ./cmd/dillad`);
    assert.notEqual(stamped, GOOD);
    const problems = checkWorkflow(fixture(stamped));
    assert.ok(problems.some((p) => p.includes('stamps main.Version')), `${flag}\n${problems.join('\n')}`);
  }
});

test('the CLI checks release.yml too', () => {
  const root = releaseFixture(REAL_RELEASE.replace('release/install.sh release/SHA256SUMS', 'release/SHA256SUMS'));
  const cwd = mkdtempSync(join(tmpdir(), 'dilla-ci-cwd-'));
  const result = runCli(root, cwd);
  assert.equal(result.status, 1, `stdout: ${result.stdout}\nstderr: ${result.stderr}`);
  assert.match(result.stderr, /release\.yml/);
});
