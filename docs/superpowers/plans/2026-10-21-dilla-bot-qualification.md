# Dilla Bot qualification record

Date: 2026-10-21. Scope: Task 0 baseline and Task 1 prerequisites.
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

## Observed local prerequisites

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

## Provider constraints requiring resolution

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

Supply the intended Linux test/service host and service identity, the path to the
operator-obtained Soloist binary, protected API-key file path, and dedicated
Premium account pairing readiness. Provide paths, never credentials in chat.
Resolve the protected secret-input incompatibility with a supported mechanism
before starting Soloist. Production deployment remains a separate action.

Task 1 then needs actual evidence for isolated headless pairing/output, restart
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
