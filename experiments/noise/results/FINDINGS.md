# Qualification findings — 2026-10-17

**DeepFilterNet3 is not qualified. No Krisp parity claim is supported.** The production default remains Lightweight (the existing RNNoise), and old On preferences are not migrated to Automatic. Automatic currently reports that the enhanced engine is unqualified and uses the same fallback chain beginning with RNNoise. No experimental model or WASM is shipped in the web build.

## Evidence obtained

- Real offline inference completed for RNNoise, DeepFilterNet3, GTCRN and native Hush against the same one-second synthesized signal. Exact artifact/input/output hashes, settings and CPU timings are in [offline-synthetic.json](offline-synthetic.json). This is functionality evidence, not listening evidence. In particular, Hush's native timings cannot predict browser performance.
- The real DeepFilterNet Worker/AudioWorklet graph ran in Chromium 153 on Linux / Ryzen 7 7800X3D. It produced nonzero output, zero output while muted, no third-party requests and no page errors. It recorded **19 underrun quanta out of 1,153 (about 1.65%)**, above the <0.1% release gate. This three-second synthetic run includes startup and is not a loaded call. Complete added delay remains unmeasured. See [chromium-deepfilter.json](chromium-deepfilter.json).
- Firefox's headless audio clock timed out on this host, which has no PulseAudio service. WebKit could not launch because libicu74/libflite1 are unavailable. These failures are recorded, not counted as platform passes. Physical Safari, Android Chrome and iOS Safari remain untested.
- Chromium's `applyConstraints({noiseSuppression:false})` resolved while `getSettings()` remained true; an exact constraint was refused. Concurrent recapture with only NS exact could drop AEC/AGC, and demanding all desired constraints was refused. Production therefore requests NS off when acquiring neural input, verifies actual settings after initialization, and restarts capture for browser fallback or Off when needed. AEC and AGC remain requested. The source is never sent through two denoisers.

## Integration verification

- Repository `npm test`: **4,905 passing tests** across all six suites; lint and repository guards passed. Media, web and UI TypeScript checks passed.
- Harness: **8 passing tests**, including actual inference through comparison → blind-page preparation with a synthetic reference fixture, per-listener randomization decoding, and rejection of duplicated recordings as a 60-clip corpus. The synthetic reference is explicitly not a Krisp measurement.
- Chromium media: four tests passed. The common processor reported RNNoise with browser NS off; encrypted frames continued after processor attachment and microphone restart, with zero AEAD failures. Worklet CSP tests passed.
- Chromium application: mute/deafen/PTT, two-browser voice, screen/camera share and shared-tab audio passed. PTT observed 0 idle, 143 held and 0 released remote frames over 100-frame comparison windows.
- Settings passed accessibility checks across three themes and at 360 px, with no CSP violations. A real local microphone recording stopped all capture before playback and disappeared when discarded; its control was disabled during calls. Documentation screenshots were recaptured and inspected at desktop/phone sizes.
- Production Vite build passed its lazy-entry/single-WASM checks; an artifact hash audit found no experimental model/WASM in `dist`. RNNoise assets remain the existing same-origin dependency.
- A fresh-context review found four important issues (held PTT/mode replay, recorder deadlines, reference filename copying, mixed-listener attribution). Each was reproduced with a failing regression test, fixed, and verified. No deferred review findings remain.

## Release gates still open

No licensed/consented speech corpus, matched lawful Krisp outputs, five-listener ratings or dedicated onset word-count results were supplied. The 60-clip English/Swedish coverage requirement therefore remains unmet. No 30-minute loaded-call matrix, complete latency measurement or equal-level competing-speaker evaluation was performed. Native throughput and synthetic output do not substitute for these measurements.

Exact DeepFilterNet3 and Hush weight redistribution grants require clarification separately from wrapper/code licenses; see [the artifact audit](../licenses/README.md). Assets are ignored local development files. No external model loader, licensing call, telemetry or audio upload was added. SFrame/MLS, server APIs and screen-share processing were unchanged.

The machine-readable [qualification.json](qualification.json) keeps qualification and parity false. Before any enhanced default: fix underruns, establish exact weight licensing, collect consented clips and matching references, run the five-listener study and full physical runtime/lifecycle matrix, then review the evidence. The experiment has no automatic production-enablement switch.

## Implementation decisions and limits

- An isolated cache worktree preserves existing development checkouts. Nothing is merged or deployed.
- Missing real-world evidence fails qualification rather than weakening thresholds; the cost is deferred enhanced default availability.
- Model grants are treated conservatively; clearer upstream licensing could remove that blocker without changing inference code.
- Sustained headroom is operationalized as p99 inference below 80% of a frame budget. This is an additional conservative criterion, not proof of total latency.
- Off preserves the application's existing open-microphone VAD behavior, still subject to mute/PTT. Fallback reports detector unavailability; no unqualified detector is substituted.
- This host's core WASM optimizer rejected bulk-memory instructions, so the existing core was built with `--no-opt` for local validation. Source/build dependencies were not changed; optimized release validation still belongs in CI.
- Browser NS must be selected at initial acquisition on Chromium; readiness verifies the observed setting. Audio may be unenhanced briefly during startup; capture remains subject to independent privacy gates. Failed constraint/restart requests remain visible as fallback or an observed browser-setting warning.
- Reviewer-declined perceptual quality, physical-platform runtime and exact model licensing remain explicit release blockers. Encrypted-call and screen-share concerns were resolved with the integration tests above; those checks do not establish the missing full stress matrix.
