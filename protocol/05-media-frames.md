# 05 — Media frames (`dilla-sframe/1`)

Every audio, video and screen-share frame in a `call` group is encrypted per frame by the sender
and forwarded opaquely by the SFU. The construction follows RFC 9605 (SFrame) with the codec
prefix rules Discord's DAVE documents for WebRTC depacketisers; it is **not** byte-compatible with
DAVE.

## Frame format

```
[ clear codec prefix ][ SFrame header ][ ciphertext ][ 16-byte tag ]
```

- **AAD** = SFrame header || clear codec prefix.
- **Cipher**: AES-128-GCM with the per-KID key and the nonce below (suite `0x0004`).
- One ciphertext per simulcast or SVC layer; each layer has its own counter `layer` field.
- The SFrame header is RFC 9605 §4.3: one config byte laid out as `(X << 7) | (K << 4) | (Y << 3) | C` per the RFC's Figure 3 (X and Y flag extended KID and CTR lengths), then the extended KID and CTR bytes. Conformance vectors: RFC 9605 Appendix C.1.

## Codec prefixes

The prefix is the minimum bytes a depacketiser needs in the clear; everything after it is
encrypted, with H.264 RBSP emulation-prevention re-applied after encryption.

| codec | clear prefix |
|---|---|
| Opus | 0 bytes |
| VP8 | 1 byte for inter frames; 10 bytes for key frames |
| VP9 | 0 bytes |
| H.264 | non-VCL NAL units in the clear; for VCL NAL units the 1-byte NAL header in the clear, the RBSP payload encrypted, then re-escaped (`00 00 0x` → `00 00 03 0x`) |
| AV1 | not supported at media_version 1; a client MUST NOT negotiate AV1 in a `call` group |

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

## Vectors

`vectors/sframe.json`: for each case, `kid`, `key`, `salt`, `ctr`, `nonce`, `header` from a fixed
`base_key`. An implementation conforms when it reproduces all fields.
