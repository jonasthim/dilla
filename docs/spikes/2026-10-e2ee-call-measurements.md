# SP-12 and SP-07 — measured in the three-context E2EE call (task 21)

Date: 2026-10-04. Host: dev box, Playwright 1.63.0 (Chromium 153.0.8010.12), LiveKit v1.13.7 in process. Spec: `e2e/media/e2ee-call.spec.ts`. Values below are the `TASK21_MEASUREMENT` JSON lines from one passing run (`1 passed (18.9s)`).

## SP-12 — join visibility (`sp12-join-visibility.json`)

| Measurement | Value (ms) |
|---|---:|
| `t_pc_minus_t_merge_ms` (dave visible at alice after alice merged the join Commit) | 2460 |
| `t_frame_minus_t_merge_ms` (dave's first decrypted frame at alice after the merge) | 2615 |
| `joiner_kid_decrypt_after_publish_start_ms` (upper bound: poll after publish returned) | 194 |

The KID assertion retained its 2,000 ms bound and passed. This was one join, so it does not establish a p99. The 2,615 ms merge-to-first-frame observation includes starting dave's call and publication; it is distinct from the 2,000 ms per-frame hold.

## SP-07 — audio across the join Commit with the 2000 ms hold (`sp07-audio-across-commit.json`)

| Measurement | Value |
|---|---:|
| `concealedSamples` | 0 |
| `jitterBufferDelay` raw WebRTC stats delta | 3907.2 |

The raw `jitterBufferDelay` delta is implausibly large for this 2-second interval. The test records the browser's value without treating it as a latency bound; the stats collection or unit needs investigation.

## Key frames (`keyframe-latency.json`)

| Measurement | Value |
|---|---:|
| `joiner_time_to_first_frame_ms` | 203 |
| `existing_member_freezes` | 0 |

The browser's active H.264 sender reported `video/H264 level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f`. The SDP offer and answer also listed unused mode-0 payload types. The current client does not remove those from the answer, so the stronger document statement that mode 0 is never negotiated is not established by this run.
