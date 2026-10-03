# 05 — Media frames (`dilla-sframe/1`)

Every audio, video and screen-share frame in a `call` group is encrypted per frame by the sender
and forwarded opaquely by the SFU. The construction is RFC 9605 (SFrame), suite `0x0004`, with one
clear codec prefix per frame so that WebRTC depacketisers and the SFU keep working. The prefixes are
the bytes libwebrtc's depacketisers read (for VP8, VP9 and Opus the same bytes Discord's DAVE
leaves clear); H.264 escaping is libwebrtc's `WriteRbsp`/`ParseRbsp`, not DAVE's nonce retry, which
cannot work here because a counter on slot 1 or above always carries `00 00 00`. It is **not**
byte-compatible with DAVE.

## Frame format

```
[ clear codec prefix P ][ E( SFrame header H || ciphertext C || 16-byte tag T ) ]
```

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
  minimality). Every header of RFC 9605 Appendix C.1 decodes.
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
- `KID = (leaf_index << 8) | (epoch mod 256)` (24 bits used; `leaf_index` < 2^16).
- `sframe_secret = HKDF-Extract(salt = "", IKM = base_key)` (RFC 9605 §4.4.2; the Appendix C.3 vector for suite 0x0004 is the check);
  `key = HKDF-Expand(sframe_secret, "SFrame 1.0 Secret key " || KID(8, big-endian) || 0x0004, 16)`;
  `salt = HKDF-Expand(sframe_secret, "SFrame 1.0 Secret salt " || KID(8) || 0x0004, 12)`.
- Every member derives every other member's key from the shared `base_key` and the sender's
  `KID`; a member MUST NOT accept a frame whose `leaf_index` is not in the current or previous
  epoch's tree.

## Counter partition

`CTR` is a 64-bit value: `slot (8 bits) || layer (4 bits) || seq (52 bits)`. Slots: 0 microphone,
1 camera, 2 screen video, 3 screen audio; further slots reserved. `seq` starts at 0 per (KID, slot,
layer) and increments per frame. A sender MUST stop sending and rekey (send an MLS `Update`) when
`seq` reaches 2^52 − 1; it MUST NOT wrap. `nonce = salt XOR CTR` (CTR big-endian, left-padded to
12 bytes).

## Rotation

- A new epoch (any Commit) gives every sender a new KID for the new epoch and new keys. Senders
  switch to the new epoch's keys as soon as they have processed the Commit.
- Receivers keep the previous epoch's keys for **10 seconds** after processing a Commit, then
  delete them. Frames with an unknown KID are buffered for at most **2 seconds** and then dropped
  and counted; they are never rendered.
- Because `KID` carries only `epoch mod 256`, a receiver MUST bind a KID to the exact epoch it
  learned it in and reject a KID that it would have to resolve against an epoch more than 255
  commits ago.
- A removed member cannot decrypt frames after the Commit that removed it, because it does not
  have the new epoch's `exporter_secret`. Between the DS proposal and the Commit (bounded by the
  30-second call TTL in `02-delivery-service.md`), the removed member still decrypts; the UI shows
  "removal pending" during that window.

## Authenticity

Any member can derive any sender's key (RFC 9605 §7.2). Attribution rests on the SFU's binding of
SSRC to the participant identity established at join, which is minted by the instance only for a
leaf present in the `call` group's current epoch. A colluding instance and member can therefore
inject media attributed to another participant. This is the same limit as DAVE and is stated in
`08-threat-model.md`.

## Errors

These codes never cross the wire. A receiver drops and counts the frame; a sender refuses to emit
it. Implementations use them in counters, logs and the media worker's error messages so that every
implementation names a failure the same way. They are not `02`'s `E_*` vocabulary.

| code | meaning | raised by |
|---|---|---|
| `E_SFRAME_TRUNCATED_HEADER` | the header ends before its KID or CTR field does | receiver |
| `E_SFRAME_NON_MINIMAL_HEADER` | an extended field holds 0-7, or a multi-byte field has a leading `00` | receiver |
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
- `rejects`: 12 headers, 5 tampered or truncated frames and 1 malformed prefix, each with its
  `E_SFRAME_*` code.
