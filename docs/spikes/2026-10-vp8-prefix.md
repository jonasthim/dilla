# SP-05 VP8 prefix: key 10, delta 1 held

- Date: 2026-10-03. Commit: 691db1f (the spike spec `e2e/spikes/vp8-prefix.spec.ts` was in the working tree, uncommitted, during the run).
- Box: CachyOS, kernel 7.2.7-1-cachyos; Node 24.15.0; Playwright 1.63.0 with Chromium 153.0.8010.12 and Firefox 155.0; `GOMAXPROCS=4`.
- SFU: LiveKit v1.13.7 in process (`dilla-testhost -sfu`: node_ip 127.0.0.1, enable_loopback_candidate, advertise_internal_ip)
- Rig: `e2e/spikes/vp8-prefix.spec.ts` on the task 1 harness; the stub worker's `xor` mode keeps the bytes the VP8 P bit selects clear (key → `keyPrefix`, delta → `deltaPrefix`), writes the 11-byte header `9f 03 29 01 00 00 00 <seq32>`, XORs the rest with an xorshift keystream from the first encrypted byte on, and appends a 16-byte tag stand-in carrying the seed; the receiver reverses it from the bytes alone. Publisher: the fake camera, VP8, no simulcast. Window 10 s per run.

## Question

Does VP8 decode after the receiver strips a 1-byte (delta) / 10-byte (key) clear prefix, an SFrame-shaped header and a 16-byte tag, through LiveKit, in both directions between Chromium 153 and Firefox 155; and does 0 clear bytes fail?

## Results

| direction | clear bytes key/delta | publisher frames sent (key/delta) | subscriber frames opened (key/delta) | refused by the stub (`short`) | subscriber decode | `pliCount` (Chromium subscriber) | result |
|---|---|---|---|---|---|---|---|
| Chromium → Firefox | 10 / 1 | 2 / 238 | 1 / 226 | 0 | 40 video frames rendered in the 2 s `requestVideoFrameCallback` probe | — (Firefox resets inbound-rtp under a transform) | PASS |
| Firefox → Chromium | 10 / 1 | 3 / 195 | 2 / 183 | 0 | `framesDecoded` 185, `keyFramesDecoded` 2 (`packetsReceived` 185) | 0 | PASS |
| Chromium → Firefox | 0 / 0 | 22 / 217 | 0 / 0 | 0 | 0 rendered frames | — | PASS (negative control) |
| Firefox → Chromium | 0 / 0 | 18 / 180 | 0 / 0 | 0 | `framesDecoded` 0, `packetsReceived` 0 | 0 | PASS (negative control) |

The pass criterion was met on every row: Chromium subscriber `framesDecoded` 185 > 100, `keyFramesDecoded` 2 > 0, `pliCount` 0 ≤ 5; Firefox subscriber 40 rendered frames > 20 in 2 s and `decKey` 1 > 0; `short` 0 everywhere; nothing decoded at 0/0 in either direction. The playwright run: `3 passed (51.2s)`, the three `spike-firefox` copies skipped by design.

Fallback run (key 10, delta 3): not run: 10/1 passed

Repeat run: the whole spec was run a second time on the same box, same commit, to check the result is stable: `3 passed (48.8s)`, every counter identical to the table above except the 0/0 Chromium → Firefox publisher key-frame count (21 instead of 22). Its four lines are under Raw output.

- `typeBitMismatch` on the publisher: Chromium 0, Firefox 0 (0 means `frame.type` and the VP8 P bit agree on every sender frame).
- 0/0 legs: the Chromium subscriber's `packetsReceived` was 0, and the Firefox subscriber's stub saw no frame at all (`dec` 0, `short` 0): LiveKit never opened the downtrack in either direction, because its forwarder waits for a key frame it recognises from the payload (`IsKeyFrame` set at mediatransportutil `pkg/codec/vp8.go:148` and `:155` from the P bit and S bit, `ExtractVP8VideoSize` at `:231-251`; the simulcast layer selector latches only on `extPkt.IsKeyFrame`, livekit-server v1.13.7 `pkg/sfu/videolayerselector/simulcast.go:87-119`). With the P bit encrypted, byte 0 is the header's `0x9f`, whose bit 0 is 1, so LiveKit reads every frame as a delta frame. The publishers' key-frame counts rose from 2 and 3 at 10/1 to 22 and 18 at 0/0. That fits a forwarder that keeps asking the publisher for a key frame and never recognises one, but this run did not capture the RTCP to prove it.

