# 05 — Media frames (`dilla-sframe/1`)

Every content-bearing audio, video and screen-share frame in a `call` group is encrypted per frame
by the sender and forwarded opaquely by the SFU. The construction is RFC 9605 (SFrame), suite `0x0004`, with one
clear codec prefix per frame so that WebRTC depacketisers and the SFU keep working. The prefixes are
the bytes libwebrtc's depacketisers read (for VP8, VP9 and Opus the same bytes Discord's DAVE
leaves clear); H.264 escaping is libwebrtc's `WriteRbsp`/`ParseRbsp`, not DAVE's nonce retry, which
cannot work here because a counter on slot 1 or above always carries `00 00 00`. It is **not**
byte-compatible with DAVE.

## Frame format

```
[ clear codec prefix P ][ E( SFrame header H || ciphertext C || 16-byte tag T ) ]
```

The sole exception is a zero-byte audio DTX frame: its transform forwards it unchanged, with no
SFrame header, encryption or counter use. Every non-empty audio frame and every video frame follows
the frame format above; an empty video frame is dropped.

- **AAD** = `H || P` (RFC 9605 §4.4.3's `header || metadata` with metadata = P; the RFC's Appendix C.3
  suite `0x0004` case reproduces only in this order).
- **Cipher**: AES-128-GCM with the per-KID key and the nonce below (suite `0x0004`); the tag is 16 bytes.
- **E** is the identity for Opus, VP8 and VP9. For H.264 it is libwebrtc's `WriteRbsp` with its zero
  counter seeded by the number of `00` bytes `P` ends with (0, 1 or 2): `E(x) = WriteRbsp(00^seed || x)[seed..]`,
  so no start code can form across the boundary. A receiver applies `ParseRbsp` with the same seed
  before it reads `H`.
- One ciphertext per simulcast or SVC layer; each layer has its own counter `layer` field.
- The SFrame header is RFC 9605 §4.3: one config byte laid out as `(X << 7) | (K << 4) | (Y << 3) | C`
  per the RFC's Figure 3 (X and Y flag extended KID and CTR lengths), then the extended KID and CTR
  bytes. A receiver MUST refuse a header that is not minimally encoded — an extended field holding
  0-7, or a field longer than one byte with a leading `00` — with `E_SFRAME_NON_MINIMAL_HEADER`,
  checking in reading order (the config byte, the KID field, the CTR field; truncation before
  minimality). Every header of RFC 9605 Appendix C.1 decodes. RFC 9605 §4.3 has senders use the
  minimal form; dilla-sframe/1 makes it mandatory for receivers, so every KID and CTR has exactly
  one accepted spelling.
- **Canonical KID.** A dilla KID is `(leaf_index << 8) | (epoch mod 256)` with `leaf_index` < 2^16,
  so it is below 2^24 ("Key schedule"). A header whose KID is 2^24 or more is a valid RFC 9605
  header but no dilla KID: a receiver MUST refuse it with `E_SFRAME_NON_CANONICAL_KID` as part of
  decoding the header, after the minimality checks and before it resolves an epoch, looks up a key
  or derives one. The reason is that the key schedule hashes all 64 bits of the KID while the
  epoch and roster checks read only the low 24, so without this rule one sender would have 2^40
  spellings of its KID that pass every check up to the AEAD, each costing the receiver an HKDF
  derivation and a cached key — unbounded work and memory for anyone who can put frames on a
  track, the SFU included, and two implementations could disagree on which spellings they accept.
  A receiver therefore holds at most one key per leaf of each held epoch's roster. The code is a
  parse failure: the frame is dropped and counted, never held. A sender only ever emits
  `Kid(leaf_index, epoch)`, and an API that takes a raw KID refuses one of 2^24 or more the same way.
- Overhead per frame: `1 + len(KID) + len(CTR) + 16` bytes, at most 28 before H.264 escaping; on
  slot 1 or above the CTR is always 8 bytes.

