# Private noise evaluation

**Unqualified prototype. No Krisp parity claim. Production retains RNNoise as its default.**

Install repository dependencies with `npm ci`, then run `node experiments/noise/prepare.mjs` (requires git, tar, Rust with wasm32-unknown-unknown, wasm-pack and Python 3). Preparation makes explicit build-time network requests, pins source commits and npm integrity, builds DeepFilterNet WASM locally, and writes `asset-lock.json`. It does not use Mezon's CDN loader. Review generated lock changes when updating any artifact. Exact license findings and release blockers are in `licenses/README.md`.

The experimental directory is outside the application's imports and build root. Hush and GTCRN are comparison engines only. Nothing changes server APIs, SFrame/MLS or screen-share processing. No enrollment, telemetry, audio upload, SharedArrayBuffer, or cross-origin isolation is used.

## Reproducible comparisons

Supply a local corpus JSON with at least 60 distinct, licensed/consented, mono 48 kHz PCM16/float32 WAVs for qualification. Each entry has:

```json
{"clips":[{"id":"sv-onset-01","file":"sv-onset-01.wav","sha256":"64 lowercase hex digits","language":"sv","categories":["quiet","onset","keyboard"],"consent":"Consent record or license reference","reference":{"file":"sv-onset-01-krisp.wav","sha256":"64 lowercase hex digits","inputSha256":"same input hash","version":"exact Krisp/host version","captureSettings":{"sampleRate":48000,"channels":1,"echoCancellation":true,"autoGainControl":true,"noiseSuppression":false},"lawfulUse":"Reference acquisition permission"}}]}
```

Coverage: both English and Swedish; `clean`, `quiet`, `onset`, `keyboard`, `fan`, `dog`, `tv`, `overlap`. Record equally loud competing speakers separately. Supply transcripts for missing-word scoring. Never relabel online demos as matched references.

- `node experiments/noise/compare.mjs corpus.json output-directory`: sends the identical PCM through RNNoise, DeepFilterNet3, GTCRN and Hush; hashes every input, model and output; records CPU, versions, configuration and inference timings. Hush runs locally through ctypes; no Python packages are required. Outputs retain algorithmic delay and 100 ms tail padding. These timings exclude capture, VAD and browser buffering.
- `node experiments/noise/browser-run.mjs chromium current /absolute/input.wav`: current-pipeline browser+RNNoise reference using Chromium's file-backed fake microphone. Use PCM16 input supported by Chromium; same input file/hash for `rnnoise` without browser suppression. Actual capture settings are recorded. The first three seconds are recorded; capture alignment is **unverified**, so manually establish matching onset/alignment before listening qualification. `current` with synthetic input is not a browser-NS baseline.
- `node experiments/noise/browser-run.mjs chromium deepfilter`: runs the real Worker/AudioWorklet graph against a synthetic source, records buffer metrics, verifies nonzero output and zero output while muted, and fails on third-party requests. Also accepts `firefox` and `webkit`; these are local Playwright engines, **not physical Safari, Android or iOS qualification**.
- `npx vite --config experiments/noise/vite.config.ts`: opens the local harness on `http://127.0.0.1:5191`. The synthetic check never opens a microphone.

Production requests browser NS off at initial capture: Chromium 153 retains its initial NS setting despite `applyConstraints`. The common processor verifies the actual settings after startup; browser fallback and Off transitions reopen capture when needed, preserving AEC/AGC and independent mute/PTT gates. A refusal is reported explicitly.

Assets are verified by SHA-256 before inference and served from this origin. Audio crosses the Worker boundary through a four-buffer transferable pool. Epochs reject stale output; capture closes before buffering; reset recreates model state after privacy/device boundaries. VAD sees raw input separately, with a constant 20 ms onset buffer. It never denoises the enhanced output again. Sustained processing overload or repeated underruns downgrades to RNNoise once; it never upgrades again in that session. Full delay includes this queue and model reset/startup; native throughput is not a latency result.

## Blind listening and release evidence

`node experiments/noise/listen.mjs output-directory/report.json blind-directory 42` copies anonymously named samples into a self-contained local page. Keep `blind-directory-key.json` away from listeners. Use different seeds and directories for at least five listeners. Each rates naturalness, reduction and overall quality independently on 1–5 and counts missing words against the transcript. The page saves a local ratings JSON; nothing is sent anywhere. Combine the raw rating arrays and supply a keys JSON of the form `{"listeners":{"alice":{"seed":42,"key":[...]},"bob":{"seed":43,"key":[...]}}}`, using each listener code and its exact generated key object. The qualifier refuses a shared key for multiple listeners. Never predecode or reuse another listener’s randomization.

`node experiments/noise/qualify.mjs corpus.json runtime.json ratings.json blind-key.json qualification.json` validates coverage and paired ratings. It reports category means relative to Krisp and standard errors across listener means; it does not treat individual clips as independent listeners. Proposed threshold: every mean difference >= -0.25, no extra missing words on onset fixtures. Missing evidence is a failure to qualify.

Runtime JSON is an array of records for `desktop-chrome`, `desktop-firefox`, `desktop-safari`, `android-chrome`, `ios-safari`, with `durationSeconds`, `loadedCall`, measured `addedDelayMs`, `underruns`, `buffers`, `p99ProcessingMs`, and `frameMs`. Each must have 1800+ seconds of an actual loaded encrypted call, <0.1% underruns, <=80 ms complete added delay (<=60 ms target), and sustained headroom (the harness uses p99 below 80% of the frame budget). Measure delay with matched capture/output timing including resampling, lookahead, onset and queues; do not enter a paper's model latency as measured end-to-end delay.

The report always requires release review of licenses, reference alignment, uncertainty, onset failures, startup/device/reconnect/background/mute/PTT/teardown stress, screen-share isolation and encrypted-call behavior. There is no automatic production enablement. The unavailable corpus, five listeners, Krisp references and physical browser matrix cannot be supplied by synthetic tests.

Run fast tests with `node --test experiments/noise/test/*.test.mjs` and the repository media/web suites. `results/` contains honest measured smoke results and qualification status. Audio stays in ignored `output/` unless its license/consent explicitly permits a deliberate fixture commit.