## Decision (consumed by task 4)

`VP8_KEY_PREFIX = 10`, `VP8_DELTA_PREFIX = 1`: a VP8 frame keeps the 10-byte uncompressed chunk clear when `frame[0] & 1 == 0` (a key frame; shorter is `E_SFRAME_MALFORMED_PREFIX`) and only byte 0 otherwise. livekit-client's 3-byte delta prefix is not copied. The plan's expectation held.

## Raw output

```
SP-05 RESULT {"publisher":"chromium","mode":{"kind":"xor","keyPrefix":10,"deltaPrefix":1,"sframeLayout":true},"subscriberRemote":[],"subscriberRender":[{"participantIdentity":"685ddbde7ae0bb1b3def00e4d56c7000","kind":"video","frames":40,"rms":0}],"publisherStub":{"transforms":7,"enc":240,"dec":0,"pass":0,"drop":0,"short":0,"sif":0,"errors":0,"encKey":2,"encDelta":238,"decKey":0,"decDelta":0,"typeBitMismatch":0,"logged":0},"subscriberStub":{"transforms":7,"enc":0,"dec":227,"pass":0,"drop":0,"short":0,"sif":0,"errors":0,"encKey":0,"encDelta":0,"decKey":1,"decDelta":226,"typeBitMismatch":0,"logged":0}}
SP-05 RESULT {"publisher":"firefox","mode":{"kind":"xor","keyPrefix":10,"deltaPrefix":1,"sframeLayout":true},"subscriberRemote":[{"participantIdentity":"77124d01da9d6efb2bce7ef43f159b59","kind":"video","source":"camera","framesDecoded":185,"keyFramesDecoded":2,"packetsReceived":185,"totalSamplesReceived":0,"pliCount":0}],"subscriberRender":[],"publisherStub":{"transforms":7,"enc":198,"dec":0,"pass":0,"drop":0,"short":0,"sif":0,"errors":0,"encKey":3,"encDelta":195,"decKey":0,"decDelta":0,"typeBitMismatch":0,"logged":0},"subscriberStub":{"transforms":6,"enc":0,"dec":185,"pass":0,"drop":0,"short":0,"sif":0,"errors":0,"encKey":0,"encDelta":0,"decKey":2,"decDelta":183,"typeBitMismatch":0,"logged":0}}
SP-05 RESULT {"publisher":"chromium","mode":{"kind":"xor","keyPrefix":0,"deltaPrefix":0,"sframeLayout":true},"subscriberRemote":[],"subscriberRender":[{"participantIdentity":"88450f5e7f6d0171bb43d963308acb5c","kind":"video","frames":0,"rms":0}],"publisherStub":{"transforms":7,"enc":239,"dec":0,"pass":0,"drop":0,"short":0,"sif":0,"errors":0,"encKey":22,"encDelta":217,"decKey":0,"decDelta":0,"typeBitMismatch":0,"logged":0},"subscriberStub":{"transforms":7,"enc":0,"dec":0,"pass":0,"drop":0,"short":0,"sif":0,"errors":0,"encKey":0,"encDelta":0,"decKey":0,"decDelta":0,"typeBitMismatch":0,"logged":0}}
SP-05 RESULT {"publisher":"firefox","mode":{"kind":"xor","keyPrefix":0,"deltaPrefix":0,"sframeLayout":true},"subscriberRemote":[{"participantIdentity":"b865ac9aa3c6ca28c72ee566f024ed62","kind":"video","source":"camera","framesDecoded":0,"keyFramesDecoded":0,"packetsReceived":0,"totalSamplesReceived":0,"pliCount":0}],"subscriberRender":[],"publisherStub":{"transforms":7,"enc":198,"dec":0,"pass":0,"drop":0,"short":0,"sif":0,"errors":0,"encKey":18,"encDelta":180,"decKey":0,"decDelta":0,"typeBitMismatch":0,"logged":0},"subscriberStub":{"transforms":6,"enc":0,"dec":0,"pass":0,"drop":0,"short":0,"sif":0,"errors":0,"encKey":0,"encDelta":0,"decKey":0,"decDelta":0,"typeBitMismatch":0,"logged":0}}
```

