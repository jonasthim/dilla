import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, chmodSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const script = join(dirname(fileURLToPath(import.meta.url)), 'build-ci-image.sh');

function run(event, ref) {
  const dir = mkdtempSync(join(tmpdir(), 'dilla-image-test-'));
  const log = join(dir, 'docker.log');
  const docker = join(dir, 'docker');
  writeFileSync(docker, '#!/bin/sh\nprintf "%s\\n" "$*" >> "$DOCKER_LOG"\nif [ "$1 $2" = "buildx imagetools" ]; then printf \'%s\\n\' \'{"manifests":[{"platform":{"os":"linux","architecture":"amd64"}},{"platform":{"os":"linux","architecture":"arm64"}}]}\'; fi\n');
  chmodSync(docker, 0o755);
  try {
    const result = spawnSync('bash', [script], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${dir}:${process.env.PATH}`,
        DOCKER_LOG: log,
        GITHUB_EVENT_NAME: event,
        GITHUB_REF: ref,
        GITHUB_SHA: '0123456789abcdef0123456789abcdef01234567',
        GITHUB_REPOSITORY: 'JonasThim/Dilla',
      },
    });
    return { result, calls: existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean) : [] };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('pull requests build both architectures without publishing', () => {
  const { result, calls } = run('pull_request', 'refs/pull/42/merge');
  assert.equal(result.status, 0, result.stderr);
  const build = calls.find((line) => line.startsWith('buildx build '));
  assert.match(build, /--platform linux\/amd64,linux\/arm64/);
  assert.match(build, /--output type=cacheonly/);
  assert.match(build, /--build-arg VERSION=pr-42/);
  assert.doesNotMatch(build, /--push|--tag/);
});

test('main publishes the existing image tags and attestations', () => {
  const { result, calls } = run('push', 'refs/heads/main');
  assert.equal(result.status, 0, result.stderr);
  const build = calls.find((line) => line.startsWith('buildx build '));
  for (const tag of ['latest', 'main', 'sha-0123456']) {
    assert.match(build, new RegExp(`--tag ghcr\\.io/jonasthim/dilla/dillad:${tag}`));
  }
  assert.match(build, /--push/);
  assert.match(build, /--provenance=mode=max/);
  assert.match(build, /--sbom=true/);
  assert.match(build, /--build-arg VERSION=main/);
});

test('other events and refs cannot publish', () => {
  for (const [event, ref] of [['push', 'refs/heads/feature'], ['workflow_dispatch', 'refs/heads/main']]) {
    const { result, calls } = run(event, ref);
    assert.notEqual(result.status, 0);
    assert.equal(calls.length, 0);
  }
});
