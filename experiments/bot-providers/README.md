# Development-only provider qualification

The Spotify candidate is now **librespot 0.8.0**, replacing Soloist with the user's
approval. The isolated Rust probe sends PCM directly to an encoder. It needs no
physical sound device, PipeWire/PulseAudio sink, Soloist binary or API key.
This is Task 1 preparation, not a shipping Dilla bot or a qualified provider.

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
runtime (Deno, Node or Bun). It prints sanitized version tokens and exits nonzero
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

## Authorize the dedicated account

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
A pending authorization is single-use. If completion fails or expires, start a
new authorization. Remove the local redirect file after the attempt. Treat the
whole state directory, including backups, as secret material. This flow is
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

The workstation still lacks yt-dlp and an authorized dedicated test account.
The full Dilla Bot production implementation and release gates remain closed.
The source dependency is pinned, but upstream reports audio-key failures for
some accounts; actual playback must be tested with the selected account.
See [librespot's issue](https://github.com/librespot-org/librespot/issues/1649).
The previously documented Spotify broadcast-policy constraint remains unresolved;
changing the technical backend does not resolve it. See
[Spotify's developer policy](https://developer.spotify.com/policy).