## Codec prefixes

The prefix is the minimum a depacketiser and the SFU need in the clear. Sender and receiver compute
it with the same function over the same clear bytes, so it has no length field.

| codec | clear prefix |
|---|---|
| Opus | 0 bytes |
| VP8 | key frame (`frame[0] & 1 == 0`): the 10-byte uncompressed chunk (frame tag, start code, both size fields), and a key frame shorter than 10 bytes is `E_SFRAME_MALFORMED_PREFIX`; inter frame: 1 byte (verified through LiveKit in both directions between Chromium 153 and Firefox 155 by SP-05) |
| VP9 | 0 bytes (the RTP payload descriptor carries what the depacketiser and the SFU read) |
| H.264 | the rule below |
| AV1, H.265, RED, PCMU/PCMA | not supported at media_version 1; a client MUST NOT negotiate them in a `call` group (livekit-client already turns RED off under E2EE) |

**H.264.**

1. The frame MUST begin with a start code. NAL units are found as libwebrtc's `H264::FindNaluIndices`
   finds them: a `00` before `00 00 01` belongs to the start code, and bytes before the first start
   code belong to no NAL unit.
2. The sender rewrites the frame as `concat(00 00 00 01 || nal)` over those NAL units (leading bytes
   dropped, trailing zeros kept), because libwebrtc's receiver rebuilds every frame with 4-byte start
   codes and `P` is authenticated.
3. NAL units of types 6-18, 22 and 23 before the first VCL NAL unit are clear. Type 0 or 24-31 is
   `E_SFRAME_MALFORMED_PREFIX`.
4. The first NAL unit of a type in {1, 2, 3, 4, 5, 19, 20, 21} ends the walk. Types 2-4 and 19-21
   are `E_SFRAME_UNSUPPORTED_CODEC`. For types 1 and 5, `P` runs through that NAL unit's header and
   the bytes covering its first three `ue(v)` fields — `first_mb_in_slice`, `slice_type`,
   `pic_parameter_set_id` — read bit by bit, skipping the `03` of a `00 00 03` that starts a byte,
   as `floor(bits / 8) + 1` bytes (libdave `BytesCoveringH264PPS`). Fields that run past the NAL unit,
   or a `pic_parameter_set_id` above 255, are `E_SFRAME_MALFORMED_PREFIX`. libwebrtc parses these
   three fields of every slice and drops a packet it cannot parse.
5. A frame with no VCL NAL unit is `E_SFRAME_NO_VCL_NAL`: the sender refuses it and the receiver drops
   and counts it. It is never sent in the clear.
6. Everything after the cut, later slices included, is one escaped ciphertext. So
   `packetization-mode=1` is REQUIRED (`level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f`),
   mode 0 MUST NOT be negotiated in a `call` group, and call SDP MUST NOT carry
   `sprop-parameter-sets` (a receiver would prepend the parameter sets to every IDR and change `P`).
7. Every SPS in `P` MUST pass libwebrtc's incoming VUI check — `vui_parameters_present_flag = 1`,
   `bitstream_restriction_flag = 1`, `max_num_reorder_frames = 0`,
   `max_dec_frame_buffering ≤ max_num_ref_frames` — or a receiver rewrites it and the AAD fails. A
   sender refuses such a frame with `E_SFRAME_NON_CANONICAL_SPS`. A browser already satisfies this
   (libwebrtc rewrites key-frame SPS before the transform; SP-04 saw no SPS in a delta frame); a
   publisher that is not libwebrtc rewrites its SPS first.

Example, verified byte-identical through LiveKit by SP-04: Chromium 153's camera key-frame prefix
`00 00 00 01 67 42 c0 15 8c 68 14 1f 20 1e 11 08 d4 00 00 00 01 68 ce 3c 80 00 00 00 01 65 b8` (SPS,
PPS, the IDR header and the one slice-header byte that covers `pic_parameter_set_id`).

## Key schedule

