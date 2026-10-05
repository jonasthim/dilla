# SP-12 and SP-07 — current media call measurements

Date: 2026-10-05. Host: local dev box. Engine: Playwright Chromium 153 with the in-process LiveKit SFU. The source is the passing Chromium `e2e/media/e2ee-call.spec.ts` leg in the first full media-suite run at this tree, plus the independent `e2e/spikes/join-visibility.spec.ts` run. Every latency below is an observation from these runs; acceptance limits are stated separately in protocol/05.

## SP-12 — join visibility

The spike ran **n=20** independent call joins. The interval starts before the delivery-service join request and ends at the existing member's `ParticipantConnected` event. It includes MLS sync, browser page creation and media connection. The joiner-KID interval starts immediately before microphone publication and ends when the existing receiver first reports the authenticated KID; it is a polling upper bound. No test sleep lies inside either measured interval. Percentiles use nearest rank.

| Chromium 153, n=20 | p50 | p95 | p99 |
|---|---:|---:|---:|
| Join request to participant visibility, ms | 2,881 | 2,884 | 2,888 |
| Publish start to first observed authenticated joiner KID, ms | 137 | 141 | 142 |

The KID observations met the protocol/05 acceptance limit in all **20/20** joins. The earlier merge-to-first-frame number included the test's own fixed wait and is superseded by this event-driven run.

## SP-07 — audio across a join Commit

The Chromium three-context call (`n=1` call) reported `concealedSamples: 0` and `jitterBufferEmittedCount` delta **146,880**. Its cumulative `jitterBufferDelay` delta divided by that emitted-sample delta was **30 ms per emitted sample**. The test also required the receiver's microphone sample count to rise across the observation and required authenticated audio and video separately for every participant. The raw cumulative delay is not a per-sample delay.

## Key frames and codec negotiation

The same Chromium call (`n=1`) observed **502 ms** from the joiner's entry to its first decoded video and **0** camera freezes on the Alice-receives-Bob pair it actually asserted. The offer contained **5** H.264 fmtp entries and the answer **4**, each with `packetization-mode=1` and `profile-level-id=42e01f`. The test rejected mode 0 in both descriptions and observed an active H.264 sender with mode 1. This supersedes the pre-`codec-preferences.ts` statement that mode 0 remained in the answer.
