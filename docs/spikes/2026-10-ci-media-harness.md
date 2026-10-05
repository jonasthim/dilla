# SP-27 — the CI media harness on the runner shape

Date: 2026-10-04 · Commit: `7ec8a13` · Host: `Linux 7.2.7-1-cachyos x86_64`

## Question

Does the media suite pass on a fresh Ubuntu 24.04 runner with one private interface, and how long does it take? The runner-shape portion remains unmeasured because the podman image could not be built under rootless vfs storage. The first `browser-media` PR run (NV-5) is the runner proof.

## Rig

The proposed `Containerfile` was never built. It has been removed because its tar copy included ignored local build artefacts and its suite leg omitted the mediabot and RNNoise build steps, so it could not reproduce CI. The normal build attempt failed with `set sticky bit on: chmod /run/user/1000/libpod: read-only file system`; with writable runtime and vfs storage it failed with `newuidmap: Could not set caps`. The recorded `podman run` attempts stopped at the same read-only runtime error. No in-container `ip -4 addr`, setup seconds, test seconds or total seconds exist.

The following are **host runs, not the container shape**. They used `GOMAXPROCS=4`, the repository's built WASI core, testkit, wasm and node modules, and Playwright 1.63.0. The test command had the required worktree `TMPDIR`/`GOTMPDIR`. Chromium itself needed a short `/tmp/sp27-browser` temporary path: with the long worktree path it aborted before tests with `FATAL: ... Socket path too long`. That child-process environment was applied temporarily to the Playwright config and removed after measurement. Host `ip -4 addr` showed `lo 127.0.0.1/8` and `eno1 192.168.20.20/24`.

## Results

Two sets of host runs exist and are labelled by who ran them. Neither is the container shape.

Supervisor host runs (2026-10-04, unrestricted shell, short TMPDIR, `GOMAXPROCS=4`, Playwright 1.63.0):

| Host leg | `advertise_internal_ip` | Chromium build | Outcome | Playwright elapsed |
|---|---|---|---|---|
| suite (`npm run test:e2e:media`) | true | new headless (`channel: 'chromium'`) | PASS: 22 passed, 6 skipped (by design: Firefox project skips Chromium-only specs and the three-context harness spec runs on Chromium) | 1.6 min |
| pairs | true | new headless | PASS: all three contexts decoded 4/4 | 4.1 s |
| no-internal-ip | false | new headless | Expected FAIL: Firefox `connect` rejected; both Chromium contexts decoded 2/4 | 16.7 s |
| shell | true | chromium-headless-shell | PASS: `harness.spec.ts` | 7.4 s |

Raw pairing output (supervisor run):

```text
SP-27 chromium-0: 4/4 decoding; local host 192.168.20.20:60778 -> remote host 127.0.0.1:7882
SP-27 chromium-1: 4/4 decoding; local host 192.168.20.20:33003 -> remote host 127.0.0.1:7882
SP-27 firefox-0: 4/4 decoding; local host 32ea95de-bcac-4201-b8ad-d3836b536ee5.local:38670 -> remote host 192.168.20.20:7882
```

Raw negative-leg lines (supervisor run):

```text
SP-27 connect error: firefox-0: Error: page.evaluate: could not establish pc connection
SP-27 chromium-0: 2/4 decoding; local host 192.168.20.20:46523 -> remote host 127.0.0.1:7882
SP-27 chromium-1: 2/4 decoding; local host 192.168.20.20:60499 -> remote host 127.0.0.1:7882
```

Codex sandbox host runs (same day, same commit): pairs and no-internal-ip gave the same results (4/4 each; Firefox
rejected and Chromium 2/4). The suite and shell legs FAILED there: `harness.spec.ts` timed out at the Firefox
`renderProbe(3_000)` evaluation (`21 passed, 6 skipped, 1 failed (3.4m)`). The same code passes on the supervisor's
unrestricted shell, so that failure is attributed to the Codex sandbox (it also needed a long-TMPDIR workaround for
Chromium's `Socket path too long`), not to the harness; it is recorded here, not hidden. The cause was not isolated.

None of these times is the cold-container suite duration `T`: no setup time (cargo, wasm-pack, `npm ci`, browser
install) was measured, because the container legs did not run.

Container legs: **not run here: rootless podman cannot build the image.** In the Codex sandbox: `set sticky bit on: chmod
/run/user/1000/libpod: read-only file system`, then `newuidmap: Could not set caps`. On the supervisor shell (vfs
storage driver) `podman build` failed with `mounting an overlay over build context directory ... mount overlay: no such
device`. No in-container `ip -4 addr` or setup/test/total seconds exist. Host `ip -4 addr` showed `lo 127.0.0.1/8` and
`eno1 192.168.20.20/24`.

## Pass / fail

Host: PASS on every host leg run by the supervisor (suite, pairs, shell) and the negative leg failed on the Firefox
context with `could not establish pc connection`, as G35 L2. Runner shape: **not run here** (see above); not inferred
from host runs.

## Decision consumed by task 21

- Cold-container suite `T`: **not measured**. Keep `browser-media` `timeout-minutes: 25` under the controller's scan-10
  ruling (podman cannot build the image under vfs). The host suite took 1.6 min of test time. The first PR run (NV-5)
  proves the runner shape and its timing.
- Task 21 step 18 retains `25` in `.github/workflows/ci.yml`, `scripts/check-ci-workflow.mjs` and
  `scripts/check-ci-workflow.test.mjs`.
- `advertise_internal_ip: true` stays mandatory for every test host a Firefox context joins (host negative leg
  reproduces G35 L2).
- new headless vs headless shell: both pass on the host; `chromium-media` keeps `channel: 'chromium'`.
- NV-5 stays open until the first `browser-media` run on the PR confirms this on `ubuntu-latest`.