- `base_key = MLS-Exporter("SFrame 1.0 Base Key", "", 16)` from the `call` group's current epoch,
  where `MLS-Exporter(Label, Context, Length) = ExpandWithLabel(DeriveSecret(exporter_secret,
  Label), "exported", Hash(Context), Length)` (RFC 9420 §8.5).
- `KID = (leaf_index << 8) | (epoch mod 256)` (24 bits used; `leaf_index` < 2^16). A received KID
  of 2^24 or more is refused before any derivation ("Frame format", canonical KID).
- `sframe_secret = HKDF-Extract(salt = "", IKM = base_key)` (RFC 9605 §4.4.2; the Appendix C.3 vector for suite 0x0004 is the check);
  `key = HKDF-Expand(sframe_secret, "SFrame 1.0 Secret key " || KID(8, big-endian) || 0x0004, 16)`;
  `salt = HKDF-Expand(sframe_secret, "SFrame 1.0 Secret salt " || KID(8) || 0x0004, 12)`.
- Every member derives every other member's key from the shared `base_key` and the sender's
  `KID`. Which frames a member accepts is "Receiver rules" below.

## Counter partition

`CTR` is a 64-bit value: `slot (8 bits) || layer (4 bits) || seq (52 bits)`. Slots: 0 microphone,
1 camera, 2 screen video, 3 screen audio; further slots reserved. `seq` starts at 0 per
`(epoch, KID, slot, layer)` and increments per frame. A sender MUST stop and rekey (send an MLS
`Update`) rather than use a `seq` above 2^52 − 1 (`E_SFRAME_COUNTER_EXHAUSTED`); it MUST NOT wrap. A
layer above 15 is `E_SFRAME_LAYER_RANGE`. `nonce = salt XOR CTR` (CTR big-endian, left-padded to
12 bytes).

## Sender uniqueness

A `(KID, CTR)` pair MUST seal exactly one frame (RFC 9605 §4.3, §7.4). A device's KID is fixed
within an epoch, so three rules keep its counters unique across worker restarts, reloads and tabs:

- **N1.** A sender created after its device committed epoch `e_C` — the external commit or own-leaf
  resync that began this sender's life in the call — encrypts only in epochs at or above `e_C`; an
  older epoch is `E_SFRAME_STALE_EPOCH`. A restarted worker therefore never reuses a counter an
  earlier worker spent: it commits a new epoch first.
- **N2.** A browser publishes in a call only while it holds the Web Lock
  `dilla-media:<instance_id>:<call_group_id>`, requested with `mode: 'exclusive'` and
  `ifAvailable: true`, never `steal`. A tab that does not get it does not publish.
- **N3.** `seq` runs per `(epoch, KID, slot, layer)` for the whole life of the sender and is never
  reset by a rekey or by a transform being re-created.

## Rotation

- A new epoch (any Commit) gives every sender a new KID and new keys. Senders switch to the new
  epoch's keys as soon as they have processed the Commit.
- Once the media worker has confirmed an epoch, a later install that times out or fails with
  `E_WASM` ends that worker: the client clears its keys, terminates it, reports the error and stops
  the call's media. It cannot continue sending under the superseded epoch. An initial install
  failure rejects the join, which releases the call lock.
- Receivers keep **every** epoch superseded less than **10 seconds** ago — a join storm makes
  several inside 10 s — each timed from the receiver's own processing of the Commit that superseded
  it, together with that epoch's roster. Installing an epoch evicts any held epoch with the same
  `epoch mod 256` (RFC 9605 §5.2); installing an epoch already held changes nothing and keeps its
  replay windows. A frame whose KID names an epoch the receiver dropped is `E_SFRAME_STALE_EPOCH`.
