# SP-02 key-frame recovery: hold 2000 ms / 256 frames kept; sendKeyFrameRequest() after a drop on the script path, repeated every 500 ms until a key frame passes

Date: 2026-10-04. Host: dev box (Linux x86-64, loopback only), Playwright 1.63.0, Chromium 153.0.8010.12, Firefox 155.0,
LiveKit v1.13.7 in process (`dilla-testhost -sfu`), livekit-client 2.22.3 (UMD), VP8 camera 320×240 at 30 fps, single
layer, `GOMAXPROCS=4`. Spec: `e2e/spikes/keyframe-recovery.spec.ts`.

Every number below was measured on this host. The pre-written expectation held for the hold and for the Chromium
3 s bound. It did **not** hold for the request rule: a single `sendKeyFrameRequest()` is lost whenever another
receiver's PLI went upstream less than 500 ms earlier, so the rule becomes "repeat every 500 ms until a key frame
passes" (section 3, decision item 2).

**Runs.** The tables quote these runs; all their raw lines are at the end.

- **Run 1**: a full run of the committed spec, `5 passed`, `5 skipped` (5.5 min).
- **Run 2**: the drop leg alone (`-g "chromium streams: one receiver"`), committed spec, `1 passed`, `1 skipped`.
- **Earlier runs**:
  - (a) The first full run used the brief's spec unchanged, and its drop test failed the rig sanity assertion.
    Its drop and hold series started at the moment the mode was switched on. They therefore held no "last decode
    before", and the hold's decode gap left out the hold itself (51–101 ms for 0.5–2 s holds). That is why
    the pre-roll below was added. Its PLI times and all of its script-path numbers are valid. They agree with
    run 1.
  - (b) A second full run on the committed spec, except that the resubscribe record had no attach log.
  - (c) A resubscribe-only run on the committed spec.
  - Runs (b) and (c) agree with run 1 within the ranges quoted below.

**Spec changes from the brief.** None of them changes the rig. The rig section is byte-identical to
`e2e/spikes/transform-api.spec.ts`.

- `HARNESS` is `http://127.0.0.1:5179/`, and the import is `../media/support/lk.ts`, as in SP-01.
- The drop and hold legs start sampling `PRE_ROLL_MS = 500` ms before the mode switch.
- Hold rows also record `framesHeld`, `framesDecodedInWindow` and `windowMs`.
- `kfrTrials` takes `repeatMs`, and each trial records its `requests`.
  - The Firefox test runs a third set, `behindRecentPliRepeat500`, and its timeout rose from 360 s to 480 s.
- The resubscribe record also carries attach calls and worker retargets per rep, plus B's attach log.

Playwright clears `e2e/test-results/` at the start of every run, so each run's JSON was copied aside before the next
one ran.

## Question

When an epoch change makes a receiver drop video frames, how long until it decodes again on each path, and does
holding the frames and releasing them in order avoid the key frame altogether? (spec L500, DEV-21, gap G2.)

## 1. `createEncodedStreams`, a receiver drops everything for 2.5 s

All times are in ms from the moment the drop was switched on. Samples are taken every 100 ms, which sets the
resolution of the decode columns.

