# SP-13 SFU-injected frames: SIF suffix tested before any SFrame parse; trailer replaced on every setSifTrailer

Date: 2026-10-04. Host: dev box (Linux x86-64, loopback only), Playwright 1.63.0, Chromium 153.0.8010.12, Firefox 155.0,
LiveKit v1.13.7 in process (`dilla-testhost -sfu`), livekit-client 2.22.3 (UMD), VP8 camera 320×240 at 30 fps, single
layer, `GOMAXPROCS=4`. Spec: `e2e/spikes/sfu-injected.spec.ts`.

Every number below was measured on this host. The classification order held on both engines: every frame that
arrived without the publisher's encryption ended in the room's SIF trailer, and no frame of an encrypted
publication arrived without either the trailer or the publisher's marker (`no marker` = 0 in every phase). Three
pre-written count expectations did **not** hold and are replaced by the measured values below: a camera mute
injects **no** frames (not blank key frames), a browser subscriber gets **no** padding-on-mute frames (not up to
250), and a camera close injects 6 VP8 key frames, an event the brief did not list. These change only the counts
task 21 uses, not the order task 17 implements.

**Runs.** The tables quote run 2; its raw lines are at the end.

- **Run 1**: a full run of the spec before the `presentedSizes`, `publisherVideoSent` and `audioLoudSamples` fields
  were added (`4 passed`, `4 skipped`, 3.9 min). Every SIF, `no marker` and plaintext-silence count in every
  phase of all four legs equals run 2's. Decrypted counts differ by up to 18 frames in the camera-republish phases
  (republish timing) and by at most 2 elsewhere. The NONE legs' frame totals differ by 1. Its rooms' trailers were 44
  bytes (run 2: 43), so its SIF frames were one byte longer (124 audio, 75 VP8). Its raw lines were printed to the
  terminal only and were overwritten in `e2e/test-results/`; they are not reproduced here.
- **Run 2**: a full run of the committed spec, `4 passed`, `4 skipped` (3.8 min).
- **Step 1 check**: `transform-api -g "chromium streams"` on the same tree: `1 passed`, `1 skipped` (task 14's rig
  still runs).

**Spec changes from the brief.** No classification decision changed. The rig differs from `transform-api` and
`keyframe-recovery` only in lines marked `SP-13`, which record: byte-size and first-bytes histograms of every SIF
frame and every unmarked audio frame, the trailer as delivered, and the number of `setSifTrailer` deliveries. The
ruling on pre-flight scan item 4 needs the SIF frame sizes, and the rig had no way to record them.

- `HARNESS` is `http://127.0.0.1:5179/`, and the import is `../media/support/lk.ts`, as in SP-01 and SP-02.
- Added: a Firefox receiver leg for both the encrypted and the NONE publication. The publisher is Chromium and
  the receiver uses the script path (`RTCRtpScriptTransform`, attached at `MediaTrackAdded`). The ruling asks for
  the property on every engine tested.
- Added phases: three mic close/republish cycles (the brief closed the mic once, but its range rule needs three
  repetitions), an H.264 camera close, and two VP8 camera republish/close cycles. With the VP8 close inside
  "camera republished as H.264", that makes three VP8 closes.
- Added evidence fields: per remote video track, frames the browser decoded against frames the worker enqueued;
  the size of every frame a `<video>` presented (`requestVideoFrameCallback` metadata, watched outside the rig);
  the publisher's own outbound video counters; and audibility of the NONE publisher's microphone at B, with the
  encrypted leg's decrypted microphone as the positive control.
- The NONE publisher C also publishes a camera, the same shape as task 21's canary.

## Question

Which frames does LiveKit itself write into an encrypted publication's down-tracks, what do they end with, and
does anything else arrive in plaintext? (DEV-13, gap G21 fact 9, gap G12 constraints 6–7.)

## Encrypted publication (publisher A with an E2EE manager, subscriber B)

Room SIF trailer length seen by the manager: 43 bytes in run 2 (both rooms) and 44 bytes in run 1 (both rooms),
within the expected 43–52. The trailer was `[0-9A-Za-z]` only (`sifTrailerAlnum: true`) and was delivered once
per join (`setSifTrailerCalls: 1`). No signal restart was exercised, so the bytes of a second delivery were not
observed.

Chromium receiver (`createEncodedStreams`, run 2):