- A frame whose KID names an epoch the receiver has not installed yet (`E_SFRAME_UNKNOWN_KID`) is
  held; no other failure ever is. The hold is one strict FIFO per receiving track, at most
  **2 000 ms**, **256 frames** and **8 MiB**: while anything is held, later frames of that track
  queue behind it, because an encoded-transform writer drops a frame older than the last one it
  wrote. The hold drains when an epoch is installed and on a timer; a frame past any limit is
  dropped and counted, the oldest first. Held frames are never rendered unless they authenticate.
- Because `KID` carries only `epoch mod 256`, a receiver MUST bind a KID to the exact epoch it
  learned it in and reject a KID that it would have to resolve against an epoch more than 255
  commits ago.
- A removed member cannot decrypt frames after the Commit that removed it, because it does not
  have the new epoch's `exporter_secret`; until that Commit it still decrypts. The window is bounded
  by the Commit, not by the 30-second proposal TTL: the DS re-drives a voided Remove of a `call`
  group whose leaf is still present (`02-delivery-service.md`, invariant 6). The UI shows "removal
  pending" until the epoch changes.

## Receiver rules

A receiving track's expected device is its LiveKit participant identity parsed as a `device_id`
(exactly 32 lowercase hex digits). An identity that does not parse, including any containing `#`,
is an **unverified stream** and is never played. A track whose kind does not match its source
(audio with microphone or screen-share audio, video with camera or screen share) is dropped. The
track's slot comes from its LiveKit `TrackSource`: `MICROPHONE` (2) → 0, `CAMERA` (1) → 1,
`SCREEN_SHARE` (3) → 2, `SCREEN_SHARE_AUDIO` (4) → 3; `UNKNOWN` (0) is refused.

A zero-byte frame on a non-blocking audio decode pipeline passes through unchanged, including
before its track is mapped: it carries no content. It is counted as `emptyFrames` on the receive
side, never as decrypted or verified, never held, and never counted as a drop reason. A blocking
pipeline forwards nothing, and an empty video frame is dropped. The steps below apply to frames
that are not zero-byte audio.

Every received frame is checked in this order. The first failure names its code, and only
`E_SFRAME_UNKNOWN_KID` is held:

1. Compute the codec prefix, unescape (H.264) and decode the header strictly, including the
   canonical-KID rule (`E_SFRAME_TRUNCATED_HEADER`, `E_SFRAME_NON_MINIMAL_HEADER`,
   `E_SFRAME_NON_CANONICAL_KID`). Nothing before this step derives a key.
2. Resolve the KID to its exact held epoch: none → `E_SFRAME_UNKNOWN_KID`; one this receiver
   dropped → `E_SFRAME_STALE_EPOCH`.
3. The KID's leaf MUST be in that epoch's roster (`E_SFRAME_LEAF_NOT_IN_EPOCH`) and MUST be the
   leaf of the track's device in that epoch (`E_SFRAME_SENDER_MISMATCH`); a device holding more than
   one leaf in one epoch is refused the same way. Leaf indices move on a resync and are reused after
   a Remove, so this binding is per epoch.
4. The KID's leaf MUST NOT be the receiver's own leaf in that epoch (`E_SFRAME_OWN_KID`; RFC 9605
   §4.4.1: a key is usable for encryption or decryption, never both).
5. Replay: a window of **128** counters per `(leaf, slot, layer)` and epoch, checked before the
   AEAD: a counter already accepted, or more than 127 below the highest accepted, is
   `E_SFRAME_REPLAY`. The window does not assume in-order arrival.
6. AEAD: `E_SFRAME_AUTH`, dropped at once (the tag comparison is constant-time).
7. The authenticated `ctr.slot` MUST equal the track's slot (`E_SFRAME_SLOT_MISMATCH`).
8. Only then is the counter recorded in the replay window.

A participant whose device is in no held roster yet — a joiner whose external commit this receiver
has not processed — is shown as joining, not as unverified, for as long as its frames can still be
held.

