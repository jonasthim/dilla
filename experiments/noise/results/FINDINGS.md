# Qualification findings — 2026-10-17

**The feature is integrated into the branch. Latency improved, but DeepFilterNet3 remains unqualified for release. No Krisp parity is claimed.** Evaluation builds run the shared processor in calls, microphone preview and the browser harness. Ordinary builds keep Lightweight and exclude enhanced assets. Qualified builds require bound runtime/listening evidence and a separate exact-license review.

## Latency follow-up

The latency-tested implementation identity is `1ef805e9f8b00d71c3663aea14f3565921f96552ab5603d06cd839a1794ee61f`. The pinned model assets did not change. The subsequent opt-in beta UI/build changes have a separate [readiness record](beta-readiness.json); these measurements are not relabeled with that implementation's identity.

| Measurement | Result | Interpretation |
|---|---|---|
| [Baseline, six idle/loaded Chromium runs](chromium-track-latency-before.json) | 81.000–85.225 ms | All six exceeded 80 ms. |
| [Final, six idle/loaded Chromium runs](chromium-track-latency.json) | 57.725–75.825 ms | All six passed 80 ms, with zero drops/underruns and sustained inference headroom. |
| [Baseline encrypted call](chromium-call-latency-before.json) | 74.875 ms | Not every baseline call failed. |
| [Final encrypted-call repeats](chromium-call-latency-repeats.json) | 65.625 / 67.025 / 67.575 ms; all three passed with zero drops/underruns | Each result retains settings, windows, counters and build identity. |
| [Final 30-minute encrypted call](chromium-call-latency-30min.json) | Initial enhancement: 64.775 ms; fallback near 26 minutes | **Failed sustained enhanced-runtime qualification.** |

The 60 ms target is not consistently met. These are Linux Chromium measurements on a shared Ryzen 7 7800X3D desktop, not physical-device qualification or every-sample worst-case guarantees. The harness observes raw and outgoing tracks directly, adds no observer AudioContext and subtracts no bypass estimate. It checks a known 40 ms delay before six fresh-browser trials. Each estimate is the worst of three correlated speech windows aligned to median chunk-delivery clocks. Unmeasurable speech windows fail the check. Capture remains 48 kHz mono with AEC/AGC enabled and browser suppression disabled.

The long call ran for 1,800.032 seconds with two encrypted peers and 6 ms of main-thread work every 16 ms. DeepFilter processed 157,595 frames before repeated capture losses triggered the visible RNNoise fallback. Its final counters were 290 underrun quanta across 591,139 buffers (about 0.049%), 103 drops, and a conservative p99 inference upper bound of 3.5 ms. Three consecutive unhealthy intervals caused the downgrade even though the cumulative underrun fraction was below 0.1%. Fresh authenticated audio still reached the receiver afterward. End-of-call windows observe fallback routing and **cannot establish enhanced-path latency**; the complete enhanced delay verdict is null. A call lasting 30 minutes does not prove 30 minutes of enhanced processing.

Failures are retained: a [short call with insufficient correlation](chromium-call-latency-short-unmeasured.json) had an unmeasurable middle speech window; another [short call stalled](chromium-integrated-call-short-stall.json), with eight underrun quanta and two drops. The regression harness's zero-drop assertion is stricter than the planned duration-based underrun threshold. No threshold was relaxed to turn these runs into passes.

The alternate AudioWorklet input path also remains unqualified. Its [encrypted-call comparison](chromium-call-latency-worklet-comparison.json) had two measured passes (76.5 and 72.8 ms), one insufficient-correlation failure, and no drops. Its [standalone comparison](chromium-track-latency-worklet-comparison.json) failed three trials with underruns and fallback. Direct capture remains selected where the actual browser probe supports it.

Earlier raw/output tap reports reached 112.625, 92.625 and finally [101.375 ms](chromium-deepfilter-speech-vad.json). Those measurements added an observer AudioContext and are not the same boundary as the direct-track before/after comparison above. The [older 30-minute call](chromium-integrated-call-30min-pre-review.json) fell back after roughly five minutes on a pre-review implementation; it does not qualify this implementation either.

## Implemented behavior