| phase | SIF audio | SIF video (key) | no marker | plaintext Opus silence | decrypted |
|---|---|---|---|---|---|
| mic mute #1 | 51 | 0 (0) | 0 | 0 | 208 |
| mic unmute #1 | 0 | 0 (0) | 0 | 0 | 239 |
| mic mute #2 | 51 | 0 (0) | 0 | 0 | 208 |
| mic unmute #2 | 0 | 0 (0) | 0 | 0 | 241 |
| mic mute #3 | 51 | 0 (0) | 0 | 0 | 209 |
| mic unmute #3 | 0 | 0 (0) | 0 | 0 | 241 |
| camera mute VP8 #1 | 0 | 0 (0) | 0 | 0 | 151 |
| camera mute VP8 #2 | 0 | 0 (0) | 0 | 0 | 152 |
| camera mute VP8 #3 | 0 | 0 (0) | 0 | 0 | 150 |
| camera unmute VP8 (#1–#3, summed) | 0 | 0 (0) | 0 | 0 | 712 |
| camera republished as H.264 (VP8 close flush) | 0 | 6 (6) | 0 | 0 | 205 |
| camera mute H.264 | 0 | 0 (0) | 0 | 0 | 151 |
| camera unmute H.264 | 0 | 0 (0) | 0 | 0 | 150 |
| camera unpublish H.264 (close flush) | 0 | 0 (0) | 0 | 0 | 152 |
| camera republish VP8 #1 | 0 | 0 (0) | 0 | 0 | 318 |
| camera unpublish VP8 (close flush) #2 | 0 | 6 (6) | 0 | 0 | 153 |
| camera republish VP8 #2 | 0 | 0 (0) | 0 | 0 | 299 |
| camera unpublish VP8 (close flush) #3 | 0 | 6 (6) | 0 | 0 | 154 |
| mic unpublish (close flush) #1 | 11 | 0 (0) | 0 | 0 | 0 |
| mic republish #1 | 0 | 0 (0) | 0 | 0 | 148 |
| mic unpublish (close flush) #2 | 11 | 0 (0) | 0 | 0 | 0 |
| mic republish #2 | 0 | 0 (0) | 0 | 0 | 148 |
| mic unpublish (close flush) #3 | 11 | 0 (0) | 0 | 0 | 0 |
| mic republish #3 | 0 | 0 (0) | 0 | 0 | 148 |
| **total** | 186 | 18 (18) | 0 | 0 | 4865 |

Firefox receiver (`RTCRtpScriptTransform`, Chromium publisher, run 2):

| phase | SIF audio | SIF video (key) | no marker | plaintext Opus silence | decrypted |
|---|---|---|---|---|---|
| mic mute #1 / #2 / #3 | 51 / 51 / 51 | 0 (0) | 0 | 0 | 207 / 209 / 209 |
| mic unmute #1 / #2 / #3 | 0 | 0 (0) | 0 | 0 | 239 / 241 / 240 |
| camera mute VP8 #1 / #2 / #3 | 0 | 0 (0) | 0 | 0 | 150 / 151 / 150 |
| camera unmute VP8 (#1–#3, summed) | 0 | 0 (0) | 0 | 0 | 715 |
| camera unpublish VP8 (close flush) #1 / #2 / #3 | 0 | 6 (6) / 6 (6) / 6 (6) | 0 | 0 | 152 / 152 / 152 |
| camera republish VP8 #1 / #2 / #3 | 0 | 0 (0) | 0 | 0 | 319 / 300 / 318 |
| mic unpublish (close flush) #1 / #2 / #3 | 11 / 11 / 11 | 0 (0) | 0 | 0 | 90 / 92 / 91 |
| mic republish #1 / #2 / #3 | 0 | 0 (0) | 0 | 0 | 239 / 239 / 239 |
| **total** | 186 | 18 (18) | 0 | 0 | 5220 |

(On Firefox the camera stays published during the mic closes, so those phases still decrypt video. On Chromium the
camera was closed by then.)

**What the injected frames are** (byte histograms from the rig, run 2, both engines identical):

| kind | size | first bytes | count | composition |
|---|---|---|---|---|
| Opus | 123 bytes (run 1: 124) | `f8 ff fe 00` | 186 | LiveKit's 80-byte `OpusSilenceFrame` + the trailer |
| VP8 key | 74 bytes (run 1: 75) | `10 02 00 9d` | 18 | 31-byte 8×8 VP8 key frame (`9d 01 2a` start code) + the trailer |

The trailer is 43–52 bytes (gap G12 constraint 7). An injected frame is therefore 123–132 bytes for Opus and
74–83 bytes for VP8. The measured range is 74–124 bytes over both runs, and **132 bytes** is the upper bound for
any SIF frame a browser receiver classifies.

**Never rendered.** In every phase, on both engines, the worker enqueued no SIF frame (by construction: it returns
before enqueueing). Wherever a remote video track's stats could be read, the browser's own `framesDecoded`
exceeded the worker's enqueued count by at most 1 frame per phase, the boundary frame between two snapshots. In a
close phase the publication is gone by the second snapshot, so there the presented frame sizes are the evidence.
Chromium presented only 320×240 frames (1709). Firefox presented 320×240 frames (4447) and nine
1×1 frames. Those nine fall in camera-mute phases, which inject nothing, and in close phases. They are Firefox's
own placeholder for a muted or ended track, not LiveKit's 8×8 frame. (This is an inference from the mute phases.)
No 8×8 frame was presented on either engine. On Firefox the rig's `videoRendered` counts are inflated because a
reused receiver gets one observer per republish, all on the same track. The presented-size counts come from the
separate watcher.

**Expected (G21)** was ≈ 50 SIF Opus frames per mute plus at most 250 padding-on-mute frames, ≈ 10 on close, blank
key frames on camera mute, and `no marker` = 0 in every phase. **Result:** `no marker` = 0 in every phase on both
engines, as expected. What differed:

- **Mic mute** gives 51 frames in the 7 s window, and no padding-on-mute frames arrived. LiveKit sends those only to subscribers whose SDK is Go: `onTrackSubscribed` calls
  `SetActivePaddingOnMuteUpTrack` only `if p.params.ClientInfo.FireTrackByRTPPacket()`, which is `c.isGo()`
  (`pkg/rtc/participant.go:1919-1921`, `pkg/rtc/clientinfo.go:62-64`). Even then it runs only while the down-track
  has sent nothing yet (`downtrack.go:2689`). A browser receiver never gets them. A Go subscriber (task 7's
  decrypt loop, the mediabot) can get up to 250 when it subscribes to a muted track. That was read from source and
  not measured here.
- **Mic close** gives 11 frames, and a mute gives 51. The source asks for 50 and 10 (`numFrames = frameRate ×
  duration`, `downtrack.go:1832`). The extra frame was not investigated.
- **Camera mute** injects **nothing**. LiveKit writes mute blank frames only `if d.kind == webrtc.RTPCodecTypeAudio
  && muted` (`downtrack.go:1398-1400`). VP8 blank key frames come only from `CloseWithFlush` (`downtrack.go:1433-1434`):
  6 per close (0.2 s × 30 fps), all key frames.
- **H.264** was not measured by this rig. Its toy cipher XORs every byte after the first one (delta) or ten (key),
  which destroys the Annex B start codes the H.264 packetizer needs. In the "camera unmute H.264" phase the
  publisher encoded 88 frames and sent only 23 packets, and B decrypted and decoded 0 H.264 frames in every H.264
  phase. Down-track blank frames are written only once the down-track has forwarded something
  (`downtrack.go:1798`), so the 0 at the H.264 close says nothing. The only H.264 evidence is task 3's (SP-04):
  6 `Incorrect StapA packet` errors in Chromium's libwebrtc log at each close, which means Chromium drops LiveKit's
  STAP-A blank frames in the depacketizer, before any transform.

Pipe errors: none (both engines, both runs).

## Negative control: a NONE publication (publisher C without an E2EE manager)

C publishes a microphone and a camera without an E2EE manager. Measured at B over the whole run (run 2):

| receiver | C mic frames (SIF / no marker / plaintext silence) | C camera frames (SIF / no marker) | C video decoded / rendered / presented | C mic audible samples before the mute |
|---|---|---|---|---|
| Chromium (streams) | 238 (0 / 238 / 62) | 485 (0 / 485) | 0 / 0 / none | 0 |
| Firefox (script) | 239 (0 / 239 / 62) | 501 (0 / 501) | 0 / 0 / none | 0 |

During a 7 s mic mute, C's microphone track at B had 51 frames, 0 SIF-suffixed (expected 0), 51 plaintext Opus
silence `f8 ff fe…` (expected > 0), and 51 without the marker. The close that followed added 11 frames, all of them
plaintext silence, again without a trailer. All 62 silence frames are exactly 80 bytes (`noMarkerAudioSizes`
`audio:80` = 62), the bare `OpusSilenceFrame`. Both engines gave the same numbers.

The audibility check has a positive control: A's decrypted microphone at B gave 1398 (Chromium) and 1309
(Firefox) samples above RMS 0.01 in the encrypted leg. C's microphone gave 0 on both engines. The SFU appends the
trailer only to encrypted publications (`subscribedtrack.go:129-133`), so the silence it injects into a NONE
publication is plaintext with no trailer. The dilla worker drops the whole publication as `noneFlagged` before that
matters. The Go publisher that sets no `Encryption` is not part of this rig. That half is task 7's test and task
12's SP-14.

## Decision task 17 and task 21 consume

1. **Order:** the worker tests the SIF suffix before parsing any SFrame header. A suffixed frame is dropped and
   counted `sif`, never parsed, never counted as a decrypt failure, never rendered (task 17 `Pipeline.decode`).
   This is required, not cosmetic: every injected Opus frame starts `f8 ff fe 00`. An SFrame parser reads that as
   an 8-byte KID `ff fe 00 00 00 00 00 00` and a 1-byte CTR `00` (gap G21 fact 9). dilla-core's strict
   `decode_header` refuses it as a malformed header: a CTR of 0 spelled in a byte is `NonMinimalHeader`, and the
   KID is also ≥ 2^24. Gap G21 assumed the pre-fix parser, which would have held the frame for 2 s. Either way, a
   parse-first worker would count 51 header errors per mute instead of 51 `sif`. The trailer is an opaque byte string of whatever length arrives
   (43 and 44 bytes measured). It is replaced, never appended, on every `setSifTrailer`, and an empty trailer is
   ignored. The rig delivered it once per join. Replacement on a signal restart (`Room.applyJoinResponse`,
   Room.ts:1025-1033) follows from source and was not exercised here.
2. **The `sif` ranges task 21's canary asserts**, from three repetitions on each of Chromium and Firefox, which gave
   identical values (lower = floor(0.8 × minimum), upper = ceil(1.25 × maximum)):
   - per mic mute held 7 s: **[40, 64]** (measured 51 ×6). Padding-on-mute is 0 for a browser receiver.
   - per mic unpublish (close flush): **[8, 14]** (measured 11 ×6).
   - per camera mute (VP8): **[0, 0]**, of which key frames **[0, 0]** (measured 0 ×6).
   - per camera unpublish (VP8 close flush), added: **[4, 8]**, all key frames (measured 6 ×6, three of them
     inside an H.264 republish).
   - H.264 camera close: not measured (see above). On Chromium the frames never reach the transform (SP-04).
3. **Canary ceiling (pre-flight ruling 4):** `SIF_CEILING = 86` replaces the plan's 310. It has the same make-up as
   the 310: one publisher's mic mute, mic close and camera close as seen by one subscriber, using the measured
   upper bounds: 64 + 14 + 8 = 86. The plan's 250 padding-on-mute frames drop out, because a browser receiver never
   gets them. The canary run contains no mute and no unpublish, so its expected `sif` count is 0. 86 is a ceiling,
   not an expectation.
4. **SIF frame sizes:** measured 123–124 bytes (Opus) and 74–75 bytes (VP8 key). The upper bound is **132 bytes**
   (80-byte Opus silence + a 52-byte trailer). A frame larger than 132 bytes that ends in the trailer is not one
   LiveKit v1.13.7 writes. The worker needs no size check, because suffix equality is the test, but a diagnostic
   may use the bound.
5. A dilla receiver never needs the blank payloads' hashes (livekit-client's `identifySifPayload`): every SIF frame
   is dropped.

**Not run here:** Electron (the decision does not depend on the engine build); a Firefox publisher; an H.264
publication (rig limitation, above); a Go subscriber's padding-on-mute (source-read only); a signal restart's
second `setSifTrailer`; anything off loopback.

## Raw output

Run 2 (the committed spec). Each line is `SPIKE <name> ` followed by the JSON the spec wrote to
`e2e/test-results/spikes/<name>.json`, byte for byte as printed.

```
SPIKE sfu-injected.encrypted {"browser":"153.0.8010.12","receiverApi":"streams","presentedSizes":{"320x240":1709},"audioLoudSamples":1398,"sifTrailerLen":43,"sifTrailer":"3gHhFiwm8DEwuVKCpCzj7b0f4wI20B8djWOonKPak2c","sifTrailerAlnum":true,"setSifTrailerCalls":1,"phases":[{"label":"mic mute #1","sifAudio":51,"sifVideo":0,"sifVideoKey":0,"noMarker":0,"plainOpusSilence":0,"decrypted":208,"videoEnqueued":207,"videoDecoded":207,"videoRendered":202,"videoTracks":[{"id":"db801518","decoded":207,"enqueued":207}],"presentedSizes":{"320x240":202},"publisherVideoSent":{"framesEncoded":207,"packetsSent":404},"sifSizes":{"audio:123":51}},{"label":"mic unmute #1","sifAudio":0,"sifVideo":0,"sifVideoKey":0,"noMarker":0,"plainOpusSilence":0,"decrypted":239,"videoEnqueued":89,"videoDecoded":89,"videoRendered":89,"videoTracks":[{"id":"db801518","decoded":89,"enqueued":89}],"presentedSizes":{"320x240":89},"publisherVideoSent":{"framesEncoded":90,"packetsSent":174},"sifSizes":{}},{"label":"mic mute #2","sifAudio":51,"sifVideo":0,"sifVideoKey":0,"noMarker":0,"plainOpusSilence":0,"decrypted":208,"videoEnqueued":208,"videoDecoded":208,"videoRendered":202,"videoTracks":[{"id":"db801518","decoded":208,"enqueued":208}],"presentedSizes":{"320x240":202},"publisherVideoSent":{"framesEncoded":208,"packetsSent":401},"sifSizes":{"audio:123":51}},{"label":"mic unmute #2","sifAudio":0,"sifVideo":0,"sifVideoKey":0,"noMarker":0,"plainOpusSilence":0,"decrypted":241,"videoEnqueued":91,"videoDecoded":90,"videoRendered":90,"videoTracks":[{"id":"db801518","decoded":90,"enqueued":91}],"presentedSizes":{"320x240":90},"publisherVideoSent":{"framesEncoded":90,"packetsSent":180},"sifSizes":{}},{"label":"mic mute #3","sifAudio":51,"sifVideo":0,"sifVideoKey":0,"noMarker":0,"plainOpusSilence":0,"decrypted":209,"videoEnqueued":209,"videoDecoded":210,"videoRendered":208,"videoTracks":[{"id":"db801518","decoded":210,"enqueued":209}],"presentedSizes":{"320x240":208},"publisherVideoSent":{"framesEncoded":209,"packetsSent":403},"sifSizes":{"audio:123":51}},{"label":"mic unmute #3","sifAudio":0,"sifVideo":0,"sifVideoKey":0,"noMarker":0,"plainOpusSilence":0,"decrypted":241,"videoEnqueued":90,"videoDecoded":90,"videoRendered":90,"videoTracks":[{"id":"db801518","decoded":90,"enqueued":90}],"presentedSizes":{"320x240":90},"publisherVideoSent":{"framesEncoded":91,"packetsSent":181},"sifSizes":{}},{"label":"camera mute VP8 #1","sifAudio":0,"sifVideo":0,"sifVideoKey":0,"noMarker":0,"plainOpusSilence":0,"decrypted":151,"videoEnqueued":1,"videoDecoded":1,"videoRendered":1,"videoTracks":[{"id":"db801518","decoded":1,"enqueued":1}],"presentedSizes":{"320x240":1},"publisherVideoSent":{"framesEncoded":0,"packetsSent":0},"sifSizes":{}},{"label":"camera unmute VP8 #1","sifAudio":0,"sifVideo":0,"sifVideoKey":0,"noMarker":0,"plainOpusSilence":0,"decrypted":237,"videoEnqueued":87,"videoDecoded":87,"videoRendered":87,"videoTracks":[{"id":"db801518","decoded":87,"enqueued":87}],"presentedSizes":{"320x240":87},"publisherVideoSent":{"framesEncoded":88,"packetsSent":167},"sifSizes":{}},{"label":"camera mute VP8 #2","sifAudio":0,"sifVideo":0,"sifVideoKey":0,"noMarker":0,"plainOpusSilence":0,"decrypted":152,"videoEnqueued":1,"videoDecoded":1,"videoRendered":1,"videoTracks":[{"id":"db801518","decoded":1,"enqueued":1}],"presentedSizes":{"320x240":1},"publisherVideoSent":{"framesEncoded":0,"packetsSent":0},"sifSizes":{}},{"label":"camera unmute VP8 #2","sifAudio":0,"sifVideo":0,"sifVideoKey":0,"noMarker":0,"plainOpusSilence":0,"decrypted":238,"videoEnqueued":87,"videoDecoded":87,"videoRendered":82,"videoTracks":[{"id":"db801518","decoded":87,"enqueued":87}],"presentedSizes":{"320x240":82},"publisherVideoSent":{"framesEncoded":88,"packetsSent":169},"sifSizes":{}},{"label":"camera mute VP8 #3","sifAudio":0,"sifVideo":0,"sifVideoKey":0,"noMarker":0,"plainOpusSilence":0,"decrypted":150,"videoEnqueued":0,"videoDecoded":1,"videoRendered":1,"videoTracks":[{"id":"db801518","decoded":1,"enqueued":0}],"presentedSizes":{"320x240":1},"publisherVideoSent":{"framesEncoded":0,"packetsSent":0},"sifSizes":{}},{"label":"camera unmute VP8 #3","sifAudio":0,"sifVideo":0,"sifVideoKey":0,"noMarker":0,"plainOpusSilence":0,"decrypted":237,"videoEnqueued":87,"videoDecoded":87,"videoRendered":80,"videoTracks":[{"id":"db801518","decoded":87,"enqueued":87}],"presentedSizes":{"320x240":80},"publisherVideoSent":{"framesEncoded":88,"packetsSent":168},"sifSizes":{}},{"label":"camera republished as H.264 (VP8 close flush) #1","sifAudio":0,"sifVideo":6,"sifVideoKey":6,"noMarker":0,"plainOpusSilence":0,"decrypted":205,"videoEnqueued":1,"videoDecoded":0,"videoRendered":2,"videoTracks":[{"id":"e04b992e","decoded":0,"enqueued":0}],"presentedSizes":{"320x240":2},"publisherVideoSent":{"framesEncoded":-1160,"packetsSent":-2453},"sifSizes":{"video/key:74":6}},{"label":"camera mute H.264","sifAudio":0,"sifVideo":0,"sifVideoKey":0,"noMarker":0,"plainOpusSilence":0,"decrypted":151,"videoEnqueued":0,"videoDecoded":0,"videoRendered":0,"videoTracks":[{"id":"e04b992e","decoded":0,"enqueued":0}],"presentedSizes":{},"publisherVideoSent":{"framesEncoded":0,"packetsSent":0},"sifSizes":{}},{"label":"camera unmute H.264","sifAudio":0,"sifVideo":0,"sifVideoKey":0,"noMarker":0,"plainOpusSilence":0,"decrypted":150,"videoEnqueued":0,"videoDecoded":0,"videoRendered":0,"videoTracks":[{"id":"e04b992e","decoded":0,"enqueued":0}],"presentedSizes":{},"publisherVideoSent":{"framesEncoded":88,"packetsSent":23},"sifSizes":{}},{"label":"camera unpublish H.264 (close flush)","sifAudio":0,"sifVideo":0,"sifVideoKey":0,"noMarker":0,"plainOpusSilence":0,"decrypted":152,"videoEnqueued":0,"videoDecoded":0,"videoRendered":0,"videoTracks":[],"presentedSizes":{},"publisherVideoSent":{"framesEncoded":-207,"packetsSent":-47},"sifSizes":{}},{"label":"camera republish VP8 #1","sifAudio":0,"sifVideo":0,"sifVideoKey":0,"noMarker":0,"plainOpusSilence":0,"decrypted":318,"videoEnqueued":116,"videoDecoded":116,"videoRendered":208,"videoTracks":[{"id":"db801518","decoded":116,"enqueued":116}],"presentedSizes":{"320x240":208},"publisherVideoSent":{"framesEncoded":118,"packetsSent":216},"sifSizes":{}},{"label":"camera unpublish VP8 (close flush) #2","sifAudio":0,"sifVideo":6,"sifVideoKey":6,"noMarker":0,"plainOpusSilence":0,"decrypted":153,"videoEnqueued":0,"videoDecoded":0,"videoRendered":3,"videoTracks":[],"presentedSizes":{"320x240":3},"publisherVideoSent":{"framesEncoded":-118,"packetsSent":-216},"sifSizes":{"video/key:74":6}},{"label":"camera republish VP8 #2","sifAudio":0,"sifVideo":0,"sifVideoKey":0,"noMarker":0,"plainOpusSilence":0,"decrypted":299,"videoEnqueued":97,"videoDecoded":97,"videoRendered":251,"videoTracks":[{"id":"db801518","decoded":97,"enqueued":97}],"presentedSizes":{"320x240":251},"publisherVideoSent":{"framesEncoded":117,"packetsSent":216},"sifSizes":{}},{"label":"camera unpublish VP8 (close flush) #3","sifAudio":0,"sifVideo":6,"sifVideoKey":6,"noMarker":0,"plainOpusSilence":0,"decrypted":154,"videoEnqueued":1,"videoDecoded":0,"videoRendered":4,"videoTracks":[],"presentedSizes":{"320x240":4},"publisherVideoSent":{"framesEncoded":-117,"packetsSent":-216},"sifSizes":{"video/key:74":6}},{"label":"mic unpublish (close flush) #1","sifAudio":11,"sifVideo":0,"sifVideoKey":0,"noMarker":0,"plainOpusSilence":0,"decrypted":0,"videoEnqueued":0,"videoDecoded":0,"videoRendered":0,"videoTracks":[],"presentedSizes":{},"publisherVideoSent":{"framesEncoded":0,"packetsSent":0},"sifSizes":{"audio:123":11}},{"label":"mic republish #1","sifAudio":0,"sifVideo":0,"sifVideoKey":0,"noMarker":0,"plainOpusSilence":0,"decrypted":148,"videoEnqueued":0,"videoDecoded":0,"videoRendered":0,"videoTracks":[],"presentedSizes":{},"publisherVideoSent":{"framesEncoded":0,"packetsSent":0},"sifSizes":{}},{"label":"mic unpublish (close flush) #2","sifAudio":11,"sifVideo":0,"sifVideoKey":0,"noMarker":0,"plainOpusSilence":0,"decrypted":0,"videoEnqueued":0,"videoDecoded":0,"videoRendered":0,"videoTracks":[],"presentedSizes":{},"publisherVideoSent":{"framesEncoded":0,"packetsSent":0},"sifSizes":{"audio:123":11}},{"label":"mic republish #2","sifAudio":0,"sifVideo":0,"sifVideoKey":0,"noMarker":0,"plainOpusSilence":0,"decrypted":148,"videoEnqueued":0,"videoDecoded":0,"videoRendered":0,"videoTracks":[],"presentedSizes":{},"publisherVideoSent":{"framesEncoded":0,"packetsSent":0},"sifSizes":{}},{"label":"mic unpublish (close flush) #3","sifAudio":11,"sifVideo":0,"sifVideoKey":0,"noMarker":0,"plainOpusSilence":0,"decrypted":0,"videoEnqueued":0,"videoDecoded":0,"videoRendered":0,"videoTracks":[],"presentedSizes":{},"publisherVideoSent":{"framesEncoded":0,"packetsSent":0},"sifSizes":{"audio:123":11}},{"label":"mic republish #3","sifAudio":0,"sifVideo":0,"sifVideoKey":0,"noMarker":0,"plainOpusSilence":0,"decrypted":148,"videoEnqueued":0,"videoDecoded":0,"videoRendered":0,"videoTracks":[],"presentedSizes":{},"publisherVideoSent":{"framesEncoded":0,"packetsSent":0},"sifSizes":{}}],"ranges":{"micMute":{"n":3,"values":[51,51,51],"min":51,"max":51,"lower":40,"upper":64},"micClose":{"n":3,"values":[11,11,11],"min":11,"max":11,"lower":8,"upper":14},"cameraMuteVP8":{"n":3,"values":[0,0,0],"min":0,"max":0,"lower":0,"upper":0},"cameraMuteVP8Key":{"n":3,"values":[0,0,0],"min":0,"max":0,"lower":0,"upper":0},"cameraCloseVP8":{"n":2,"values":[6,6],"min":6,"max":6,"lower":4,"upper":8},"cameraCloseVP8ViaH264Switch":{"n":1,"values":[6],"min":6,"max":6,"lower":4,"upper":8},"cameraCloseH264":{"n":1,"values":[0],"min":0,"max":0,"lower":0,"upper":0},"noMarkerAnyPhase":0},"sifSizes":{"audio:123":186,"video/key:74":18},"sifHeads":{"audio:f8fffe00":186,"video:1002009d":18},"totals":{"sif":204,"dropNoMarker":0,"plainOpusSilence":0,"decrypted":4865,"pipeErrors":[]}}
SPIKE sfu-injected.none {"browser":"153.0.8010.12","receiverApi":"streams","canaryMicTrack":"4e70e5c9-4ede-4b64-af9a-fa183c59232d","canaryCameraTrack":"f43beb8e-64c3-4f33-afc1-51e53945dac1","wholeRun":{"mic":{"frames":238,"dec":0,"sif":0,"noMarker":238,"plainSilence":62},"camera":{"frames":485,"dec":0,"sif":0,"noMarker":485,"plainSilence":0},"cameraFramesDecodedByBrowser":0,"cameraFramesRendered":0,"micLoudSamplesBeforeMute":0,"presentedSizes":{}},"duringMute":{"frames":51,"sif":0,"noMarker":51,"plainOpusSilence":51,"enqueued":0},"duringUnmute":{"frames":72,"sif":0,"noMarker":72,"plainOpusSilence":0,"enqueued":0},"duringClose":{"frames":11,"sif":0,"noMarker":11,"plainOpusSilence":11,"enqueued":0},"noMarkerAudioSizes":{"audio:3":9,"audio:1":14,"audio:201":1,"audio:161":1,"audio:121":86,"audio:119":1,"audio:123":2,"audio:136":1,"audio:126":2,"audio:152":1,"audio:146":1,"audio:145":2,"audio:141":1,"audio:135":1,"audio:151":1,"audio:144":14,"audio:143":3,"audio:134":7,"audio:125":7,"audio:150":7,"audio:142":7,"audio:128":4,"audio:80":62,"audio:124":1,"audio:129":1,"audio:149":1},"noMarkerAudioHeads":{"audio:fc":119,"audio:dc":57,"audio:f8":62},"sifSizes":{}}
SPIKE sfu-injected.encrypted-firefox {"chromium":"153.0.8010.12","firefox":"155.0","receiverApi":"script","presentedSizes":{"320x240":4447,"1x1":9},"audioLoudSamples":1309,"sifTrailerLen":43,"sifTrailer":"IoWptpSmQ9iys2ODRAJyUiOWRQBTTaXr75UmiP1yRaA","sifTrailerAlnum":true,"setSifTrailerCalls":1,"phases":[{"label":"mic mute #1","sifAudio":51,"sifVideo":0,"sifVideoKey":0,"noMarker":0,"plainOpusSilence":0,"decrypted":207,"videoEnqueued":207,"videoDecoded":207,"videoRendered":207,"videoTracks":[{"id":"{fe1b47f","decoded":207,"enqueued":207}],"presentedSizes":{"320x240":207},"publisherVideoSent":{"framesEncoded":208,"packetsSent":400},"sifSizes":{"audio:123":51}},{"label":"mic unmute #1","sifAudio":0,"sifVideo":0,"sifVideoKey":0,"noMarker":0,"plainOpusSilence":0,"decrypted":239,"videoEnqueued":89,"videoDecoded":90,"videoRendered":90,"videoTracks":[{"id":"{fe1b47f","decoded":90,"enqueued":89}],"presentedSizes":{"320x240":90},"publisherVideoSent":{"framesEncoded":89,"packetsSent":174},"sifSizes":{}},{"label":"mic mute #2","sifAudio":51,"sifVideo":0,"sifVideoKey":0,"noMarker":0,"plainOpusSilence":0,"decrypted":209,"videoEnqueued":208,"videoDecoded":208,"videoRendered":208,"videoTracks":[{"id":"{fe1b47f","decoded":208,"enqueued":208}],"presentedSizes":{"320x240":208},"publisherVideoSent":{"framesEncoded":208,"packetsSent":400},"sifSizes":{"audio:123":51}},{"label":"mic unmute #2","sifAudio":0,"sifVideo":0,"sifVideoKey":0,"noMarker":0,"plainOpusSilence":0,"decrypted":241,"videoEnqueued":91,"videoDecoded":91,"videoRendered":91,"videoTracks":[{"id":"{fe1b47f","decoded":91,"enqueued":91}],"presentedSizes":{"320x240":91},"publisherVideoSent":{"framesEncoded":91,"packetsSent":180},"sifSizes":{}},{"label":"mic mute #3","sifAudio":51,"sifVideo":0,"sifVideoKey":0,"noMarker":0,"plainOpusSilence":0,"decrypted":209,"videoEnqueued":209,"videoDecoded":209,"videoRendered":209,"videoTracks":[{"id":"{fe1b47f","decoded":209,"enqueued":209}],"presentedSizes":{"320x240":209},"publisherVideoSent":{"framesEncoded":209,"packetsSent":402},"sifSizes":{"audio:123":51}},{"label":"mic unmute #3","sifAudio":0,"sifVideo":0,"sifVideoKey":0,"noMarker":0,"plainOpusSilence":0,"decrypted":240,"videoEnqueued":90,"videoDecoded":90,"videoRendered":90,"videoTracks":[{"id":"{fe1b47f","decoded":90,"enqueued":90}],"presentedSizes":{"320x240":90},"publisherVideoSent":{"framesEncoded":91,"packetsSent":182},"sifSizes":{}},{"label":"camera mute VP8 #1","sifAudio":0,"sifVideo":0,"sifVideoKey":0,"noMarker":0,"plainOpusSilence":0,"decrypted":150,"videoEnqueued":0,"videoDecoded":1,"videoRendered":2,"videoTracks":[{"id":"{fe1b47f","decoded":1,"enqueued":0}],"presentedSizes":{"320x240":1,"1x1":1},"publisherVideoSent":{"framesEncoded":0,"packetsSent":0},"sifSizes":{}},{"label":"camera unmute VP8 #1","sifAudio":0,"sifVideo":0,"sifVideoKey":0,"noMarker":0,"plainOpusSilence":0,"decrypted":238,"videoEnqueued":88,"videoDecoded":87,"videoRendered":87,"videoTracks":[{"id":"{fe1b47f","decoded":87,"enqueued":88}],"presentedSizes":{"320x240":87},"publisherVideoSent":{"framesEncoded":88,"packetsSent":169},"sifSizes":{}},{"label":"camera mute VP8 #2","sifAudio":0,"sifVideo":0,"sifVideoKey":0,"noMarker":0,"plainOpusSilence":0,"decrypted":151,"videoEnqueued":0,"videoDecoded":0,"videoRendered":1,"videoTracks":[{"id":"{fe1b47f","decoded":0,"enqueued":0}],"presentedSizes":{"1x1":1},"publisherVideoSent":{"framesEncoded":0,"packetsSent":0},"sifSizes":{}},{"label":"camera unmute VP8 #2","sifAudio":0,"sifVideo":0,"sifVideoKey":0,"noMarker":0,"plainOpusSilence":0,"decrypted":238,"videoEnqueued":88,"videoDecoded":87,"videoRendered":87,"videoTracks":[{"id":"{fe1b47f","decoded":87,"enqueued":88}],"presentedSizes":{"320x240":87},"publisherVideoSent":{"framesEncoded":88,"packetsSent":168},"sifSizes":{}},{"label":"camera mute VP8 #3","sifAudio":0,"sifVideo":0,"sifVideoKey":0,"noMarker":0,"plainOpusSilence":0,"decrypted":150,"videoEnqueued":0,"videoDecoded":1,"videoRendered":2,"videoTracks":[{"id":"{fe1b47f","decoded":1,"enqueued":0}],"presentedSizes":{"320x240":1,"1x1":1},"publisherVideoSent":{"framesEncoded":0,"packetsSent":0},"sifSizes":{}},{"label":"camera unmute VP8 #3","sifAudio":0,"sifVideo":0,"sifVideoKey":0,"noMarker":0,"plainOpusSilence":0,"decrypted":239,"videoEnqueued":88,"videoDecoded":87,"videoRendered":87,"videoTracks":[{"id":"{fe1b47f","decoded":87,"enqueued":88}],"presentedSizes":{"320x240":87},"publisherVideoSent":{"framesEncoded":88,"packetsSent":168},"sifSizes":{}},{"label":"camera unpublish VP8 (close flush) #1","sifAudio":0,"sifVideo":6,"sifVideoKey":6,"noMarker":0,"plainOpusSilence":0,"decrypted":152,"videoEnqueued":0,"videoDecoded":0,"videoRendered":1,"videoTracks":[],"presentedSizes":{"1x1":1},"publisherVideoSent":{"framesEncoded":-1280,"packetsSent":-2469},"sifSizes":{"video/key:74":6}},{"label":"camera republish VP8 #1","sifAudio":0,"sifVideo":0,"sifVideoKey":0,"noMarker":0,"plainOpusSilence":0,"decrypted":319,"videoEnqueued":117,"videoDecoded":116,"videoRendered":233,"videoTracks":[{"id":"{fe1b47f","decoded":116,"enqueued":117}],"presentedSizes":{"320x240":232},"publisherVideoSent":{"framesEncoded":118,"packetsSent":219},"sifSizes":{}},{"label":"camera unpublish VP8 (close flush) #2","sifAudio":0,"sifVideo":6,"sifVideoKey":6,"noMarker":0,"plainOpusSilence":0,"decrypted":152,"videoEnqueued":0,"videoDecoded":0,"videoRendered":4,"videoTracks":[],"presentedSizes":{"320x240":2,"1x1":2},"publisherVideoSent":{"framesEncoded":-118,"packetsSent":-219},"sifSizes":{"video/key:74":6}},{"label":"camera republish VP8 #2","sifAudio":0,"sifVideo":0,"sifVideoKey":0,"noMarker":0,"plainOpusSilence":0,"decrypted":300,"videoEnqueued":98,"videoDecoded":97,"videoRendered":292,"videoTracks":[{"id":"{fe1b47f","decoded":97,"enqueued":98}],"presentedSizes":{"320x240":292},"publisherVideoSent":{"framesEncoded":117,"packetsSent":210},"sifSizes":{}},{"label":"camera unpublish VP8 (close flush) #3","sifAudio":0,"sifVideo":6,"sifVideoKey":6,"noMarker":0,"plainOpusSilence":0,"decrypted":152,"videoEnqueued":0,"videoDecoded":0,"videoRendered":6,"videoTracks":[],"presentedSizes":{"320x240":3,"1x1":3},"publisherVideoSent":{"framesEncoded":-117,"packetsSent":-210},"sifSizes":{"video/key:74":6}},{"label":"camera republish VP8 #3","sifAudio":0,"sifVideo":0,"sifVideoKey":0,"noMarker":0,"plainOpusSilence":0,"decrypted":318,"videoEnqueued":116,"videoDecoded":115,"videoRendered":461,"videoTracks":[{"id":"{fe1b47f","decoded":115,"enqueued":116}],"presentedSizes":{"320x240":460},"publisherVideoSent":{"framesEncoded":117,"packetsSent":222},"sifSizes":{}},{"label":"mic unpublish (close flush) #1","sifAudio":11,"sifVideo":0,"sifVideoKey":0,"noMarker":0,"plainOpusSilence":0,"decrypted":90,"videoEnqueued":90,"videoDecoded":90,"videoRendered":360,"videoTracks":[{"id":"{fe1b47f","decoded":90,"enqueued":90}],"presentedSizes":{"320x240":360},"publisherVideoSent":{"framesEncoded":90,"packetsSent":175},"sifSizes":{"audio:123":11}},{"label":"mic republish #1","sifAudio":0,"sifVideo":0,"sifVideoKey":0,"noMarker":0,"plainOpusSilence":0,"decrypted":239,"videoEnqueued":91,"videoDecoded":90,"videoRendered":360,"videoTracks":[{"id":"{fe1b47f","decoded":90,"enqueued":91}],"presentedSizes":{"320x240":360},"publisherVideoSent":{"framesEncoded":91,"packetsSent":177},"sifSizes":{}},{"label":"mic unpublish (close flush) #2","sifAudio":11,"sifVideo":0,"sifVideoKey":0,"noMarker":0,"plainOpusSilence":0,"decrypted":92,"videoEnqueued":91,"videoDecoded":91,"videoRendered":364,"videoTracks":[{"id":"{fe1b47f","decoded":91,"enqueued":91}],"presentedSizes":{"320x240":364},"publisherVideoSent":{"framesEncoded":91,"packetsSent":182},"sifSizes":{"audio:123":11}},{"label":"mic republish #2","sifAudio":0,"sifVideo":0,"sifVideoKey":0,"noMarker":0,"plainOpusSilence":0,"decrypted":239,"videoEnqueued":91,"videoDecoded":90,"videoRendered":360,"videoTracks":[{"id":"{fe1b47f","decoded":90,"enqueued":91}],"presentedSizes":{"320x240":360},"publisherVideoSent":{"framesEncoded":91,"packetsSent":175},"sifSizes":{}},{"label":"mic unpublish (close flush) #3","sifAudio":11,"sifVideo":0,"sifVideoKey":0,"noMarker":0,"plainOpusSilence":0,"decrypted":91,"videoEnqueued":90,"videoDecoded":90,"videoRendered":360,"videoTracks":[{"id":"{fe1b47f","decoded":90,"enqueued":90}],"presentedSizes":{"320x240":360},"publisherVideoSent":{"framesEncoded":90,"packetsSent":174},"sifSizes":{"audio:123":11}},{"label":"mic republish #3","sifAudio":0,"sifVideo":0,"sifVideoKey":0,"noMarker":0,"plainOpusSilence":0,"decrypted":239,"videoEnqueued":91,"videoDecoded":90,"videoRendered":360,"videoTracks":[{"id":"{fe1b47f","decoded":90,"enqueued":91}],"presentedSizes":{"320x240":360},"publisherVideoSent":{"framesEncoded":91,"packetsSent":177},"sifSizes":{}}],"ranges":{"micMute":{"n":3,"values":[51,51,51],"min":51,"max":51,"lower":40,"upper":64},"micClose":{"n":3,"values":[11,11,11],"min":11,"max":11,"lower":8,"upper":14},"cameraMuteVP8":{"n":3,"values":[0,0,0],"min":0,"max":0,"lower":0,"upper":0},"cameraMuteVP8Key":{"n":3,"values":[0,0,0],"min":0,"max":0,"lower":0,"upper":0},"cameraCloseVP8":{"n":3,"values":[6,6,6],"min":6,"max":6,"lower":4,"upper":8},"cameraCloseVP8ViaH264Switch":{"n":0},"cameraCloseH264":{"n":0},"noMarkerAnyPhase":0},"sifSizes":{"audio:123":186,"video/key:74":18},"sifHeads":{"audio:f8fffe00":186,"video:1002009d":18},"totals":{"sif":204,"dropNoMarker":0,"plainOpusSilence":0,"decrypted":5220,"pipeErrors":[]}}
SPIKE sfu-injected.none-firefox {"chromium":"153.0.8010.12","firefox":"155.0","receiverApi":"script","canaryMicTrack":"{065d1d69-0f6e-40e2-901d-858d898d492a}","canaryCameraTrack":"{894b04e1-8afb-4bba-9d20-9188eaeca56e}","wholeRun":{"mic":{"frames":239,"dec":0,"sif":0,"noMarker":239,"plainSilence":62},"camera":{"frames":501,"dec":0,"sif":0,"noMarker":501,"plainSilence":0},"cameraFramesDecodedByBrowser":0,"cameraFramesRendered":0,"micLoudSamplesBeforeMute":0,"presentedSizes":{}},"duringMute":{"frames":51,"sif":0,"noMarker":51,"plainOpusSilence":51,"enqueued":0},"duringUnmute":{"frames":72,"sif":0,"noMarker":72,"plainOpusSilence":0,"enqueued":0},"duringClose":{"frames":11,"sif":0,"noMarker":11,"plainOpusSilence":11,"enqueued":0},"noMarkerAudioSizes":{"audio:3":10,"audio:1":14,"audio:201":1,"audio:161":1,"audio:121":86,"audio:119":1,"audio:123":2,"audio:136":1,"audio:126":2,"audio:152":1,"audio:146":1,"audio:145":2,"audio:141":1,"audio:135":1,"audio:151":1,"audio:144":14,"audio:143":3,"audio:134":7,"audio:125":7,"audio:150":7,"audio:142":7,"audio:128":4,"audio:80":62,"audio:124":1,"audio:129":1,"audio:149":1},"noMarkerAudioHeads":{"audio:fc":120,"audio:dc":57,"audio:f8":62},"sifSizes":{}}
```