The per-participant encryption status a browser reports (livekit-client's
`participantEncryptionStatusChanged`, whose name the SDK fixes) means only that the participant's
device is in the roster of a held epoch. It does not mean any of its frames authenticated: a member
whose every frame is dropped still has it. A device is **verified** once at least one of its frames
has authenticated. The media worker counts this per device: a frame counts for the device its
publication is mapped to only when every step above passed, so the frame authenticated and step 3
bound its sender leaf to that device. A KID read from the header outside the cipher never counts. The local
participant's status turns false again when the call's media worker fails or the call ends.

## Key frames

- A frame held for an unknown KID and released in order keeps the decoder's reference chain intact,
  so an epoch change needs no key frame when the hold covers it. Measured for holds of 500 to
  2 000 ms: no receiver PLI, no key frame, and a decode gap at most 12 ms longer than the hold
  (`docs/spikes/2026-10-keyframe-recovery.md`).
- When a receiver must drop a video frame for any reason other than a server-injected frame or a
  `NONE` flag (an expired or overflowing hold, a failed tag, an evicted epoch, a frame it cannot
  parse), its decoder stalls until the next key frame.
- A receiver whose transform exposes `RTCRtpScriptTransformer.sendKeyFrameRequest()` MUST call it
  after such a drop and MUST repeat it at most once per 500 ms on that track until a decrypted key
  frame of that track has been passed to the decoder. The request reaches the publisher as an RTCP
  PLI through the SFU, which forwards at most one PLI per 500 ms for the lowest layer and per 1 s
  for the others and drops the rest; another receiver's PLI inside that window swallows a single
  request (measured: recovery 2.45–2.50 s after one request, 0.53–0.57 s with the repeat).
- On Chromium's `createEncodedStreams` path no such request exists. Recovery is libwebrtc's own PLI,
  measured 3 010–3 013 ms after the last decoded frame (source: 3 s, repeated every 3 s while the
  stall lasts), subject to the same SFU throttle; decoding resumed 3.01–3.11 s after the last
  decoded frame. Two receivers dropping together sent two PLIs; one reached the publisher and its
  single key frame recovered both.
- On a new subscription, including an unsubscribe and resubscribe, the SFU asks the publisher for a
  key frame itself: measured, the receiver decoded within 56–117 ms without sending a PLI. libwebrtc's
  200 ms request cadence for a receive stream that has never decoded is read from source and was not
  observed.

## No plaintext path

A browser never sends a content-bearing frame that its sender transform did not encrypt and never
renders one that its receive transform did not authenticate. The only frame that is not ciphertext
is a zero-byte audio frame, which has no content. An SFU substituting empty frames for real ones is
equivalent to dropping them, which it can always do. Media content leaves the device only as encrypted
RTP. Nothing the SFU or a peer sends, no option the application passes, and no failure opens a path around the
transform:

- **Not through the data channel.** No media, and nothing derived from media, is ever sent through
  the data channel, which a dilla call does not encrypt. livekit-client can do so on its own: its
  pre-connect buffer records the microphone from capture and, once the SFU acknowledges the feature
  and flags any participant as an agent, streams the recording to it over the data channel after
  the track is published. So the client refuses these publish options, both as the room's defaults
  and per publish: `preConnectBuffer`, `frameMetadata` and `packetTrailer`; it also refuses `red` and
  backup codecs (DEV-08, DEV-09). Only options that shape the encoder's output before the transform
  (encodings, simulcast layers, codec, audio preset, DTX, stereo, scalability mode, degradation
  preference, stopping the microphone on mute) are taken from the application. A track that arrives
  with a pre-connect recording at sender creation or publication has its buffered chunks discarded,
  its recorder stopped, its sender blocked and its track unpublished. The publication event is
  synchronous before livekit-client reads the buffer; after sender creation, calls through the
  track's `startPreConnectBuffer` method are refused and block the sender too.
