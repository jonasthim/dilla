# Development-only provider qualification

The Spotify candidate is now **librespot 0.8.0**, replacing Soloist with the user's
approval. The isolated Rust probe sends PCM directly to an encoder. It needs no
physical sound device, PipeWire/PulseAudio sink, Soloist binary or API key.
This is Task 1 preparation, not a shipping Dilla bot or a qualified provider.

The shipping Spotify setup belongs in Server Settings > Bot > Music. That UI is
not implemented yet. The manual commands below are optional development tools;
operators do not need to run them to unblock development. Real account playback
remains a release acceptance requirement.

The Python harness checks dependencies and synthetic Opus encoding. The Rust
probe adds protected-file OAuth authorization, metadata resolution, limited
playback controls and direct PCM output. Real dedicated-account playback,
restart/reboot, complete playlist behavior and browser SFrame decryption still
need observation on the intended service host. Successful authentication or a
player command acknowledgement does not prove that audio arrived.

## Build and local checks

From this directory, with Python 3.10+, the repository's Rust toolchain and FFmpeg:

```sh
cargo build --locked --manifest-path librespot-probe/Cargo.toml
cargo test --locked --manifest-path librespot-probe/Cargo.toml
python3 -m unittest -v
python3 provider_harness.py doctor --librespot-bin librespot-probe/target/debug/dilla-librespot-probe
python3 provider_harness.py opus-smoke
```

The probe is a standalone Cargo workspace, keeping provider dependencies out of
`dillad` and the existing Rust workspace. The committed lockfile fixes the tested
dependency set. `doctor` checks the probe, yt-dlp, ffmpeg, ffprobe, and a JavaScript
runtime (Deno, Node or Bun). The YouTube probe specifically uses Node. The checker
prints sanitized version tokens and exits nonzero
for missing prerequisites. Executable overrides are `--librespot-bin`,
`--yt-dlp-bin`, `--ffmpeg-bin`, `--ffprobe-bin`, and `--js-runtime-bin`.

`opus-smoke` encodes a synthetic tone with libopus: 48 kHz stereo, 20 ms frames,
96 kbps CBR, DTX disabled. It checks stream metadata and packet sizes with ffprobe.
The Python process runner bounds output/time and cleans up its process group.
This proves local encoding only. `pcm-smoke` on the Rust probe instead emits one
second of synthetic signed 16-bit little-endian stereo PCM at 44.1 kHz through
the same sink used for Spotify. Pipe this output into FFmpeg with input options
`-f s16le -ar 44100 -ac 2`, then resample to 48 kHz for Opus. Never send raw PCM
to a terminal. Neither smoke command authenticates or reads account credentials.

## YouTube development probe

Install the hash-pinned candidate dependencies into the probe's dedicated virtual
environment. They are separate from Dilla's application dependencies:

```sh
python3 -m venv .youtube-venv
.youtube-venv/bin/python -m pip install --require-hashes --only-binary=:all: --no-deps -r youtube-requirements.txt
python3 -m unittest -v test_provider_harness test_youtube_probe test_youtube_sandbox
python3 provider_harness.py doctor --yt-dlp-bin .youtube-venv/bin/yt-dlp --librespot-bin librespot-probe/target/debug/dilla-librespot-probe
```

