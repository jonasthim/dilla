# Task 1B — librespot development probe report

## Result

DONE. Implemented the standalone `dilla-librespot-probe` development harness in
`experiments/bot-providers/librespot-probe`. The binary is pinned to librespot
0.8.0, uses no system audio or Connect discovery/listener, and does not change
the root workspace or production protocol. No personal account or credentials
were used; live provider qualification remains unverified.

## Changes

- Added a nested Cargo workspace, committed lockfile, and target ignore rule.
  The lockfile pins `vergen` to 9.0.6 (with `vergen-gitcl` 1.0.5) because the
  resolved `librespot-core` 0.8.0 build script otherwise selected incompatible
  `vergen-lib` versions and failed to compile. This is a lockfile-only
  dependency resolution; no upstream source was changed.
- Added strict source URL/URI validation, bounded metadata expansion, and
  all-or-nothing playlist/album resolution. Playlists require position zero,
  no truncation, and returned item count equal to declared length. Resolution
  validates all entries before emitting JSON and never constructs a player.
- Added private Linux state storage and protected file helpers. State directories
  are created as 0700; state files are owned regular files with 0600 mode,
  bounded reads, no-follow/nonblocking opens, atomic credential replacement,
  and pending-flow consumption before token exchange.
- Integrated the separately implemented OAuth PKCE module without modifying
  `src/oauth.rs`. Authorization uses librespot's default client ID, consumes
  pending state once, sanitizes failures, connects with a 30-second bound, and
  stores reusable credentials atomically.
- Added track-only PCM playback and controls with bounded stdin/status/output
  handling, cancellation/deadline behavior, numeric position status, and
  `position_ms` on player position events. PCM is raw signed 16-bit little-endian
  stereo at 44.1 kHz. The `pcm-smoke` path passes synthetic audio through the
  production sink and librespot converter. Empty sample packets do not claim
  first PCM, and success is reported only after all bytes in a packet are
  written. Nonblocking descriptor flags are restored after writes.
- Added unit and subprocess tests for source controls and completeness, storage
  protections, PCM conversion, controls, secret sanitization, live control-pipe
  consumption, stalled-output termination, and shared descriptor flag restore.

## TDD and verification

RED: tests were added before the relevant implementation. The initial dependency
build was blocked by the upstream `vergen` resolution mismatch described above.
After pinning the compatible lockfile version, the first test run exposed the
strict-control parsing issue and later the stalled-pipe subprocess issue; both
were fixed in production code and the full suite rerun.

GREEN: commands run from the repository root:

```text
cargo fmt --manifest-path experiments/bot-providers/librespot-probe/Cargo.toml --check
# passed

cargo test --locked --manifest-path experiments/bot-providers/librespot-probe/Cargo.toml
# 19 unit tests passed; 2 process tests passed; 0 failed

cargo clippy --locked --manifest-path experiments/bot-providers/librespot-probe/Cargo.toml --all-targets -- -D warnings
# passed

cargo run --locked --quiet --manifest-path experiments/bot-providers/librespot-probe/Cargo.toml -- --version
# dilla-librespot-probe 0.1.0 (librespot 0.8.0)

cargo run --locked --quiet --manifest-path experiments/bot-providers/librespot-probe/Cargo.toml -- pcm-smoke | ffmpeg -hide_banner -loglevel error -f s16le -ar 44100 -ac 2 -i pipe:0 -c:a pcm_s16le -y /tmp/dilla-librespot-smoke.wav
# passed; emitted {"status":"ok","phase":"pcm-smoke","state":"first-pcm-written"}

ffprobe -v error -show_entries stream=codec_name,sample_rate,channels,duration -of default=noprint_wrappers=1 /tmp/dilla-librespot-smoke.wav
# codec_name=pcm_s16le; sample_rate=44100; channels=2; duration=1.000000
```

The test suite includes these process checks:

```text
test invalid_source_is_not_echoed ... ok
test empty_sample_packet_does_not_claim_first_pcm ... ok
test pcm_smoke_exits_when_pipe_consumer_stalls ... ok
```

No live authorization, account playback, or service/device qualification was
attempted, so the probe provides no qualification claim.