- **Senders.** Every sender gets its transform synchronously when it is created, before the
  renegotiation that starts its RTP. The codec of each frame is the frame's own (the encoded frame's
  `mimeType`), never the codec the publication is labelled with, which the SFU chooses through the
  codecs it enables. A frame whose codec has no prefix rule in "Codec prefixes" (AV1, H.265, RED,
  PCMU, PCMA) or that names none is dropped and counted, never sent; on an audio slot only Opus is
  sent. A track whose source has no slot, or whose kind does not match its source, gets a transform
  that drops every frame, and is unpublished.
- **Receivers.** Every receiver gets its transform synchronously in the PeerConnection's `track`
  event, before any other listener in the page learns of the track.
- **Firefox and Safari** (`RTCRtpScriptTransform`). A sender or receiver without a transform sends or
  renders plaintext (measured on Firefox 155). When the browser refuses the transform's options a
  transform that drops every frame is assigned instead; when no transform can be assigned at all (the
  API is missing, or constructing or assigning it throws) the track is stopped, and a sender is
  unpublished.
- **Chromium and Electron** (`createEncodedStreams` on a PeerConnection created with
  `encodedInsertableStreams: true`). A sender whose streams were never created sends nothing and
  such a receiver decodes nothing (measured on Chromium 153). When creating the streams, or handing
  them to the media worker, fails, the track is stopped as well, and a sender is unpublished.
- **A sender left without any transform stays dead.** Restarting, unmuting or switching the device of
  a local track puts a new capture track on the same sender without creating a new one; on such a
  sender the new track is stopped instead, and the sender is unpublished again. A later publish on
  the same sender is refused the same way.
- **The media worker** passes a frame on only after a successful encryption or an authenticated
  decryption. Any other outcome (a cipher error, a trapped cipher, an exception in the pipeline, no
  epoch) drops the frame and keeps the stream open. Transform options it does not recognise drop
  every frame. If its cipher fails to load it reads and discards every frame, and the call fails to
  start. If the worker fails during a call (it throws, or a message from it cannot be read), its keys are cleared and it is terminated, which ends every transform it hosts:
  afterwards no media byte is sent and no frame is decoded or rendered on either browser path
  (measured on Firefox 155 and Chromium 153, video). A sender or receiver created after that is
  stopped, and a sender is unpublished.
- **Application code** cannot undo any of this by throwing: an exception in a listener for the
  client's encryption events is caught and logged, and the client still unpublishes, clears keys
  and leaves the call.

## Authenticity

Any member can derive any sender's key (RFC 9605 §7.2). Attribution rests on the SFU's binding of
SSRC to the participant identity, which the instance mints only for a leaf present in the `call`
group's current epoch, and on the receiver rules above, which a browser enforces at these points:

- The receive transform is attached as "No plaintext path" states: synchronously in the `track`
  event and before any other listener. On Firefox and Safari a receiver whose transform cannot be
  assigned is stopped rather than left without one; on Chromium and Electron a receiver without its
  streams decodes nothing and is stopped too. Frames that arrive before the receiver knows the
  publication's device, source and encryption flag are held, never rendered.
- A publication flagged `Encryption NONE` is dropped whole; `GCM` and `CUSTOM` both mean
  `dilla-sframe/1`.
- A frame ending in the SFU's server-injected-frame trailer is dropped before any SFrame header is
  parsed. The trailer is replaced, never appended, each time the SFU sends one.
- A participant identity that is not 32 lowercase hex, or a track whose kind does not match its
  source (audio ⇔ microphone or screen-share audio, video ⇔ camera or screen share), is an
  unverified stream and every frame of it is dropped.

A colluding instance and member can therefore still inject media attributed to another participant:
the member derives that participant's key and the instance binds the forged stream to that
participant's identity. This is the same limit as DAVE and is stated in `08-threat-model.md`.

## Errors

These codes never cross the wire. A receiver drops and counts the frame; a sender refuses to emit
it. Implementations use them in counters, logs and the media worker's error messages so that every
implementation names a failure the same way. They are not `02`'s `E_*` vocabulary.