The pinned pair is yt-dlp 2026.10.21 and yt-dlp-ejs 0.8.0. The wheel hashes are
in `youtube-requirements.txt`; yt-dlp 2026.10.21's upstream project metadata pins
that EJS version. A direct test with 2026.10.21 succeeded after 2025.09.26 failed
in the integrated Bot path. That is dependency evidence only, not full provider or
cross-server qualification. The probe disables
remote component downloads and explicitly selects Node. Its packaged EJS setup
follows the [upstream instructions](https://github.com/yt-dlp/yt-dlp/wiki/EJS).
Use Node 22 or newer on PATH. The sandbox mounts that single executable at
`/usr/bin/node`; the host's `/usr/bin/node` may be a different version. The local
checks used Node 24.15.0 and FFmpeg/ffprobe n9.0.2. This set successfully resolved
a video, five search results and a one-video playlist, and captured a real
ten-second audio sample. See the
[qualification record](../../docs/superpowers/plans/2026-10-21-dilla-bot-qualification.md)
for evidence and remaining checks.

The Linux runner requires bubblewrap and working unprivileged namespaces. It gives
the extractor a private filesystem and network namespace. HTTPS goes through a
bounded CONNECT broker that checks allowed YouTube hosts and all resolved IP
addresses, then connects to the validated numeric address. Direct network access,
private addresses, personal configuration, browser cookies and arbitrary plugins
are unavailable. A sandbox failure stops the operation. There is no unrestricted
fallback. Process, output and resource limits apply to these development probes;
production service packaging remains a later task.

```sh
python3 youtube_probe.py metadata 'instrumental study music'
python3 youtube_probe.py metadata 'https://www.youtube.com/watch?v=aqz-KE-bpKQ'
```

Metadata output contains bounded video descriptors. Playlist validation completes
before anything is printed; incomplete or oversized collections fail without
returning a partial list. Flat enumeration avoids downloading every item's format
list. A descriptor may omit an unknown duration; playback resolves the selected
video separately. Large real playlists still need qualification. Diagnostics omit
provider output and signed media URLs.

`sample INPUT` writes up to ten seconds of Ogg Opus to stdout and refuses a
terminal. Redirect it to a private file for browser testing. The sample uses
48 kHz stereo, 20 ms frames, 96 kbps CBR and disabled DTX. Failed extraction
returns nonzero; an empty or failed artifact is not playback evidence.

For example, create a new private artifact without overwriting an existing file:

```sh
umask 077
set -o noclobber
python3 youtube_probe.py sample 'https://www.youtube.com/watch?v=aqz-KE-bpKQ' > /absolute/private/path/youtube-sample.ogg
```

Use the file only after the command exits successfully. The probe buffers the
bounded result before writing it; failed extraction can leave an empty redirected
file.

## Browser audio verification

`e2e/media/provider-opus.spec.ts` uses the existing Go media peer, MLS test driver,
LiveKit SFU and browser encryption worker. It requires authenticated frames for
the expected publisher, microphone track and epoch, decoded samples and nonzero
rendered audio. Its source is an explicit Ogg file, not a live provider pipe.

Build the existing media prerequisites from the repository root:

```sh
cargo build -p dilla-testkit --release --locked
npm run build:wasm -w @dilla/media
go build -o target/dilla-mediabot ./cmd/dilla-mediabot
```

The generated WASI fixture must also exist at
`internal/mlswasi/testdata/dilla_core_wasi.wasm`, as described in the baseline
record. Install the repository's Playwright Chromium and Firefox builds. Firefox
needs a working audio backend; the existing CI setup is
`scripts/ci-audio-server.sh`. A private null sink suffices for this check.

Set `DILLA_PROVIDER_OPUS_FILE` to the absolute path of the captured file and
`DILLA_PROVIDER_NAME` to `youtube` or `spotify`, then run:

```sh
npx playwright test --config e2e/playwright.media.config.ts --project=chromium-media --project=firefox-media provider-opus.spec.ts
```

Use `DILLA_PROVIDER_NAME=synthetic` for harness checks. Synthetic results are
labeled `harness-smoke-only`; missing inputs skip rather than qualify a provider.
The provider label is operator-supplied provenance, not independent proof of the
file's origin. Preserve the actual capture result with the file hash. The browser
test suppresses traces containing call credentials and passes the room token via
a private file and the SFrame key via stdin.

The qualification record distinguishes synthetic browser checks from real source
playback and records the encryption-removal negative control. This file-based
check does not qualify live queues, provider control, rekeying, restart or the
shipping bot UI.

## Optional developer authorization of the dedicated account

Run under the intended test/service identity. Use a new private state directory;
do not import a personal Spotify desktop cache. The probe requires state directory
mode 0700 and secret-file mode 0600, owned by the current user. Credentials and
pending OAuth state are not command arguments, environment values or log output.

```sh
umask 077
export DILLA_PROBE_STATE=/absolute/private/path/dilla-provider-test
librespot-probe/target/debug/dilla-librespot-probe authorize --state-dir "$DILLA_PROBE_STATE"
```

Open the printed Spotify authorization URL in a browser and choose the dedicated
Premium account. There is no callback listener. The final redirect to
`http://127.0.0.1:5588/login` may show a connection error; copy its full address
into a new file named `redirect.txt` inside the private state directory, using a
local editor. Keep that file mode 0600. Do not paste it into chat, a shell command,
or logs: it contains a short-lived authorization code.

Within ten minutes, complete the exchange:

```sh
librespot-probe/target/debug/dilla-librespot-probe authorize-complete \
  --state-dir "$DILLA_PROBE_STATE" --redirect-file "$DILLA_PROBE_STATE/redirect.txt"
```

The helper validates PKCE state, redirect destination and expiry before exchanging
the code, then connects and saves reusable credentials in `credentials.json`.
A pending authorization is single-use once the callback file is successfully
read. If callback validation or the exchange fails, start a new authorization.
For file-path or permission errors, correct the file and retry completion. To
discard an unused or expired flow, remove only `pending.json` in the private state
directory before authorizing again. Remove the local redirect file after the
attempt. Treat the whole state directory, including backups, as secret material. This flow is
implemented for qualification; successful real pairing has not yet been observed.

## Metadata and bounded audio probe

`resolve --state-dir PATH --input INPUT` accepts Spotify track/album/playlist URIs
or HTTPS links on `open.spotify.com`. It returns bounded descriptors as JSON on
stdout, without constructing a player. Redirect output to a private file if it
must be retained. It rejects incomplete playlist responses, unsupported entries
and collections above 500 tracks before emitting any descriptors. Complete
expansion against real playlists is an acceptance test, not an assumed upstream
guarantee.

`play --state-dir PATH --input TRACK --max-seconds N` accepts a track and runs for
at most N seconds (1–300). Stdout is raw 44.1 kHz stereo s16le PCM; stderr carries
sanitized status events. Keep stdin open for controls; EOF terminates playback.
Each command is one JSON line, at most 4096 bytes:

```json
{"op":"pause"}
{"op":"resume"}
{"op":"seek","position_ms":30000}
{"op":"volume","value":50}
{"op":"stop"}
```

Unknown commands/fields and invalid values fail. Queueing, shuffle, repeat, skip
and per-community sessions belong to the later Dilla runtime; they are not
implemented in this probe. No Spotify Connect discovery is enabled, no system
speaker is opened, and no audio cache is configured. Audio arrival, unavailable
tracks and end-of-track are reported separately from command submission.

The probe's line commands are an internal development interface. They do not
freeze the planned production CBOR helper protocol or change Dilla wire formats.
The Spotify provider helper also remains distinct from the community identity
helper that will own MLS and encrypted application state.

## Remaining qualification matrix

| Requirement | Required observation |
| --- | --- |
| Dedicated account | Headless PKCE authorization under the intended service user, actual PCM arrival, reusable login after process restart. |
| Host lifecycle | Restart and reboot recovery with protected credentials, no physical sound device and no desktop audio dependency. |
| Spotify metadata | Track, album and complete playlists, including the 500-track boundary; resolution must not start playback. |
| Spotify controls | Actual pause/resume/seek/volume/stop, unavailable tracks, end-of-track and transitions under the future queue owner. |
| Audio pipeline | Real Spotify PCM through resampling and Opus at the required format; synthetic output is separate evidence. |
| YouTube | Qualified yt-dlp/JS versions, supported search/video/playlist extraction and bounded decoding with network isolation. |
| Browser encryption | Real Chromium/Firefox playback through existing LiveKit/SFrame, encrypted SFU frames, epoch change and removal evidence. |
| Operational limits | One global Spotify lease, independent sessions, disconnect cleanup and restart paused, in the integrated runtime. |

The workstation now has the pinned extraction dependencies. The intended bot host
is the existing Dilla server, using a separate bot service account. Real Spotify
authorization and playback will be checked through the server settings flow when
ready; development can continue in the meantime. The complete release remains
blocked until actual provider and integration acceptance passes.
The source dependency is pinned, but upstream reports audio-key failures for
some accounts; actual playback must be tested with the selected account.
See [librespot's issue](https://github.com/librespot-org/librespot/issues/1649).
The previously documented Spotify broadcast-policy constraint remains unresolved;
changing the technical backend does not resolve it. See
[Spotify's developer policy](https://developer.spotify.com/policy).