Repeat run (same box, same commit):

```
SP-05 RESULT {"publisher":"chromium","mode":{"kind":"xor","keyPrefix":10,"deltaPrefix":1,"sframeLayout":true},"subscriberRemote":[],"subscriberRender":[{"participantIdentity":"e0c38d19e0255f37fe66c11351a1df82","kind":"video","frames":40,"rms":0}],"publisherStub":{"transforms":7,"enc":240,"dec":0,"pass":0,"drop":0,"short":0,"sif":0,"errors":0,"encKey":2,"encDelta":238,"decKey":0,"decDelta":0,"typeBitMismatch":0,"logged":0},"subscriberStub":{"transforms":7,"enc":0,"dec":227,"pass":0,"drop":0,"short":0,"sif":0,"errors":0,"encKey":0,"encDelta":0,"decKey":1,"decDelta":226,"typeBitMismatch":0,"logged":0}}
SP-05 RESULT {"publisher":"firefox","mode":{"kind":"xor","keyPrefix":10,"deltaPrefix":1,"sframeLayout":true},"subscriberRemote":[{"participantIdentity":"e724a5a170fb1a7b496bf83547152847","kind":"video","source":"camera","framesDecoded":185,"keyFramesDecoded":2,"packetsReceived":185,"totalSamplesReceived":0,"pliCount":0}],"subscriberRender":[],"publisherStub":{"transforms":7,"enc":198,"dec":0,"pass":0,"drop":0,"short":0,"sif":0,"errors":0,"encKey":3,"encDelta":195,"decKey":0,"decDelta":0,"typeBitMismatch":0,"logged":0},"subscriberStub":{"transforms":6,"enc":0,"dec":185,"pass":0,"drop":0,"short":0,"sif":0,"errors":0,"encKey":0,"encDelta":0,"decKey":2,"decDelta":183,"typeBitMismatch":0,"logged":0}}
SP-05 RESULT {"publisher":"chromium","mode":{"kind":"xor","keyPrefix":0,"deltaPrefix":0,"sframeLayout":true},"subscriberRemote":[],"subscriberRender":[{"participantIdentity":"9be557a4536bf5f7ef5fb48f90858ad8","kind":"video","frames":0,"rms":0}],"publisherStub":{"transforms":7,"enc":239,"dec":0,"pass":0,"drop":0,"short":0,"sif":0,"errors":0,"encKey":21,"encDelta":218,"decKey":0,"decDelta":0,"typeBitMismatch":0,"logged":0},"subscriberStub":{"transforms":7,"enc":0,"dec":0,"pass":0,"drop":0,"short":0,"sif":0,"errors":0,"encKey":0,"encDelta":0,"decKey":0,"decDelta":0,"typeBitMismatch":0,"logged":0}}
SP-05 RESULT {"publisher":"firefox","mode":{"kind":"xor","keyPrefix":0,"deltaPrefix":0,"sframeLayout":true},"subscriberRemote":[{"participantIdentity":"0e78e98f8f7d28869c4aefd7948b74d2","kind":"video","source":"camera","framesDecoded":0,"keyFramesDecoded":0,"packetsReceived":0,"totalSamplesReceived":0,"pliCount":0}],"subscriberRender":[],"publisherStub":{"transforms":7,"enc":198,"dec":0,"pass":0,"drop":0,"short":0,"sif":0,"errors":0,"encKey":18,"encDelta":180,"decKey":0,"decDelta":0,"typeBitMismatch":0,"logged":0},"subscriberStub":{"transforms":6,"enc":0,"dec":0,"pass":0,"drop":0,"short":0,"sif":0,"errors":0,"encKey":0,"encDelta":0,"decKey":0,"decDelta":0,"typeBitMismatch":0,"logged":0}}
```
