# Task 1 bounded harness report

Status: the development-only harness subtask is complete. Full Task 1 provider
qualification remains blocked and is not claimed. The operator-provided Soloist
binary, supported authentication/pairing setup, and intended service host are
still unavailable. Soloist and yt-dlp are missing from this workstation's PATH.
No account, provider credentials, playback, service, or production code was
touched.

## Changes

Added `experiments/bot-providers/` with a standard-library Python CLI, unittest
coverage, and README. `doctor` checks Soloist, yt-dlp, ffmpeg, ffprobe, a
JavaScript runtime, and an audio tool through bounded version commands. It
prints only a sanitized version token, exits nonzero when a required tool is
missing or its version command fails, and always says qualification is
unverified. Executable-path flags are supported; no credential arguments exist.

`opus-smoke` encodes a local synthetic sine input with ffmpeg/libopus at 48 kHz,
stereo, 20 ms frame cadence, 96 kbps CBR, DTX off, for one second by default
(maximum five seconds). ffprobe must show a non-empty Opus stream and packet
evidence consistent with the requested framing and bitrate. The check uses a
private temporary directory and does not alter or play through an audio sink.
Every subprocess uses argv arrays, bounded output/time, and terminate/reap
cleanup. Tests cover missing executable, version failure, timeout, output
overflow, ffmpeg failure, malformed probe data, empty packets, wrong packet
size, and valid packet evidence.

## Red/green evidence

- First test-first run failed to import the not-yet-created module, as expected
  while the harness was absent. After adding a minimal API scaffold, all 10
  behavioral tests failed on `NotImplementedError`, confirming the expected
  missing behavior.
- Initial implementation made 8 tests pass; two test setup errors exposed that
  the probe helper was intentionally keyed by real provider names. Correcting
  those test calls produced 10 passing tests.
- When the ffprobe fixture was corrected to reflect actual Ogg Opus output
  (stream bitrate is omitted and the final packet can be shortened by container
  padding), the bitrate/framing acceptance test failed against the old
  assumption. Validation was changed to check full 20 ms frame cadence, a
  permitted shortened final packet, and 240-byte CBR packets. The new positive
  and wrong-packet-size negative cases then passed.
- Final unit run: `python3 -m unittest -v` — 11 tests passed.
- Syntax: `python3 -m py_compile experiments/bot-providers/provider_harness.py experiments/bot-providers/test_provider_harness.py` — passed.
- Whitespace: `git diff --check` — passed.
- Actual local smoke: `python3 provider_harness.py opus-smoke` — passed; ffmpeg
  9.0.2/libopus produced 51 packets and ffprobe validated 48 kHz stereo, 20 ms
  frame cadence, 96 kbps CBR. Output explicitly leaves provider playback and
  browser SFrame decryption unverified.
- Actual doctor: `python3 provider_harness.py doctor` — expected exit 1. Found
  ffmpeg 9.0.2, ffprobe 9.0.2, Node 24.15.0, and pactl 17.0-98-gb096; Soloist
  and yt-dlp were missing. It reported provider qualification unverified.

## Still required for full Task 1

The harness README records the outstanding matrix: operator-supplied Soloist
version and supported secret delivery; headless dedicated-account pairing and
real playback; service restart/reboot and capture without a physical device;
track, album, and complete playlist handling; metadata resolution without
playback; pause/resume/seek/skip/stop/transitions/completion/failure; pinned
yt-dlp plus JavaScript extraction of supported YouTube search/video/playlist
inputs; production capture-to-Opus path; and encrypted playback/decryption in
the supported real browsers. Exact versions, intended-host commands, and
observed outcomes must be recorded after those prerequisites are supplied.
Spotify's published broadcast-policy restriction also remains unresolved.

## Round 1 review fixes

Added two real subprocess regressions before changing the runner. The red run
failed both: when the direct parent exited but its child kept stdout open,
`run_bounded` returned success after the child closed the pipe instead of timing
out; when a child ignored SIGTERM, timeout cleanup returned while that
descendant was still running.

The runner now reads only when the selector reports pipe readiness, so an
exited parent with an inherited open pipe cannot block past the command
deadline. Timeout/error cleanup targets the fresh process group even after its
leader exits, sends SIGTERM, gives the group a bounded 200 ms grace period, then
sends SIGKILL if any group process remains. It reaps the direct child and also
cleans the invocation group after normal completion. Added a local
`__pycache__/` ignore so the documented Python commands do not leave bytecode
artifacts in the worktree.

Verification after the fix:

- `python3 -m unittest -v` — 13 tests passed, including both regressions.
- `python3 -m py_compile experiments/bot-providers/provider_harness.py experiments/bot-providers/test_provider_harness.py` — passed.
- `git diff --check` — passed.
- `python3 provider_harness.py opus-smoke` — passed; 51 packets, Opus 48 kHz
  stereo, 20 ms frame cadence, 96 kbps CBR. Playback and SFrame decryption
  remain unverified.
- `python3 provider_harness.py doctor` — expected exit 1; Soloist and yt-dlp
  remain missing, while ffmpeg/ffprobe 9.0.2, Node 24.15.0, and pactl
  17.0-98-gb096 are available. Qualification remains unverified.

Full Task 1 remains blocked on the same operator inputs and qualification
matrix above.