| run | receivers dropping | last decode before (ms) | first receiver PLI (ms) | PLI after last decode (ms) | publisher key frame (ms) | first decode after (ms) | freeze (ms) | receiver PLIs | publisher PLIs |
|---|---|---|---|---|---|---|---|---|---|
| 1 | B | 4 | 3016 | 3012 | 3028 | 3016 | 3012 | 1 | 1 |
| 2 | B | 3 | 3016 | 3013 | 3024 | 3116 | 3113 | 1 | 1 |
| 1 | B and C (B's row) | 3 | 3014 | 3011 | 3014 | 3114 | 3111 | 1 | 1 |
| 1 | B and C (C's row) | 4 | 3014 | 3010 | 3014 | 3114 | 3110 | 1 | 1 |
| 2 | B and C (B's row) | 3 | 3016 | 3013 | 3024 | 3116 | 3113 | 1 | 1 |
| 2 | B and C (C's row) | 4 | 3016 | 3012 | 3024 | 3116 | 3112 | 1 | 1 |

Expected from source (G2 E4): the first PLI ≈ 3.0 s after the last decoded frame, then one key frame within about
one RTT plus one frame interval. **Measured:** the first receiver PLI came 3010–3013 ms after the last decoded frame
in all six rows, and also in earlier run (b): 3011, 3012 and 3010. The publisher counted its key frame in the same or
the next sample, and the receiver decoded again in the next 100 ms sample, so the freeze was 3012–3113 ms. In run 1's
one-receiver row the decode came within the same sample interval as the PLI.

With two receivers dropping, both of them sent their PLI in the same sample (their last decoded frame was the same
one). The publisher counted **one** PLI and encoded **one** key frame, and both receivers decoded again in the same
sample. Fewer publisher PLIs than receiver PLIs, as expected. The SFU's metric could not tell whether LiveKit's
500 ms layer-0 throttle or its once-per-compound-packet rule dropped the second PLI (see below), so that cause is
not established here.

`livekit_pli_total` before / after: `unavailable (HTTP 401)` / `unavailable (HTTP 401)`. The test host serves
`/metrics`, but guards it with a random scrape token nobody holds (`scrapeToken` in `internal/dillad/server.go`). The
publisher's `outbound-rtp.pliCount` is the same quantity after the SFU throttle, and the tables use it.

Receiver-side key frames seen by the worker vs publisher `keyFramesEncoded`: 4 vs 5 over the whole test in runs 1
and 2 (and in earlier run (b)). An inference, not traced:
- The publisher's 5 are its first key frame, two new-subscription key frames (B and C) and the two recovery key
  frames.
- B's 4 are the same set without the key frame from before it subscribed.

G1's unexplained receive-side surplus (15–37 vs 1–2) is **not reproduced** with the attach at `MediaTrackAdded`. G1's
late-attach rig was not re-run, so that case stays open. dilla never attaches late (SP-01).

## 2. `createEncodedStreams`, hold then release in order

Run 1. Samples are taken every 50 ms. The decode gap is measured across the whole window, including the 500 ms
before the hold.

| hold (ms) | receiver PLIs | publisher key frames | longest decode gap (ms) | freeze (ms) |
|---|---|---|---|---|
| 500 | 0 | 0 | 503 | 503 |
| 1000 | 0 | 0 | 1006 | 1006 |
| 1500 | 0 | 0 | 1509 | 1509 |
| 2000 | 0 | 0 | 2012 | 2012 |

Criterion: a hold length passes when it causes no receiver PLI and no publisher key frame, and the longest decode
gap is at most the hold plus 200 ms. **All four pass.** Earlier run (b) gave the same gaps (503, 1006, 1509 and
2012) and also had 0 PLIs and 0 key frames.

The video `max_age_ms` is the largest passing hold: **2000**. This is the largest hold tested; longer holds were not
tried.

The released burst was decoded, not discarded. The worker held 13, 30, 45 and 59 frames. The decoder counted 117,
133, 149 and 164 frames over windows of 3975, 4478, 4982 and 5487 ms, that is 29.4–29.9 fps across each window
including the hold. G2's watch item, libwebrtc dropping a late burst (`FrameHasBadRenderTiming`), was not observed
up to 2 s.

## 3. Script transform, drop 500 ms then `sendKeyFrameRequest()`

Run 1, 20 trials per set. Latencies are in ms from the `sendKeyFrameRequest()` call.
- Key frame decoded: B's `inbound-rtp.keyFramesDecoded` rose.
- Publisher PLI: the Chromium publisher's `outbound-rtp.pliCount` rose.

The two pages are polled together about every 20 ms. The publisher's counter sometimes lags the receiver's by one
poll, so the key-frame column is the latency figure.

| path | set | key frame decoded p50 / p90 / max (ms) | publisher PLI p50 / p90 / max (ms) | missing (of 20) | resolved / rejected |
|---|---|---|---|---|---|
| Firefox 155 receiver, Chromium publisher | plain | 28 / 52 / 52 | 56 / 74 / 75 | 0 | 60 / 0 |
| Firefox 155 receiver, Chromium publisher | behind a PLI 250 ms earlier | 2471 / 2487 / 2495 | 2464 / 2495 / 2509 | 0 | 60 / 0 |
| Firefox 155 receiver, Chromium publisher | behind a PLI 250 ms earlier, re-sent every 500 ms | 536 / 561 / 563 | 553 / 561 / 563 | 0 | 120 / 0 (2 requests in every trial) |
| Chromium 153 script under the flag | plain | 69 / 71 / 90 | 69 / 71 / 72 | 0 | 20 / 0 |

The third row is not in the brief. It was added after the second row's result, so that the corrected rule is
measured and not only proposed. Earlier runs (a) and (b) agree:
- plain Firefox p50 49 and 28
- behind a PLI p50 2479 and 2473
- re-sent every 500 ms (run (b) only) p50 535
- Chromium script p50 53 and 69

**Resolved counts.** Every Firefox call resolved 3 times, so B's worker held 3 video receive transformers. Chromium
resolved once per call. Nothing was rejected. Which Firefox transformer carries A's camera is not logged by the rig.
Per G2 E5, a detached transformer resolves without sending; that is Chromium's source, and Firefox's was not read.

**Behind a recent PLI.** Without the repeat, one request costs a 3 s freeze. The sequence in each trial:
- C's request goes out 300 ms into B's 500 ms drop. It passes the SFU, and the key frame it causes reaches B while
  B is still dropping.
- B's own request goes out 250 ms after C's. It falls inside LiveKit's 500 ms layer-0 PLI throttle and never
  reaches the publisher: the publisher's `pliCount` did not move.
- B then waits for its own decodable-frame timeout. The key frame came 2.45–2.50 s after the request, about 3.0 s
  after B's drop began. That is the same 3 s timeout as Chromium's (an inference from the timing; Firefox's
  libwebrtc source was not read).

At an epoch change, receivers lose and regain the key at slightly different moments. Another receiver's PLI inside
the throttle window is therefore the ordinary case, not an edge case. Re-sending after 500 ms got past the throttle
in every trial, with key frames decoded at p50 536 ms.

## 4. Unsubscribe / resubscribe (`createEncodedStreams`)

Run 1. Times are in ms from `setSubscribed(true)`, sampled every 50 ms for 4 s.

| rep | first decode (ms) | PLI times (ms) | median PLI interval (ms) | classification |
|---|---|---|---|---|
| 1 | 60 | none | n/a | no PLI before decoding |
| 2 | 106 | none | n/a | no PLI before decoding |
| 3 | 109 | none | n/a | no PLI before decoding |

The first decodes in earlier runs (a), (b) and (c) were 109, 56, 61; 59, 56, 117; and 107, 115, 115 ms, again with
no receiver PLI. So in all 12 resubscriptions (run 1 and runs (a)–(c)), B decoded within 56–117 ms and its
`inbound-rtp.pliCount` never moved. The SFU's own
key-frame request on a new subscription (SRV 62) delivered a key frame before libwebrtc's 200 ms timer could fire.
Neither cadence the brief's classification looks for, "fresh 200 ms" or "reused 3 s", ever showed up.

Attach log (run 1, identical in run (c)):
- The first resubscription brought two **new** video receivers and three new audio receivers (a fresh
  `createEncodedStreams` each) and re-delivered `MediaTrackAdded` on the original video receiver.
- From the second resubscription on, every `MediaTrackAdded` was a re-delivery on an existing receiver. There
  were 6 per resubscription, 3 video and 3 audio, and the worker counted them as retargets: 1, 7 and 13 in total.
- So from rep 2 on, the receivers were reused. Whether libwebrtc built a new receive stream behind a reused
  receiver (for example, for a new SSRC) was not checked.

## Decision task 17 consumes

1. Hold: video `max_age_ms` = 2000 (from section 2; 2000 expected), `max_frames` = 256 (at 30 fps 256 frames
   is 8.5 s, so age binds for video; at 50 fps Opus 2000 ms is 100 frames). Task 17's `HOLD_MAX_AGE_MS` and
   `HOLD_MAX_FRAMES` carry these values; audio keeps the same FIFO until SP-07 (task 21) measures otherwise.
2. Script path: call `sendKeyFrameRequest()` after a decrypt-related video drop, and **repeat it every
   `KEY_FRAME_REQUEST_INTERVAL_MS` = 500 ms on that track until a key frame passes the worker on that track**,
   i.e. until the worker enqueues a decrypted key frame. Never request for `sif` or `noneFlagged` drops.
   **Changed:** "once after a drop" is contradicted by the numbers.
   - A single request recovers in p50 28 ms (Firefox) or 69 ms (Chromium script under the flag).
   - But behind another receiver's PLI less than 500 ms old it is dropped by the SFU, and recovery falls back to
     the receiver's own 3 s timeout: p50 2471 ms after the request.
   - Re-sending every 500 ms recovered at p50 536 ms, max 563 ms, with 2 requests per trial.
   - The interval stays 500 ms, LiveKit's layer-0 throttle. For simulcast layers 1–2 (1 s throttle), the second
     repeat passes, so recovery is bounded by about 1 s plus one round trip. This is derived, not measured: the
     rig has one layer.
   - The stop condition, a key frame enqueued by the worker, is the worker-side counterpart of the
     `keyFramesDecoded` rise this spike measured with getStats. That equivalence is an inference.
3. protocol/05 § Key frames states the following.
   - Held frames need no key frame (measured up to 2000 ms).
   - On Chromium's `createEncodedStreams` path, a dropping receiver freezes until libwebrtc's own PLI, measured
     here at 3010–3013 ms after the last decoded frame (source: 3 s), with decoding back after 3.01–3.11 s.
   - Each PLI is subject to the SFU's 500 ms / 1 s per-layer throttle. Two receivers dropping together sent 2 PLIs;
     1 reached the publisher, and its one key frame recovered both.
   - On the script path, one request that the throttle eats costs the same 3 s, hence item 2's repeat.
   - "A fresh receive stream requests every 200 ms": **section 4 showed neither cadence**. On a resubscription the
     SFU's own request delivered a key frame within 56–117 ms with no receiver PLI. protocol/05 should state that
     measured bound for a resubscription. The 200 ms cadence is source-derived (G2 E4) and was never observed here.

Not decided here: a sender-side workaround (for example, the spec's `replaceTrack`). The only measured gap is the
3.0–3.1 s freeze of a Chromium `createEncodedStreams` receiver that drops, which happens only when the hold does
not cover the key's arrival. No sender-side variant was run.

## Raw output

```
# run 1: full run of the committed spec
SPIKE keyframe-recovery.chromium-drop {"browser":"153.0.8010.12","oneReceiver":{"lastDecodeBeforeMs":4,"firstReceiverPliMs":3016,"pliAfterLastDecodeMs":3012,"publisherKeyFrameMs":3028,"firstDecodeAfterMs":3016,"freezeMs":3012,"receiverPlis":1,"publisherPlis":1,"publisherKeyFrames":1},"twoReceivers":{"B":{"lastDecodeBeforeMs":3,"firstReceiverPliMs":3014,"pliAfterLastDecodeMs":3011,"publisherKeyFrameMs":3014,"firstDecodeAfterMs":3114,"freezeMs":3111,"receiverPlis":1,"publisherPlis":1,"publisherKeyFrames":1},"C":{"lastDecodeBeforeMs":4,"firstReceiverPliMs":3014,"pliAfterLastDecodeMs":3010,"publisherKeyFrameMs":3014,"firstDecodeAfterMs":3114,"freezeMs":3110,"receiverPlis":1,"publisherPlis":1,"publisherKeyFrames":1}},"livekitPliTotal":{"before":"unavailable (HTTP 401)","after":"unavailable (HTTP 401)"},"keyFramesSeenByReceiverWorker":4,"keyFramesEncodedByPublisher":5}
SPIKE keyframe-recovery.chromium-hold {"browser":"153.0.8010.12","rows":[{"holdMs":500,"receiverPlis":0,"publisherKeyFrames":0,"maxDecodeGapMs":503,"freezeMs":503,"framesHeld":13,"framesDecodedInWindow":117,"windowMs":3975},{"holdMs":1000,"receiverPlis":0,"publisherKeyFrames":0,"maxDecodeGapMs":1006,"freezeMs":1006,"framesHeld":30,"framesDecodedInWindow":133,"windowMs":4478},{"holdMs":1500,"receiverPlis":0,"publisherKeyFrames":0,"maxDecodeGapMs":1509,"freezeMs":1509,"framesHeld":45,"framesDecodedInWindow":149,"windowMs":4982},{"holdMs":2000,"receiverPlis":0,"publisherKeyFrames":0,"maxDecodeGapMs":2012,"freezeMs":2012,"framesHeld":59,"framesDecodedInWindow":164,"windowMs":5487}],"held":147,"released":147}
SPIKE keyframe-recovery.chromium-script {"browser":"153.0.8010.12","plain":{"trials":[{"keyFrameDecodedMs":69,"publisherPliMs":69,"requests":1},{"keyFrameDecodedMs":71,"publisherPliMs":71,"requests":1},{"keyFrameDecodedMs":69,"publisherPliMs":69,"requests":1},{"keyFrameDecodedMs":51,"publisherPliMs":51,"requests":1},{"keyFrameDecodedMs":69,"publisherPliMs":69,"requests":1},{"keyFrameDecodedMs":68,"publisherPliMs":68,"requests":1},{"keyFrameDecodedMs":70,"publisherPliMs":70,"requests":1},{"keyFrameDecodedMs":70,"publisherPliMs":70,"requests":1},{"keyFrameDecodedMs":68,"publisherPliMs":68,"requests":1},{"keyFrameDecodedMs":67,"publisherPliMs":67,"requests":1},{"keyFrameDecodedMs":69,"publisherPliMs":69,"requests":1},{"keyFrameDecodedMs":69,"publisherPliMs":69,"requests":1},{"keyFrameDecodedMs":71,"publisherPliMs":71,"requests":1},{"keyFrameDecodedMs":68,"publisherPliMs":68,"requests":1},{"keyFrameDecodedMs":71,"publisherPliMs":71,"requests":1},{"keyFrameDecodedMs":50,"publisherPliMs":72,"requests":1},{"keyFrameDecodedMs":69,"publisherPliMs":69,"requests":1},{"keyFrameDecodedMs":90,"publisherPliMs":68,"requests":1},{"keyFrameDecodedMs":68,"publisherPliMs":68,"requests":1},{"keyFrameDecodedMs":68,"publisherPliMs":68,"requests":1}],"keyFrameDecoded":{"n":20,"missing":0,"p50":69,"p90":71,"max":90},"publisherPli":{"n":20,"missing":0,"p50":69,"p90":71,"max":72},"sendKeyFrameRequestResolved":20,"sendKeyFrameRequestRejected":[]}}
SPIKE keyframe-recovery.chromium-resubscribe {"browser":"153.0.8010.12","reps":[{"decodeVideoAttachCalls":4,"workerRetargets":1,"firstDecodeMs":60,"pliTimesMs":[],"medianPliIntervalMs":null,"classification":"no PLI before decoding"},{"decodeVideoAttachCalls":7,"workerRetargets":7,"firstDecodeMs":106,"pliTimesMs":[],"medianPliIntervalMs":null,"classification":"no PLI before decoding"},{"decodeVideoAttachCalls":10,"workerRetargets":13,"firstDecodeMs":109,"pliTimesMs":[],"medianPliIntervalMs":null,"classification":"no PLI before decoding"}],"attachLog":["decode/video/995065b4-5005-4026-be13-da53f62259f2","decode/audio/6142ae80-9b59-4ac9-8530-95fb14dd1d56","decode/audio/c7490605-4b7f-4c66-863c-f4ad0ba18a56","decode/audio/68631904-6c5e-4de8-a3bf-ddb764837b9b","decode/video/38a95f2a-6b0b-4cc0-b61d-9e3a6df0f183","decode/video/2b0f5c70-0cfe-4dc1-af7a-29f4f93bb61b","decode/video/995065b4-5005-4026-be13-da53f62259f2","decode/audio/6142ae80-9b59-4ac9-8530-95fb14dd1d56","decode/audio/c7490605-4b7f-4c66-863c-f4ad0ba18a56","decode/audio/68631904-6c5e-4de8-a3bf-ddb764837b9b","decode/video/38a95f2a-6b0b-4cc0-b61d-9e3a6df0f183","decode/video/2b0f5c70-0cfe-4dc1-af7a-29f4f93bb61b","decode/video/995065b4-5005-4026-be13-da53f62259f2","decode/audio/6142ae80-9b59-4ac9-8530-95fb14dd1d56","decode/audio/c7490605-4b7f-4c66-863c-f4ad0ba18a56","decode/audio/68631904-6c5e-4de8-a3bf-ddb764837b9b","decode/video/38a95f2a-6b0b-4cc0-b61d-9e3a6df0f183","decode/video/2b0f5c70-0cfe-4dc1-af7a-29f4f93bb61b","decode/video/995065b4-5005-4026-be13-da53f62259f2"]}
SPIKE keyframe-recovery.firefox-script {"chromium":"153.0.8010.12","firefox":"155.0","plain":{"trials":[{"keyFrameDecodedMs":27,"publisherPliMs":74,"requests":1},{"keyFrameDecodedMs":28,"publisherPliMs":52,"requests":1},{"keyFrameDecodedMs":32,"publisherPliMs":56,"requests":1},{"keyFrameDecodedMs":27,"publisherPliMs":75,"requests":1},{"keyFrameDecodedMs":27,"publisherPliMs":74,"requests":1},{"keyFrameDecodedMs":27,"publisherPliMs":50,"requests":1},{"keyFrameDecodedMs":28,"publisherPliMs":51,"requests":1},{"keyFrameDecodedMs":51,"publisherPliMs":51,"requests":1},{"keyFrameDecodedMs":52,"publisherPliMs":52,"requests":1},{"keyFrameDecodedMs":51,"publisherPliMs":51,"requests":1},{"keyFrameDecodedMs":27,"publisherPliMs":73,"requests":1},{"keyFrameDecodedMs":27,"publisherPliMs":52,"requests":1},{"keyFrameDecodedMs":49,"publisherPliMs":72,"requests":1},{"keyFrameDecodedMs":27,"publisherPliMs":74,"requests":1},{"keyFrameDecodedMs":28,"publisherPliMs":51,"requests":1},{"keyFrameDecodedMs":52,"publisherPliMs":52,"requests":1},{"keyFrameDecodedMs":51,"publisherPliMs":51,"requests":1},{"keyFrameDecodedMs":50,"publisherPliMs":74,"requests":1},{"keyFrameDecodedMs":25,"publisherPliMs":72,"requests":1},{"keyFrameDecodedMs":49,"publisherPliMs":72,"requests":1}],"keyFrameDecoded":{"n":20,"missing":0,"p50":28,"p90":52,"max":52},"publisherPli":{"n":20,"missing":0,"p50":56,"p90":74,"max":75},"sendKeyFrameRequestResolved":60,"sendKeyFrameRequestRejected":[]},"behindRecentPli":{"trials":[{"keyFrameDecodedMs":2465,"publisherPliMs":2442,"requests":1},{"keyFrameDecodedMs":2486,"publisherPliMs":2464,"requests":1},{"keyFrameDecodedMs":2480,"publisherPliMs":2458,"requests":1},{"keyFrameDecodedMs":2475,"publisherPliMs":2475,"requests":1},{"keyFrameDecodedMs":2454,"publisherPliMs":2476,"requests":1},{"keyFrameDecodedMs":2459,"publisherPliMs":2459,"requests":1},{"keyFrameDecodedMs":2467,"publisherPliMs":2467,"requests":1},{"keyFrameDecodedMs":2471,"publisherPliMs":2471,"requests":1},{"keyFrameDecodedMs":2452,"publisherPliMs":2452,"requests":1},{"keyFrameDecodedMs":2457,"publisherPliMs":2457,"requests":1},{"keyFrameDecodedMs":2461,"publisherPliMs":2461,"requests":1},{"keyFrameDecodedMs":2495,"publisherPliMs":2495,"requests":1},{"keyFrameDecodedMs":2484,"publisherPliMs":2484,"requests":1},{"keyFrameDecodedMs":2471,"publisherPliMs":2494,"requests":1},{"keyFrameDecodedMs":2471,"publisherPliMs":2448,"requests":1},{"keyFrameDecodedMs":2486,"publisherPliMs":2463,"requests":1},{"keyFrameDecodedMs":2486,"publisherPliMs":2509,"requests":1},{"keyFrameDecodedMs":2469,"publisherPliMs":2469,"requests":1},{"keyFrameDecodedMs":2487,"publisherPliMs":2464,"requests":1},{"keyFrameDecodedMs":2487,"publisherPliMs":2464,"requests":1}],"keyFrameDecoded":{"n":20,"missing":0,"p50":2471,"p90":2487,"max":2495},"publisherPli":{"n":20,"missing":0,"p50":2464,"p90":2495,"max":2509},"sendKeyFrameRequestResolved":120,"sendKeyFrameRequestRejected":[]},"behindRecentPliRepeat500":{"trials":[{"keyFrameDecodedMs":529,"publisherPliMs":529,"requests":2},{"keyFrameDecodedMs":532,"publisherPliMs":555,"requests":2},{"keyFrameDecodedMs":529,"publisherPliMs":553,"requests":2},{"keyFrameDecodedMs":533,"publisherPliMs":556,"requests":2},{"keyFrameDecodedMs":529,"publisherPliMs":552,"requests":2},{"keyFrameDecodedMs":530,"publisherPliMs":553,"requests":2},{"keyFrameDecodedMs":531,"publisherPliMs":553,"requests":2},{"keyFrameDecodedMs":531,"publisherPliMs":553,"requests":2},{"keyFrameDecodedMs":534,"publisherPliMs":557,"requests":2},{"keyFrameDecodedMs":561,"publisherPliMs":561,"requests":2},{"keyFrameDecodedMs":560,"publisherPliMs":537,"requests":2},{"keyFrameDecodedMs":535,"publisherPliMs":559,"requests":2},{"keyFrameDecodedMs":539,"publisherPliMs":563,"requests":2},{"keyFrameDecodedMs":561,"publisherPliMs":538,"requests":2},{"keyFrameDecodedMs":561,"publisherPliMs":561,"requests":2},{"keyFrameDecodedMs":538,"publisherPliMs":538,"requests":2},{"keyFrameDecodedMs":559,"publisherPliMs":559,"requests":2},{"keyFrameDecodedMs":540,"publisherPliMs":540,"requests":2},{"keyFrameDecodedMs":536,"publisherPliMs":559,"requests":2},{"keyFrameDecodedMs":563,"publisherPliMs":540,"requests":2}],"keyFrameDecoded":{"n":20,"missing":0,"p50":536,"p90":561,"max":563},"publisherPli":{"n":20,"missing":0,"p50":553,"p90":561,"max":563},"sendKeyFrameRequestResolved":240,"sendKeyFrameRequestRejected":[]}}
# run 2: the drop leg alone, committed spec
SPIKE keyframe-recovery.chromium-drop {"browser":"153.0.8010.12","oneReceiver":{"lastDecodeBeforeMs":3,"firstReceiverPliMs":3016,"pliAfterLastDecodeMs":3013,"publisherKeyFrameMs":3024,"firstDecodeAfterMs":3116,"freezeMs":3113,"receiverPlis":1,"publisherPlis":1,"publisherKeyFrames":1},"twoReceivers":{"B":{"lastDecodeBeforeMs":3,"firstReceiverPliMs":3016,"pliAfterLastDecodeMs":3013,"publisherKeyFrameMs":3024,"firstDecodeAfterMs":3116,"freezeMs":3113,"receiverPlis":1,"publisherPlis":1,"publisherKeyFrames":1},"C":{"lastDecodeBeforeMs":4,"firstReceiverPliMs":3016,"pliAfterLastDecodeMs":3012,"publisherKeyFrameMs":3024,"firstDecodeAfterMs":3116,"freezeMs":3112,"receiverPlis":1,"publisherPlis":1,"publisherKeyFrames":1}},"livekitPliTotal":{"before":"unavailable (HTTP 401)","after":"unavailable (HTTP 401)"},"keyFramesSeenByReceiverWorker":4,"keyFramesEncodedByPublisher":5}
# earlier run (a): the brief's spec without the pre-roll (its drop test failed the sanity assertion)
SPIKE keyframe-recovery.chromium-drop {"browser":"153.0.8010.12","oneReceiver":{"lastDecodeBeforeMs":null,"firstReceiverPliMs":3016,"pliAfterLastDecodeMs":null,"publisherKeyFrameMs":3016,"firstDecodeAfterMs":null,"freezeMs":null,"receiverPlis":1,"publisherPlis":1,"publisherKeyFrames":1},"twoReceivers":{"B":{"lastDecodeBeforeMs":null,"firstReceiverPliMs":3018,"pliAfterLastDecodeMs":null,"publisherKeyFrameMs":3025,"firstDecodeAfterMs":null,"freezeMs":null,"receiverPlis":1,"publisherPlis":1,"publisherKeyFrames":1},"C":{"lastDecodeBeforeMs":null,"firstReceiverPliMs":3018,"pliAfterLastDecodeMs":null,"publisherKeyFrameMs":3025,"firstDecodeAfterMs":null,"freezeMs":null,"receiverPlis":1,"publisherPlis":1,"publisherKeyFrames":1}},"livekitPliTotal":{"before":"unavailable (HTTP 401)","after":"unavailable (HTTP 401)"},"keyFramesSeenByReceiverWorker":4,"keyFramesEncodedByPublisher":5}
SPIKE keyframe-recovery.chromium-hold {"browser":"153.0.8010.12","rows":[{"holdMs":500,"receiverPlis":0,"publisherKeyFrames":0,"maxDecodeGapMs":101,"freezeMs":null},{"holdMs":1000,"receiverPlis":0,"publisherKeyFrames":0,"maxDecodeGapMs":51,"freezeMs":null},{"holdMs":1500,"receiverPlis":0,"publisherKeyFrames":0,"maxDecodeGapMs":51,"freezeMs":null},{"holdMs":2000,"receiverPlis":0,"publisherKeyFrames":0,"maxDecodeGapMs":51,"freezeMs":null}],"held":149,"released":149}
SPIKE keyframe-recovery.chromium-script {"browser":"153.0.8010.12","plain":{"trials":[{"keyFrameDecodedMs":49,"publisherPliMs":72},{"keyFrameDecodedMs":51,"publisherPliMs":73},{"keyFrameDecodedMs":69,"publisherPliMs":69},{"keyFrameDecodedMs":48,"publisherPliMs":71},{"keyFrameDecodedMs":50,"publisherPliMs":74},{"keyFrameDecodedMs":51,"publisherPliMs":51},{"keyFrameDecodedMs":52,"publisherPliMs":52},{"keyFrameDecodedMs":49,"publisherPliMs":71},{"keyFrameDecodedMs":70,"publisherPliMs":70},{"keyFrameDecodedMs":72,"publisherPliMs":72},{"keyFrameDecodedMs":49,"publisherPliMs":71},{"keyFrameDecodedMs":53,"publisherPliMs":53},{"keyFrameDecodedMs":69,"publisherPliMs":69},{"keyFrameDecodedMs":69,"publisherPliMs":69},{"keyFrameDecodedMs":49,"publisherPliMs":72},{"keyFrameDecodedMs":49,"publisherPliMs":72},{"keyFrameDecodedMs":69,"publisherPliMs":69},{"keyFrameDecodedMs":92,"publisherPliMs":70},{"keyFrameDecodedMs":70,"publisherPliMs":70},{"keyFrameDecodedMs":70,"publisherPliMs":70}],"keyFrameDecoded":{"n":20,"missing":0,"p50":53,"p90":72,"max":92},"publisherPli":{"n":20,"missing":0,"p50":70,"p90":73,"max":74},"sendKeyFrameRequestResolved":20,"sendKeyFrameRequestRejected":[]}}
SPIKE keyframe-recovery.chromium-resubscribe {"browser":"153.0.8010.12","reps":[{"firstDecodeMs":109,"pliTimesMs":[],"medianPliIntervalMs":null,"classification":"no PLI before decoding"},{"firstDecodeMs":56,"pliTimesMs":[],"medianPliIntervalMs":null,"classification":"no PLI before decoding"},{"firstDecodeMs":61,"pliTimesMs":[],"medianPliIntervalMs":null,"classification":"no PLI before decoding"}]}
SPIKE keyframe-recovery.firefox-script {"chromium":"153.0.8010.12","firefox":"155.0","plain":{"trials":[{"keyFrameDecodedMs":51,"publisherPliMs":51},{"keyFrameDecodedMs":51,"publisherPliMs":51},{"keyFrameDecodedMs":26,"publisherPliMs":26},{"keyFrameDecodedMs":52,"publisherPliMs":52},{"keyFrameDecodedMs":51,"publisherPliMs":51},{"keyFrameDecodedMs":50,"publisherPliMs":74},{"keyFrameDecodedMs":27,"publisherPliMs":72},{"keyFrameDecodedMs":51,"publisherPliMs":51},{"keyFrameDecodedMs":27,"publisherPliMs":51},{"keyFrameDecodedMs":28,"publisherPliMs":52},{"keyFrameDecodedMs":28,"publisherPliMs":51},{"keyFrameDecodedMs":28,"publisherPliMs":51},{"keyFrameDecodedMs":29,"publisherPliMs":52},{"keyFrameDecodedMs":52,"publisherPliMs":52},{"keyFrameDecodedMs":49,"publisherPliMs":72},{"keyFrameDecodedMs":29,"publisherPliMs":52},{"keyFrameDecodedMs":27,"publisherPliMs":73},{"keyFrameDecodedMs":52,"publisherPliMs":29},{"keyFrameDecodedMs":51,"publisherPliMs":51},{"keyFrameDecodedMs":28,"publisherPliMs":50}],"keyFrameDecoded":{"n":20,"missing":0,"p50":49,"p90":52,"max":52},"publisherPli":{"n":20,"missing":0,"p50":51,"p90":73,"max":74},"sendKeyFrameRequestResolved":60,"sendKeyFrameRequestRejected":[]},"behindRecentPli":{"trials":[{"keyFrameDecodedMs":2472,"publisherPliMs":2472},{"keyFrameDecodedMs":2454,"publisherPliMs":2454},{"keyFrameDecodedMs":2472,"publisherPliMs":2472},{"keyFrameDecodedMs":2481,"publisherPliMs":2458},{"keyFrameDecodedMs":2482,"publisherPliMs":2459},{"keyFrameDecodedMs":2479,"publisherPliMs":2502},{"keyFrameDecodedMs":2473,"publisherPliMs":2450},{"keyFrameDecodedMs":2479,"publisherPliMs":2456},{"keyFrameDecodedMs":2448,"publisherPliMs":2471},{"keyFrameDecodedMs":2479,"publisherPliMs":2479},{"keyFrameDecodedMs":2472,"publisherPliMs":2472},{"keyFrameDecodedMs":2472,"publisherPliMs":2472},{"keyFrameDecodedMs":2479,"publisherPliMs":2479},{"keyFrameDecodedMs":2490,"publisherPliMs":2467},{"keyFrameDecodedMs":2481,"publisherPliMs":2457},{"keyFrameDecodedMs":2497,"publisherPliMs":2474},{"keyFrameDecodedMs":2479,"publisherPliMs":2479},{"keyFrameDecodedMs":2479,"publisherPliMs":2456},{"keyFrameDecodedMs":2446,"publisherPliMs":2469},{"keyFrameDecodedMs":2470,"publisherPliMs":2470}],"keyFrameDecoded":{"n":20,"missing":0,"p50":2479,"p90":2490,"max":2497},"publisherPli":{"n":20,"missing":0,"p50":2471,"p90":2479,"max":2502},"sendKeyFrameRequestResolved":120,"sendKeyFrameRequestRejected":[]}}
# earlier run (b): committed spec without the attach log in the resubscribe record
SPIKE keyframe-recovery.chromium-drop {"browser":"153.0.8010.12","oneReceiver":{"lastDecodeBeforeMs":3,"firstReceiverPliMs":3014,"pliAfterLastDecodeMs":3011,"publisherKeyFrameMs":3022,"firstDecodeAfterMs":3115,"freezeMs":3112,"receiverPlis":1,"publisherPlis":1,"publisherKeyFrames":1},"twoReceivers":{"B":{"lastDecodeBeforeMs":2,"firstReceiverPliMs":3014,"pliAfterLastDecodeMs":3012,"publisherKeyFrameMs":3015,"firstDecodeAfterMs":3114,"freezeMs":3112,"receiverPlis":1,"publisherPlis":1,"publisherKeyFrames":1},"C":{"lastDecodeBeforeMs":3,"firstReceiverPliMs":3013,"pliAfterLastDecodeMs":3010,"publisherKeyFrameMs":3015,"firstDecodeAfterMs":3114,"freezeMs":3111,"receiverPlis":1,"publisherPlis":1,"publisherKeyFrames":1}},"livekitPliTotal":{"before":"unavailable (HTTP 401)","after":"unavailable (HTTP 401)"},"keyFramesSeenByReceiverWorker":4,"keyFramesEncodedByPublisher":5}
SPIKE keyframe-recovery.chromium-hold {"browser":"153.0.8010.12","rows":[{"holdMs":500,"receiverPlis":0,"publisherKeyFrames":0,"maxDecodeGapMs":503,"freezeMs":503,"framesHeld":14,"framesDecodedInWindow":117,"windowMs":3975},{"holdMs":1000,"receiverPlis":0,"publisherKeyFrames":0,"maxDecodeGapMs":1006,"freezeMs":1006,"framesHeld":30,"framesDecodedInWindow":133,"windowMs":4478},{"holdMs":1500,"receiverPlis":0,"publisherKeyFrames":0,"maxDecodeGapMs":1509,"freezeMs":1509,"framesHeld":45,"framesDecodedInWindow":149,"windowMs":4981},{"holdMs":2000,"receiverPlis":0,"publisherKeyFrames":0,"maxDecodeGapMs":2012,"freezeMs":2012,"framesHeld":60,"framesDecodedInWindow":163,"windowMs":5487}],"held":149,"released":149}
SPIKE keyframe-recovery.chromium-script {"browser":"153.0.8010.12","plain":{"trials":[{"keyFrameDecodedMs":73,"publisherPliMs":73,"requests":1},{"keyFrameDecodedMs":69,"publisherPliMs":69,"requests":1},{"keyFrameDecodedMs":69,"publisherPliMs":69,"requests":1},{"keyFrameDecodedMs":69,"publisherPliMs":69,"requests":1},{"keyFrameDecodedMs":69,"publisherPliMs":69,"requests":1},{"keyFrameDecodedMs":69,"publisherPliMs":69,"requests":1},{"keyFrameDecodedMs":70,"publisherPliMs":70,"requests":1},{"keyFrameDecodedMs":70,"publisherPliMs":70,"requests":1},{"keyFrameDecodedMs":68,"publisherPliMs":68,"requests":1},{"keyFrameDecodedMs":70,"publisherPliMs":70,"requests":1},{"keyFrameDecodedMs":69,"publisherPliMs":69,"requests":1},{"keyFrameDecodedMs":69,"publisherPliMs":69,"requests":1},{"keyFrameDecodedMs":69,"publisherPliMs":69,"requests":1},{"keyFrameDecodedMs":69,"publisherPliMs":69,"requests":1},{"keyFrameDecodedMs":69,"publisherPliMs":69,"requests":1},{"keyFrameDecodedMs":49,"publisherPliMs":72,"requests":1},{"keyFrameDecodedMs":70,"publisherPliMs":70,"requests":1},{"keyFrameDecodedMs":69,"publisherPliMs":69,"requests":1},{"keyFrameDecodedMs":50,"publisherPliMs":50,"requests":1},{"keyFrameDecodedMs":70,"publisherPliMs":70,"requests":1}],"keyFrameDecoded":{"n":20,"missing":0,"p50":69,"p90":70,"max":73},"publisherPli":{"n":20,"missing":0,"p50":69,"p90":72,"max":73},"sendKeyFrameRequestResolved":20,"sendKeyFrameRequestRejected":[]}}
SPIKE keyframe-recovery.chromium-resubscribe {"browser":"153.0.8010.12","reps":[{"decodeVideoAttachCalls":4,"workerRetargets":1,"firstDecodeMs":59,"pliTimesMs":[],"medianPliIntervalMs":null,"classification":"no PLI before decoding"},{"decodeVideoAttachCalls":7,"workerRetargets":7,"firstDecodeMs":56,"pliTimesMs":[],"medianPliIntervalMs":null,"classification":"no PLI before decoding"},{"decodeVideoAttachCalls":10,"workerRetargets":13,"firstDecodeMs":117,"pliTimesMs":[],"medianPliIntervalMs":null,"classification":"no PLI before decoding"}]}
SPIKE keyframe-recovery.firefox-script {"chromium":"153.0.8010.12","firefox":"155.0","plain":{"trials":[{"keyFrameDecodedMs":27,"publisherPliMs":51,"requests":1},{"keyFrameDecodedMs":27,"publisherPliMs":50,"requests":1},{"keyFrameDecodedMs":28,"publisherPliMs":51,"requests":1},{"keyFrameDecodedMs":27,"publisherPliMs":73,"requests":1},{"keyFrameDecodedMs":56,"publisherPliMs":56,"requests":1},{"keyFrameDecodedMs":51,"publisherPliMs":51,"requests":1},{"keyFrameDecodedMs":49,"publisherPliMs":72,"requests":1},{"keyFrameDecodedMs":27,"publisherPliMs":73,"requests":1},{"keyFrameDecodedMs":52,"publisherPliMs":52,"requests":1},{"keyFrameDecodedMs":28,"publisherPliMs":51,"requests":1},{"keyFrameDecodedMs":28,"publisherPliMs":51,"requests":1},{"keyFrameDecodedMs":28,"publisherPliMs":51,"requests":1},{"keyFrameDecodedMs":29,"publisherPliMs":51,"requests":1},{"keyFrameDecodedMs":28,"publisherPliMs":51,"requests":1},{"keyFrameDecodedMs":53,"publisherPliMs":53,"requests":1},{"keyFrameDecodedMs":51,"publisherPliMs":51,"requests":1},{"keyFrameDecodedMs":49,"publisherPliMs":71,"requests":1},{"keyFrameDecodedMs":26,"publisherPliMs":49,"requests":1},{"keyFrameDecodedMs":28,"publisherPliMs":52,"requests":1},{"keyFrameDecodedMs":50,"publisherPliMs":50,"requests":1}],"keyFrameDecoded":{"n":20,"missing":0,"p50":28,"p90":53,"max":56},"publisherPli":{"n":20,"missing":0,"p50":51,"p90":73,"max":73},"sendKeyFrameRequestResolved":60,"sendKeyFrameRequestRejected":[]},"behindRecentPli":{"trials":[{"keyFrameDecodedMs":2478,"publisherPliMs":2501,"requests":1},{"keyFrameDecodedMs":2462,"publisherPliMs":2439,"requests":1},{"keyFrameDecodedMs":2483,"publisherPliMs":2506,"requests":1},{"keyFrameDecodedMs":2470,"publisherPliMs":2493,"requests":1},{"keyFrameDecodedMs":2455,"publisherPliMs":2455,"requests":1},{"keyFrameDecodedMs":2466,"publisherPliMs":2466,"requests":1},{"keyFrameDecodedMs":2488,"publisherPliMs":2510,"requests":1},{"keyFrameDecodedMs":2464,"publisherPliMs":2464,"requests":1},{"keyFrameDecodedMs":2477,"publisherPliMs":2455,"requests":1},{"keyFrameDecodedMs":2467,"publisherPliMs":2467,"requests":1},{"keyFrameDecodedMs":2488,"publisherPliMs":2465,"requests":1},{"keyFrameDecodedMs":2476,"publisherPliMs":2454,"requests":1},{"keyFrameDecodedMs":2448,"publisherPliMs":2448,"requests":1},{"keyFrameDecodedMs":2473,"publisherPliMs":2473,"requests":1},{"keyFrameDecodedMs":2468,"publisherPliMs":2468,"requests":1},{"keyFrameDecodedMs":2448,"publisherPliMs":2471,"requests":1},{"keyFrameDecodedMs":2477,"publisherPliMs":2477,"requests":1},{"keyFrameDecodedMs":2489,"publisherPliMs":2489,"requests":1},{"keyFrameDecodedMs":2486,"publisherPliMs":2509,"requests":1},{"keyFrameDecodedMs":2453,"publisherPliMs":2478,"requests":1}],"keyFrameDecoded":{"n":20,"missing":0,"p50":2473,"p90":2488,"max":2489},"publisherPli":{"n":20,"missing":0,"p50":2471,"p90":2509,"max":2510},"sendKeyFrameRequestResolved":120,"sendKeyFrameRequestRejected":[]},"behindRecentPliRepeat500":{"trials":[{"keyFrameDecodedMs":566,"publisherPliMs":543,"requests":2},{"keyFrameDecodedMs":533,"publisherPliMs":556,"requests":2},{"keyFrameDecodedMs":536,"publisherPliMs":560,"requests":2},{"keyFrameDecodedMs":530,"publisherPliMs":553,"requests":2},{"keyFrameDecodedMs":530,"publisherPliMs":553,"requests":2},{"keyFrameDecodedMs":532,"publisherPliMs":555,"requests":2},{"keyFrameDecodedMs":534,"publisherPliMs":558,"requests":2},{"keyFrameDecodedMs":531,"publisherPliMs":555,"requests":2},{"keyFrameDecodedMs":557,"publisherPliMs":557,"requests":2},{"keyFrameDecodedMs":559,"publisherPliMs":559,"requests":2},{"keyFrameDecodedMs":554,"publisherPliMs":531,"requests":2},{"keyFrameDecodedMs":536,"publisherPliMs":536,"requests":2},{"keyFrameDecodedMs":531,"publisherPliMs":555,"requests":2},{"keyFrameDecodedMs":533,"publisherPliMs":556,"requests":2},{"keyFrameDecodedMs":531,"publisherPliMs":554,"requests":2},{"keyFrameDecodedMs":559,"publisherPliMs":559,"requests":2},{"keyFrameDecodedMs":538,"publisherPliMs":561,"requests":2},{"keyFrameDecodedMs":535,"publisherPliMs":535,"requests":2},{"keyFrameDecodedMs":533,"publisherPliMs":556,"requests":2},{"keyFrameDecodedMs":554,"publisherPliMs":554,"requests":2}],"keyFrameDecoded":{"n":20,"missing":0,"p50":535,"p90":559,"max":566},"publisherPli":{"n":20,"missing":0,"p50":555,"p90":560,"max":561},"sendKeyFrameRequestResolved":240,"sendKeyFrameRequestRejected":[]}}
# earlier run (c): the resubscribe leg alone, committed spec
SPIKE keyframe-recovery.chromium-resubscribe {"browser":"153.0.8010.12","reps":[{"decodeVideoAttachCalls":4,"workerRetargets":1,"firstDecodeMs":107,"pliTimesMs":[],"medianPliIntervalMs":null,"classification":"no PLI before decoding"},{"decodeVideoAttachCalls":7,"workerRetargets":7,"firstDecodeMs":115,"pliTimesMs":[],"medianPliIntervalMs":null,"classification":"no PLI before decoding"},{"decodeVideoAttachCalls":10,"workerRetargets":13,"firstDecodeMs":115,"pliTimesMs":[],"medianPliIntervalMs":null,"classification":"no PLI before decoding"}],"attachLog":["decode/video/d912da7b-da75-4aa1-a7dc-240d68eee31d","decode/audio/50983f48-d091-43e4-9266-b2fa4c5b1e82","decode/audio/691a0d8d-6ca1-433f-b78b-618e0316fd15","decode/audio/b28eba5b-5b54-4f18-b4dc-8a07eef2be4f","decode/video/e2f498b1-7c54-491a-8016-411b822434e4","decode/video/ba472ccc-a562-4378-8a5b-0ccca9e8b2ef","decode/video/d912da7b-da75-4aa1-a7dc-240d68eee31d","decode/audio/50983f48-d091-43e4-9266-b2fa4c5b1e82","decode/audio/691a0d8d-6ca1-433f-b78b-618e0316fd15","decode/audio/b28eba5b-5b54-4f18-b4dc-8a07eef2be4f","decode/video/e2f498b1-7c54-491a-8016-411b822434e4","decode/video/ba472ccc-a562-4378-8a5b-0ccca9e8b2ef","decode/video/d912da7b-da75-4aa1-a7dc-240d68eee31d","decode/audio/50983f48-d091-43e4-9266-b2fa4c5b1e82","decode/audio/691a0d8d-6ca1-433f-b78b-618e0316fd15","decode/audio/b28eba5b-5b54-4f18-b4dc-8a07eef2be4f","decode/video/e2f498b1-7c54-491a-8016-411b822434e4","decode/video/ba472ccc-a562-4378-8a5b-0ccca9e8b2ef","decode/video/d912da7b-da75-4aa1-a7dc-240d68eee31d"]}
```
