# Development-only provider checks

This harness checks whether local prerequisites exist and whether the installed
FFmpeg can encode a short synthetic tone as Opus. It does not qualify Spotify or
YouTube, prove authenticated playback, or test browser SFrame decryption. It
never starts Soloist, invokes an account, reads credentials, changes an audio
sink, or plays through the desktop audio session. Provider qualification always
remains explicitly unverified here.

Run from this directory with Python 3.10 or later and no third-party Python
packages:

```sh
python3 -m unittest -v
python3 provider_harness.py doctor
python3 provider_harness.py opus-smoke
```

`doctor` exits nonzero if any prerequisite is absent or its bounded version
command fails. It checks Soloist, yt-dlp, ffmpeg, ffprobe, a JavaScript runtime
(Deno, Node, or Bun), and an audio utility (pactl, pw-cli, or wpctl). It prints
only a version token, never raw tool output. Optional `--soloist-bin`,
`--yt-dlp-bin`, `--ffmpeg-bin`, `--ffprobe-bin`, `--js-runtime-bin`, and
`--audio-tool-bin` flags supply executable paths. `opus-smoke` accepts
`--ffmpeg-bin`, `--ffprobe-bin`, and `--duration` (0 to 5 seconds, exclusive at
zero). All flags take paths or a duration only; there is no credential input.

The Opus check uses FFmpeg's local `lavfi` sine generator and `libopus` at
48 kHz stereo, 20 ms frame cadence, 96 kbps constant bitrate, and DTX disabled.
It validates Opus stream metadata and actual non-empty packet evidence with
ffprobe. Output is held in a mode-0700 temporary directory and removed on exit.
Each child process uses an argv array without a shell, has a timeout and a
bounded combined output buffer, and is terminated and reaped on timeout or
output overflow. This is encoding evidence only; a synthetic tone cannot stand
in for provider playback.

## Outstanding Task 1 qualification matrix

Full qualification remains blocked until the operator provides the Soloist
binary, its supported authentication and pairing setup, and the intended
production service host. Do not put keys or tokens in command-line arguments.
No production provider implementation should begin until the required evidence
is recorded for the intended Linux host.

| Requirement | Evidence still required |
| --- | --- |
| Soloist dependency and pairing | Exact Soloist build/version and supported secret delivery; pair the dedicated service Premium account without credentials in argv. |
| Headless real playback | Authenticate and reproduce real Spotify audio from a dedicated, headless service account. Command acknowledgements alone do not count. |
| Service lifecycle and capture | Prove playback, restart, host reboot, and capture without a physical audio device through an isolated service-owned audio server and virtual sink. |
| Spotify descriptors | Handle track, album, and playlist links/URIs; prove complete playlist expansion and metadata resolution without starting playback. |
| Spotify controls | Prove pause, resume, seek, skip, stop, transitions, completion, and failure reporting against real playback. |
| YouTube extraction | Pin yt-dlp and its required JavaScript support; prove supported search/video/playlist extraction, metadata, and bounded audio extraction on the intended host. |
| Local encoding | This harness checks local FFmpeg/libopus encoding and packet evidence only. The production audio path must also demonstrate the selected source/capture integration. |
| Encrypted browser playback | Prove the music stream is encoded and decrypted in the real supported browsers over the existing SFrame/LiveKit path. |
| Qualification record | Record exact dependency versions, host details, reproducible commands, and observed results for every required case above. |

The current workstation is not qualified: Soloist and yt-dlp are missing. The
local Opus smoke result does not satisfy any provider, capture, control, restart,
reboot, or browser-decryption requirement. Spotify's published broadcast-policy
restriction also remains an external unresolved issue.
