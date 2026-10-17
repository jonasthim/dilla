# Private noise suppression

Implement the user-approved plan from 2026-10-17 on an isolated branch from main.

1. Preserve development checkouts; baseline tests.
2. Build a reproducible comparison harness: current browser+RNNoise, RNNoise alone, DeepFilterNet3, Hush, GTCRN. Pin source/model artifacts, hash outputs, record hardware/browser and settings. Keep experimental assets outside the production build.
3. Common microphone processing: local 48 kHz mono, DeepFilterNet inference in Worker, bounded pooled transferable buffers through AudioWorklet, separate VAD detection with at most 20 ms onset. Mute/PTT independently enforced; flush/reject stale audio on privacy and lifecycle boundaries. Preserve browser AEC/AGC, disable duplicate NS after readiness and restore for fallback.
4. Automatic / Lightweight / Off; report effective processing and fallback. Preserve Off; keep existing On on RNNoise until qualification. Local ten-second in-memory microphone test, capture stopped before playback, disabled during calls, discarded on close.
5. Qualification: at least 60 licensed/consented English/Swedish clips across clean/quiet/onsets/keyboards/fans/dogs/TV/overlap; identical legally obtained Krisp references; five blind listeners, three five-point ratings, no category >0.25 below Krisp, no extra missing onset words. End-to-end added delay target <=60 ms, hard <=80 ms, underruns <0.1% in 30-minute loaded calls with sustained headroom, Chrome/Firefox/Safari/Android/iOS. Failures/uncertainty must be reported. No parity claim without evidence.

Unqualified DeepFilterNet stays experimental. No default migration, proprietary dependency, enrollment, remote processing, model CDN requests, telemetry, server API or encryption changes. Equal-level competing speakers remain a separately reported limitation.