- Automatic tries enabled DeepFilter, RNNoise, then browser suppression, with visible effective status and fallback reasons. Legacy On migrates only in qualified builds; explicit Off persists. Off preserves echo cancellation. Screen-share audio and encryption remain outside enhancement.
- Inference runs in a dedicated Worker. Supported browsers transfer the microphone readable stream to it; six pooled PCM buffers travel directly between Worker and AudioWorklet. Other browsers use four-buffer AudioWorklet capture. No SharedArrayBuffer or new isolation headers are required.
- Output uses the audio-device clock. Fixed playout timelines discard late samples instead of accumulating delay after stalls. Direct output starts with three frames plus two render quanta; legacy transport includes the 480/128 capture-quantum remainder. Synthetic priming finishes before live capture and clears all model/detector history afterward.
- Mute/PTT close output independently, replace capture privacy epochs and reject stale output. Every epoch owns a fresh track clone. Cancellation acknowledgement and a 200 ms stop bound prevent retained capture if a Worker hangs. Capture gaps and clock rebases clear delayed model history; stale loss notices cannot trigger fallback in a new epoch.
- Raw-input RNNoise VAD remains separate from enhancement. DeepFilter's measured 30 ms signal delay provides the 20 ms onset allowance. Reset clears recurrent/session state, FFT overlap and normalization in place, without rebuilding inference plans. Actual WASM tests compare reset and primed output against a fresh model.
- Microphone preview records at most ten seconds in memory, stops capture before playback, discards when closed, and is disabled during calls. Assets are pinned, verified and served from the application's origin, with no model CDN, licensing call, audio upload or telemetry.

## Corpus and quality

The [FLEURS manifest](fleurs-corpus.json) contains 30 English and 30 Swedish attributed CC-BY-4.0 clips. [Offline comparisons](offline-fleurs.json) record 240 actual RNNoise, DeepFilter, GTCRN and native Hush outputs with hashes and settings. Offline inference timings are not browser latency or listening scores.

This starter corpus is incomplete: speech originates at 16 kHz, fan/keyboard noises are synthetic, TV is a speech mix, dogs are missing and onset transcripts need annotation. No matched lawful Krisp outputs or five-listener blind study exist. Equally loud competing speakers remain a separately reported limitation.

Linux Playwright WebKit produced zero output in the [synthetic check](webkit-deepfilter.json), even after task-local libraries allowed it to launch. It is not a Safari pass. Physical desktop Safari, Android Chrome and iOS Safari remain untested.

## Verification and review

Regression coverage includes fixed delay after stalls, 480/128 scheduling, bounded ownership, privacy clearing, PTT/device changes, transferred-stream cancellation, clone cleanup, clock rebases and stale loss notifications. Reviews found and corrected lifecycle issues; no important findings remained in the final scoped code review. Release evidence binds input/output hashes, blind keys, candidate, model lock and processor identity. Changing processor code invalidates earlier qualification.

Final verification passed 4,943 repository Vitest tests, eight fixture tests, 18 noise-harness tests, lint, documentation/copy/CI guards, and media/web TypeScript checks. Default and evaluation builds passed asset-manifest, entry-isolation and Go static-serving checks. The qualified build correctly refused the missing release qualification evidence.

The final Chromium application suite passed six of seven checks. Its separate latency check measured 72.625 ms. The enhanced preview/PTT/load check failed with 12 underrun quanta across 4,597 buffers (0.261%), four drops, and a p99 inference upper bound of 5 ms. DeepFilter remained active; authenticated PTT frames were zero while idle, 37 while held and zero after release, with no third-party requests. This failure is retained in [the final integrated-call report](chromium-integrated-call.json). Firefox's final output/mute/same-origin smoke check passed; it does not qualify physical-device latency or endurance.

## Remaining release gates

- Meet sustained enhanced-runtime qualification and the delay limit across the required physical browser/device matrix; the 60 ms target is still open.
- Resolve Linux WebKit's zero output and test actual Safari/iOS devices.
- Complete natural-noise/full-band/onset coverage, lawful matched Krisp references and the five-listener blind study.
- Establish the exact DeepFilterNet3 weights redistribution grant; see the [artifact audit](../licenses/README.md).

The enhanced default stayed disabled at the end of latency qualification. No merge, push, release or deployment was performed in that stage.

## Opt-in beta follow-up

The owner accepted offering Automatic as an opt-in beta while keeping Lightweight as the default. The branch adds an explicit beta build, an **Automatic (beta)** label, a pre-selection explanation of glitches/fallback, and active beta status. Existing preferences, one-way fallback, qualification checks and all failed measurements are preserved. This is a rollout decision, not new runtime or listening qualification. At the local-beta stage the release workflow remained unchanged. See the [beta instructions](../README.md#opt-in-beta).

The owner subsequently explicitly requested publication. Release preparation pins the same evaluated runtime bytes in `third_party/noise/`, selects beta for explicit noise-beta tags, and publishes the [known limitations and unresolved exact-weights grant](../../../docs/deploy/releases/v0.1.0-noise-beta.1.md). Publication authorization does not establish upstream license clearance or change any failed qualification result. Historical readiness records retain their original implementation identity and stage-specific publication status.
