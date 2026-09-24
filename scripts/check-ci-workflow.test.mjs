import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkWorkflow } from './check-ci-workflow.mjs';

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
  rust-wasm-node:
    runs-on: ubuntu-latest
    steps:
      - run: cargo test -p dilla-core-wasm --target wasm32-unknown-unknown --locked
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
    steps:
      - run: wasm-pack build core/dilla-core-wasm --target web --release --mode no-install --out-dir spike/pkg
      - run: npm run test:e2e:matrix -w @dilla/e2e
  deny:
    runs-on: ubuntu-latest
    steps:
      - run: cargo deny --all-features check advisories bans licenses sources
`;

function fixture(body) {
  const dir = mkdtempSync(join(tmpdir(), 'dilla-ci-'));
  mkdirSync(join(dir, '.github', 'workflows'), { recursive: true });
  writeFileSync(join(dir, '.github', 'workflows', 'ci.yml'), body);
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
  const withGo = `${GOOD}  go:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/download-artifact@v8
      - run: go test ./...
`;
  const problems = checkWorkflow(fixture(withGo));
  assert.ok(problems.some((p) => p.includes('needs: rust-wasi')), problems.join('\n'));
});

test('a go job with needs: rust-wasi passes', () => {
  const withGo = `${GOOD}  go:
    runs-on: ubuntu-latest
    needs: rust-wasi
    steps:
      - uses: actions/download-artifact@v8
      - run: go test ./...
`;
  assert.deepEqual(checkWorkflow(fixture(withGo)), []);
});

test('a node job that stopped running the checker\'s own tests is reported', () => {
  const problems = checkWorkflow(fixture(GOOD.replace('      - run: npm run test:ci-check\n', '')));
  assert.ok(problems.some((p) => p.includes('test:ci-check')), problems.join('\n'));
});

// Fix round 1, finding 3 (important): gap-31 §4 item 2 / NV-14 resolved the pairing as
// `upload-artifact@v7` with `download-artifact@v8` — pairing v7 with v4 (facts/plan-B.md's now-stale
// deviation B15 text) is the untested combination B15 existed to prevent. The checker owns the
// cross-plan ordering rule already, so it must own this half of the hand-off too.
test('a go job with download-artifact@v4 instead of v8 is reported', () => {
  const withGo = `${GOOD}  go:
    runs-on: ubuntu-latest
    needs: rust-wasi
    steps:
      - uses: actions/download-artifact@v4
      - run: go test ./...
`;
  const problems = checkWorkflow(fixture(withGo));
  assert.ok(problems.some((p) => p.includes('download-artifact@v8')), problems.join('\n'));
});
