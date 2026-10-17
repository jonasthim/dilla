# Qualification findings — 2026-10-17

**The feature is integrated into the branch; DeepFilterNet3 remains unqualified for release. No Krisp parity is claimed.** Explicit evaluation builds run the same DeepFilter processor in calls, the local microphone test and the browser harness. Ordinary builds retain the existing Lightweight default and exclude all enhanced assets. A qualified build profile is implemented, but it requires bound, passing measurements and a separate exact-license/lifecycle review.

## Implemented behavior

- Automatic tries the enabled DeepFilter engine, then RNNoise, then browser processing. Lightweight and Off never load model assets. Settings report the effective engine, evaluation state, or fallback reason. Legacy On only maps to Automatic in a qualified build; explicit Off persists.
- Dedicated Worker inference, 48 kHz mono AudioWorklet transport, a four-buffer transferable pool, scheduling headroom and stale-epoch rejection. No SharedArrayBuffer, cross-origin isolation or third-party model loader.
- DeepFilter's state reset was measured at about 304 ms when it rebuilt inference plans. The pinned upstream patch now resets recurrent/session state, FFT overlap and normalization in place; the regression compares five resets against fresh-model output and requires <10 ms on this host.
- Raw-input RNNoise VAD runs separately. The measured 30 ms model delay provides a 20 ms onset allowance without a second output delay. Mute/PTT zero owned PCM buffers and explicitly reset Worker history. Device replacement cannot cancel a requested fallback permanently. Failed fallback is visible and may retry.
- Local microphone recording is capped at ten seconds in memory, stops capture before playback, discards on close, and is disabled during calls. Existing encryption and screen-share processing remain outside the microphone enhancement graph.

## Measurements

The [FLEURS corpus manifest](fleurs-corpus.json) contains 30 English and 30 Swedish attributed CC-BY-4.0 speech clips. [Offline comparisons](offline-fleurs.json) contain **240 actual inference outputs**, with input/model/output hashes and hardware/settings. Average per-clip mean processing times on the Ryzen 7 7800X3D were approximately RNNoise 0.417 ms, DeepFilter 1.132 ms, GTCRN 0.640 ms and native Hush 0.199 ms per frame. These are offline inference measurements, not browser latency or quality scores.

The corpus is a reproducible starting set, not complete qualification: its speech is originally 16 kHz, fan/keyboard noise is synthetic, TV is a speech mix, dog recordings are missing, and onset transcripts still need annotation. It has no matched Krisp references or human listening scores.

The initial Chromium pacing failure was traced to a missing `PULSE_SERVER` environment setting, despite a running PipeWire service. The runner now discovers the existing per-user socket. With proper pacing, Chromium and Firefox run the real graph with output, muted silence and no third-party requests. The previous Firefox-timeout finding is superseded by [the successful Firefox smoke](firefox-deepfilter.json).

The speech raw-to-processed tap measurement originally reported **112.625 ms**. Reusing model lookahead for onset allowance reduced it to **92.625 ms**, with waveform correlation 0.927 in that run. The final reviewed implementation measured **101.375 ms** with correlation **0.925** while other checks were running on the host. The comparable RNNoise/VAD path measured **71.25 ms**. These taps include browser MediaStream buffering, queues, enhancement and VAD; they exclude network and physical playback-device delay. The enhanced path exceeds the **80 ms hard release limit**. Current reruns retain their exact values and implementation fingerprints in [the speech report](chromium-deepfilter-speech-vad.json); no paper latency is substituted.

The final integrated Chromium test passed the actual microphone preview, enhanced engine/evaluation status, and encrypted-call PTT. It observed **0 idle, 24 held and 0 released remote frames**, no third-party requests, 2 underruns across 4,587 transport buffers, and no dropped frames. Its 10.126-second load phase is a smoke check, not duration qualification; see [the final call report](chromium-integrated-call.json).

The [30-minute loaded call](chromium-integrated-call-30min-pre-review.json) completed on the pre-review artifact but **failed enhanced-runtime qualification**: DeepFilter stopped processing after roughly five minutes and the UI reported RNNoise after repeated underruns. The call used two encrypted peers and 6 ms of main-thread work every 16 ms; builds/tests also ran on the host. Metrics were recovered from its Playwright trace. Transport counters continued after fallback and cannot prove 30 minutes of enhanced inference. This artifact has no processor fingerprint, so it cannot qualify the final reviewed implementation; a final long-duration run remains required. The earlier test also left Settings open on assertion failure, which blocked teardown; the final test saves results and closes Settings before asserting.

Linux Playwright WebKit initially lacked ICU74/flite dependencies. Task-local copies from the Ubuntu archive allowed it to launch, without changing host packages. The graph then produced **zero recorded output** in the synthetic test. That is a failed check, not a Safari pass; see [webkit-deepfilter.json](webkit-deepfilter.json). Physical desktop Safari, Android Chrome and iOS Safari remain untested.

## Verification and review

The branch includes regression tests for selection/fallback, jitter, stale output, privacy clearing, PTT, device-change/fallback races, reset correctness, preference migration, model exclusion and evidence binding. Build checks preserve lazy call loading and a single copy of core/RNNoise WASM; the evaluation profile adds one enhanced WASM and content-hashed model/glue plus build identity. Static `.bin` files are served with the expected content type; server APIs and encryption protocols did not change.

A fresh review found three important issues: fallback cancellation across device changes, retained sample/history memory on mute, and qualification combining unrelated evidence. Each was reproduced by a failing regression and corrected. Release qualification now binds corpus IDs, exact input/output hashes, blind keys, candidate engine, model lock and processor implementation. Qualified builds re-read hashed source evidence and recompute the verdict; editing buffering/VAD code invalidates older evidence.

The final follow-up passed **4,922 repository tests**, lint, media/web TypeScript checks and **14 harness tests**. Ordinary and evaluation builds passed their entry-chunk, asset-manifest and Go static-serving checks. The ordinary build contains no enhanced assets; the evaluation build contains one copy of each required WASM. A qualified build is correctly blocked without passing evidence. All **six final Chromium app checks passed**: enhanced preview/encrypted PTT, missing-model fallback and Off asset exclusion, local recording cleanup, mute/deafen, screen/camera sharing, and shared tab audio. The final Firefox processor smoke also passed. Machine-readable results are in [qualification.json](qualification.json).

## Remaining release gates

- Bring complete added delay within 80 ms and qualify sustained runtime on the required physical browser/device matrix.
- Resolve the Linux WebKit zero-output result and test actual Safari/iOS devices.
- Complete natural-noise/full-band/onset corpus coverage, obtain lawful matched Krisp outputs and run the five-listener blind study. Equally loud competing speakers remain a separately reported limitation.
- Establish the exact DeepFilterNet3 weights redistribution grant. The author's paper supports open-source intent, but the checkpoint license question remains unresolved; see [artifact audit](../licenses/README.md).

These gates keep the enhanced default disabled. The evaluation build is usable for testing the implemented feature; it is not a production quality or parity promise. No merge, push, release or deployment was performed.
