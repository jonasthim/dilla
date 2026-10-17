# Private noise suppression

Implement the user-approved plan from 2026-10-17 on an isolated branch from main.

1. Preserve development checkouts; baseline tests.
2. Build a reproducible comparison harness: current browser+RNNoise, RNNoise alone, DeepFilterNet3, Hush, GTCRN. Pin source/model artifacts, hash outputs, record hardware/browser and settings. Keep experimental assets outside the production build.
3. Common microphone processing: local 48 kHz mono, DeepFilterNet inference in Worker, bounded pooled transferable buffers through AudioWorklet, separate VAD detection with at most 20 ms onset. Mute/PTT independently enforced; flush/reject stale audio on privacy and lifecycle boundaries. Preserve browser AEC/AGC, disable duplicate NS after readiness and restore for fallback.
4. Automatic / Lightweight / Off; report effective processing and fallback. Preserve Off; keep existing On on RNNoise until qualification. Local ten-second in-memory microphone test, capture stopped before playback, disabled during calls, discarded on close.
5. Qualification: at least 60 licensed/consented English/Swedish clips across clean/quiet/onsets/keyboards/fans/dogs/TV/overlap; identical legally obtained Krisp references; five blind listeners, three five-point ratings, no category >0.25 below Krisp, no extra missing onset words. End-to-end added delay target <=60 ms, hard <=80 ms, underruns <0.1% in 30-minute loaded calls with sustained headroom, Chrome/Firefox/Safari/Android/iOS. Failures/uncertainty must be reported. No parity claim without evidence.

Unqualified DeepFilterNet stays experimental. No default migration, proprietary dependency, enrollment, remote processing, model CDN requests, telemetry, server API or encryption changes. Equal-level competing speakers remain a separately reported limitation.

## Branch completion follow-up

The user requires the feature to be complete in this branch, beyond an isolated prototype. Continue the existing implementation with:

1. Reproduce/fix transport underruns; instrument scheduling, delay and bounded state, and correct the test host's audio backend before drawing runtime conclusions.
2. Move the enhanced processor into the shared media implementation, integrate Automatic selection, live fallback/status/mode/PTT, microphone preview and same-origin verified assets. A deliberate evaluation build must run the actual application with enhanced processing; ordinary release builds stay gated until qualification passes. Preserve legacy preferences.
3. Add a qualification gate with verifiable evidence rather than hard-coded permanent disablement. Complete corpus acquisition and paired evaluation tooling; report unavailable matched Krisp/listener evidence honestly.
4. Exercise the integrated enhanced path under encryption and lifecycle transitions, measure actual signal delay, run sustained loaded checks where the environment supports them, and validate default-build asset isolation.
5. Review the completed software, fix important findings, update findings/docs and commit. No release/merge/deploy is requested in this follow-up.

External perceptual and physical-device qualification cannot be manufactured. A working evaluation build is a distinct deliverable from a qualified release; retain both statuses explicitly.

## Latency follow-up

The user explicitly requested a latency fix. Keep this branch and its release gates. Diagnose complete track-to-track delay, fix queue/clock behavior, add reproducible calibrated measurement in actual encrypted calls, review privacy/lifecycle changes and verify regression coverage. Record the measured hard-limit result separately from the 60 ms target and physical-device qualification. No push, merge or release is implied.

Latency follow-up outcome: final Chromium idle/loaded timing runs measured 57.725–75.825 ms, and three 20-second encrypted calls measured 65.625–67.575 ms. The 60 ms target is not consistently met. The final 30-minute call fell back near minute 26, so sustained-runtime qualification failed; a final short stress check also failed on underruns. Keep enhancement experimental and preserve the existing production default. Full evidence and preserved failures are in `experiments/noise/results/FINDINGS.md`.

## Opt-in beta follow-up

The user accepted the proposed opt-in beta and asked to make Automatic available as beta. Implement an explicit `beta` build mode, **Automatic (beta)** in Voice settings, a visible explanation before selection, and active beta status. Keep Lightweight as the default and preserve stored preferences. Retain local assets, existing fallback and the qualified-build gate. Verify settings, actual beta builds, lazy asset requests, encrypted calls, preview, startup fallback and switching back to Lightweight. Record the new implementation identity separately from historical measurements. The user's performance-risk acceptance does not assert qualification or clear the model-license audit. No merge, public release or deployment is requested by this follow-up.