| code | meaning | raised by |
|---|---|---|
| `E_SFRAME_TRUNCATED_HEADER` | the header ends before its KID or CTR field does | receiver |
| `E_SFRAME_NON_MINIMAL_HEADER` | an extended field holds 0-7, or a multi-byte field has a leading `00` | receiver |
| `E_SFRAME_NON_CANONICAL_KID` | the KID is 2^24 or more, so it is no `(leaf_index << 8) \| (epoch mod 256)` | receiver, and any API that takes a raw KID |
| `E_SFRAME_TRUNCATED_FRAME` | fewer than 16 bytes follow the header | receiver |
| `E_SFRAME_MALFORMED_PREFIX` | the codec prefix cannot be computed (short VP8 key frame, no start code, NAL type 0/24-31, slice header overrun, `pic_parameter_set_id` > 255) | both |
| `E_SFRAME_UNSUPPORTED_CODEC` | a codec with no prefix rule, or an H.264 first VCL NAL of type 2-4 or 19-21 | both |
| `E_SFRAME_NO_VCL_NAL` | an H.264 frame with no VCL NAL unit | both |
| `E_SFRAME_NON_CANONICAL_SPS` | an SPS in the prefix fails libwebrtc's incoming VUI check | sender |
| `E_SFRAME_AUTH` | the AEAD tag does not verify | receiver |
| `E_SFRAME_LAYER_RANGE` | a layer above 15 | both |
| `E_SFRAME_COUNTER_EXHAUSTED` | `seq` would pass 2^52 − 1; the sender rekeys | sender |
| `E_SFRAME_LEAF_RANGE` | a leaf index of 2^16 or more | both |
| `E_SFRAME_UNKNOWN_KID` | the KID names an epoch this device has not installed yet | receiver (the only code a frame is held for) |
| `E_SFRAME_STALE_EPOCH` | the KID names an epoch this device dropped, or a sender's epoch is below its floor | both |
| `E_SFRAME_LEAF_NOT_IN_EPOCH` | the KID's leaf is not in the roster of the epoch it names | receiver |
| `E_SFRAME_SENDER_MISMATCH` | the KID's leaf, in its epoch, is not the leaf of the device the track belongs to | receiver |
| `E_SFRAME_OWN_KID` | the KID is the receiver's own leaf in that epoch | receiver |
| `E_SFRAME_SLOT_MISMATCH` | the authenticated slot is not the slot of the track's source | receiver |
| `E_SFRAME_REPLAY` | the counter was already accepted, or is older than the replay window | receiver |

## Vectors

`vectors/sframe.json` (`"version": 1`; growing the file changed no frame byte, so neither the file
version nor `media_version` moved). An implementation conforms when it reproduces every field of
every section and refuses every reject with the named code:

- `cases`: `kid`, `key`, `salt`, `ctr`, `nonce`, `header` from the fixed `base_key`;
- `rfc9605_c1`: 34 headers of RFC 9605 Appendix C.1 (each KID value with CTR 0, each CTR value with
  KID 0, and max/max), encoded and strictly decoded;
- `rfc9605_c3`: the Appendix C.3 suite `0x0004` case as a frame (the RFC's metadata is `P`): `key`,
  `salt`, `nonce`, `frame`, and opening `frame` back to `prefix || plaintext`;
- `media_frames`: one frame per prefix rule (Opus, VP8 delta, VP8 key on layer 2, H.264 SPS+PPS+IDR
  with escaping): `prefix_len` from the input bytes, `frame` from the sender's path, and opening
  `frame` back to `input`;
- `escapes`: the seeded `WriteRbsp` and its inverse;
- `rejects`: 13 truncated or non-minimal headers, 3 headers whose KID is 2^24 or more, 5 tampered
  or truncated frames, 1 malformed prefix and 1 frame sealed under a non-canonical KID with that
  KID's own key, each with its `E_SFRAME_*` code. A header row is refused by the receiver's header
  step (step 1 of "Receiver rules"), a frame row by the receiver's path up to the AEAD.
