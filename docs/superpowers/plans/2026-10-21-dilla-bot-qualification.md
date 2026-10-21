# Dilla Bot qualification record

Date: 2026-10-21. Scope: Task 0 baseline and Task 1 development probes.
Provider revision: the user approved evaluating librespot instead of Soloist.
The Soloist observations below are retained as historical evidence.
Status: **not qualified; production implementation and release gates remain closed**.
See [implementation plan](2026-10-21-dilla-bot.md) and
[design](../specs/2026-10-21-dilla-bot.md).

## Repository baseline

`git fetch origin` succeeded. The branch starts at
`d5f1bb00dfa8af751c06a1a395adfb55c9e5502e`, exactly one commit after the
planning baseline `98b651aa987d2012c753ca44e7b3dfee5eaedf3a`.
That commit is web3.10 profile-card and voice/sidebar polish (#42); bot UI work
must use the new VoiceView, MemberCardHost, ProfileCard and settings layout.
No backend/protocol changes occurred between those revisions. Wire version is
still 2, permission bit 23 is manage_nicknames, bit 24 remains available.

Worktree: `/home/thim/.cache/dilla-tmp/dilla-bot`, branch `feat/dilla-bot`.
The native tool initially placed it outside writable roots; the same worktree
was moved with explicit filesystem approval, without creating a duplicate.
Original `/home/thim/Repositories/dilla` stays on local main `3ed7234b` with its
untracked `.claude/` untouched.

## Initial local prerequisites (before the librespot revision)

| Item | Observation |
| --- | --- |
| Soloist | Neither `soloist` nor `spotify-soloist` on PATH; no `/opt/soloist` |
| Dedicated bot service | No `/etc/dillabot`, `/var/lib/dillabot`, or runtime credential directory |
| Credentials | No Spotify/Soloist environment-variable names; no secret values inspected |
| Desktop Spotify | `/opt/spotify/spotify` exists; not used as a bot or as account authorization |
| yt-dlp | Not installed on PATH |
| Deno | Not installed on PATH |
| Node | v24.15.0 (not yet qualified with yt-dlp JS components) |
| ffmpeg / ffprobe | n9.0.2; ffmpeg built with libopus and libpulse |
| Audio tools | pipewire and pactl available; pulseaudio daemon absent |
| Isolation tool | bwrap present; service/provider isolation not qualified |
| Toolchains | Go 1.27.0, Cargo 1.98.1 |

This is the development workstation, not a verified intended service environment.
No real provider playback, browser decryption, isolated capture, pairing, or reboot
test has been performed. Installed tools alone are not qualification evidence.

## Historical Soloist constraints

The currently documented Soloist startup uses `--api-key VALUE`; no protected
file or inherited-descriptor input is documented there. This conflicts with the
approved design's prohibition on credentials in argv. A private environment file
followed by expansion into an argument still places the credential in argv. We
have not inspected an operator-supplied binary and cannot conclude that an
undocumented supported input exists. Do not invent a flag or weaken the boundary.
Source: [Soloist authentication](https://developer.spotify.com/documentation/soloist/concepts/authentication).

Its WebSocket API has no client authorization or browser-origin checks. A command
result only acknowledges dispatch. `get_queue` can request all *available* entries;
that does not prove complete expansion of an arbitrary playlist without changing
playback. Both isolation and metadata-only complete expansion need real evidence.
Source: [Soloist WebSocket reference](https://developer.spotify.com/documentation/soloist/reference/websocket-api).

Version output and exit code 10 can inform expiry diagnostics. The original
plan's 90-day lifetime remains a qualification assumption to verify against the
specific supplied build. Do not redistribute the executable.
Sources: [command line](https://developer.spotify.com/documentation/soloist/reference/command-line),
[downloads and updates](https://developer.spotify.com/documentation/soloist/reference/downloads-and-updates).

The stated external broadcast restriction remains unresolved; the published policy
describes one source serving simultaneous listeners as prohibited. Technical
qualification alone does not resolve that constraint.
Source: [Spotify developer policy, section III](https://developer.spotify.com/policy).

YouTube qualification requires yt-dlp with its JS support and a supported runtime,
network isolation, actual extraction and bounded decoding. Node availability by
itself proves none of these.
Source: [yt-dlp documentation](https://github.com/yt-dlp/yt-dlp).

## Operator input needed to resume qualification

Supply the intended Linux test/service host and service identity, and authorize
the dedicated Premium account with the development helper's protected-file PKCE
flow. Provide only paths and test-host information in chat, never credentials or
the redirected authorization URL. Soloist and its API key are no longer required.
Production deployment remains a separate action. See the current
[probe instructions](../../../experiments/bot-providers/README.md).

Task 1 then needs actual evidence for headless authorization/direct PCM output, restart
and reboot, complete track/album/playlist resolution without playback, pause/seek/
transition/completion behavior, bounded Opus output and browser SFrame decryption.
The latter needs a development test peer before production Task 8; mocks and
command acknowledgements cannot pass that row.

## Initial baseline failures

- `cargo test -p dilla-core` fails at `vectors_native.rs`: `vectors` is
  feature-gated. Existing CI enables all features; focused command must include
  `--features vectors`. This is a plan-command correction, not a source change.
- API/DS Go tests initially fail because
  `internal/mlswasi/testdata/dilla_core_wasi.wasm` is generated and absent from a
  fresh worktree. Build it with the existing locked WASI command and copy the
  artifact before rerunning. Gateway/media/SFrame pass on the initial run.
- `npm ci` installs the locked dependency set successfully; its audit reports
  55 existing findings (17 moderate, 34 high, 4 critical). No dependency versions
  were changed as part of this preparation.

## Baseline results after prerequisite setup

| Command | Result |
| --- | --- |
| `cargo test -p dilla-core --features vectors` | Passed: 618 tests, 4 ignored across 20 summaries |
| `cargo build -p dilla-core-wasi --target wasm32-wasip1 --release --locked` | Passed; generated artifact copied to ignored testdata path |
| `go test ./internal/api ./internal/ds ./internal/gateway ./internal/media ./internal/sframe` | All five packages passed after fixture setup |
| `npm test -w @dilla/client-core` | 1,987 tests / 51 files passed |
| `npm test -w @dilla/web` | 2,187 tests / 110 files passed |
| Both workspace `npm run typecheck` commands | Passed |
| `npm run lint` | Passed |
| `npm run check:docs` | Passed |
| `npm run vectors` plus tracked-vector diff | Passed; no vector changes |

These establish the baseline, not bot acceptance. No production Rust/Go/TypeScript
code was changed. PostgreSQL-specific, race and browser release matrices have not
been run for this bot; they remain future release gates. dilla-bot-core,
internal/bot and cmd/dillabot do not yet exist.

The development-only [provider harness](../../../experiments/bot-providers/README.md)
adds dependency/version checks and local synthetic Opus encoding. It does not
launch providers or consume credentials. Its unit tests and real ffmpeg smoke
check are preparation for Task 1, not completion of Task 1.

## Initial development harness verification (before the librespot revision)

After commit `ea0c9a96`, the coordinator independently ran:

```sh
cd experiments/bot-providers
python3 -m unittest -v
python3 provider_harness.py opus-smoke
python3 provider_harness.py doctor
```

The 13 unit tests passed. The real local ffmpeg/ffprobe check produced 51 Opus
packets at 48 kHz stereo, 20 ms frame cadence and 96 kbps CBR. It explicitly
reports provider playback and browser SFrame decryption unverified. `doctor`
returns the expected exit 1 for missing Soloist and yt-dlp and reports qualification
unverified, even though local encoding works.

An independent review found that a descendant holding stdout could defeat the
deadline and a SIGTERM-ignoring child could survive cleanup. Both were reproduced
before fixing; the coordinator observed a 0.05-second timeout return success after
1.019 seconds. The fixes preserve readiness-based reads and terminate the spawned
process group independently of its leader. New tests check elapsed time and actual
descendant termination. The reviewer's scoped second pass approved both fixes,
with no new Important findings. This review covers the bounded harness only.

Task 0 is complete. Task 1 is **blocked/unqualified**, with the preparatory harness
implemented and verified. Tasks 2–16 have not begun. No production bot service,
UI, APIs, protocol change, provider integration, feature release, PR, or live
deployment is represented by this preparation. Resume from the current operator inputs
and qualification matrix; do not bypass the qualification gate.

## Librespot development probe

The user approved replacing Soloist with librespot for qualification. The
standalone Rust probe in `experiments/bot-providers/librespot-probe` pins
librespot 0.8.0 with default audio/discovery features disabled. A private PCM pipe
replaces the virtual sink and unauthenticated control socket. The community
identity/MLS helper remains a separate planned component.

The nested Cargo.lock also fixes `vergen` at 9.0.6 with `vergen-gitcl` 1.0.5.
Initial dependency resolution selected vergen 9.1.0, which mixed incompatible
vergen-lib traits in librespot-core's build script. The compatible lockfile
builds without modifying upstream source or the main workspace's dependencies.

Implemented development commands are authorization begin/completion, metadata
resolution, bounded track playback, and a synthetic PCM smoke check. Controls
cover pause/resume/seek/volume/stop; queues remain a future runtime feature.
OAuth uses PKCE with state, exact callback and expiry validation. Files and
callbacks are size-bounded; secret files require mode 0600 and the state directory
0700. Metadata resolution constructs no player and rejects incomplete, truncated,
non-track or oversized collections before returning descriptors.

Independent OAuth-module review approved the implementation. The integrated
helper review found a post-login cleanup gap when credential persistence fails.
Commit `5db759ae` fixes it with a session shutdown guard, preserves shutdown before
joining the player thread, and adds an offline lifecycle regression using a real
librespot Session without connecting. The coordinator also reproduced and fixed
a test fixture that depended on the ambient umask. The scoped re-review approved
both fixes with no remaining findings.

The coordinator independently verified the final integrated helper:

| Check | Observed result |
| --- | --- |
| Locked Rust tests | 20 unit and 2 subprocess tests passed after the cleanup fix |
| Formatting and clippy with warnings denied | Passed |
| Shared production sink and converter, synthetic input | 176,400 bytes: one second of 44.1 kHz stereo signed 16-bit little-endian PCM |
| That PCM through FFmpeg and ffprobe | 51 Opus packets, 48 kHz stereo, 20 ms frame cadence, 96 kbps CBR |
| Local authorization setup, without browser/account | Created mode-0700 state and mode-0600 pending file |
| Synthetic wrong-state callback | Rejected without token exchange, consumed pending state, allowed a new attempt |
| Doctor with built probe path | Helper available; yt-dlp absent; exit 1 and qualification explicitly unverified |
| Private-umask fixture check | Passed under umask 077 after making the loose-mode fixture explicit |

These tests use synthetic audio and locally generated authorization state only.
No account token exchange, cached-account login, real Spotify audio, service host
restart/reboot or browser decryption was tested. Actual provider qualification
remains open, including complete real playlists and upstream audio-key behavior
for the selected account. The known compatibility issue is tracked
[upstream](https://github.com/librespot-org/librespot/issues/1649).

The Python checker revision also passed all 14 tests; protocol documentation
checks passed. No root-workspace Rust/Go/TypeScript implementation was changed.
The isolated worktree retains signed-off commits; original main and `.claude/`
remain untouched. The development probe and its review are complete; this does
not complete Task 1's real provider qualification.

Use the [probe guide](../../../experiments/bot-providers/README.md) for the next
account test. Soloist binaries, API keys, sink setup and build-expiry requirements
are superseded. Task 0 is complete; Task 1 remains unqualified; Tasks 2–16 remain
unstarted. No production bot release or live deployment has occurred.
