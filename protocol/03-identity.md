# 03 — Identity

## Keys

Per user:

- **UMK** (user master key): Ed25519. Generated at signup on the first device. The private key is
  stored **only** in the recovery-key-encrypted header (`06-backup-archive.md`) and, transiently,
  on the device performing signup or recovery. It signs exactly one thing: the SSK.
- **SSK** (user signing key): Ed25519, signed by the UMK. The private key lives on every `native`
  device of the user, never on a `browser` device. It signs device credentials and the device list.

Per device:

- **DSK** (device signing key): Ed25519. It is the MLS leaf signature key. Generated on the device;
  the private key never leaves it. Stored in the OS keystore where one exists (Keychain, DPAPI,
  libsecret or KWallet, Android Keystore, iOS Secure Enclave-backed keychain); in IndexedDB on the
  `browser` tier.

Signature domains (the message signed is the domain string in UTF-8 followed by the fields, with
no separators):

- `sig_umk_ssk = Ed25519.sign(UMK_priv, "dilla ssk v1" || ssk_pub)`
- `sig_ssk_dev = Ed25519.sign(SSK_priv, "dilla dsk v1" || device_id || dsk_pub || tier)` where
  `tier` is one byte (0 native, 1 browser). For a browser device signed by a one-shot recovery-key
  entry, the signer is still the SSK (reconstituted from the header in memory and zeroised
  afterwards) and `signer_tier` in the credential is 1.

Instance key rotation: a new instance signing key is announced with
`sig_old(new_pub || "dilla instance rotate v1")`; clients accept the `GroupContextExtensions`
proposal that replaces `external_senders` only when that signature verifies under the previous key.

## Credential

Every leaf uses an MLS `basic` credential whose `identity` is the deterministic CBOR encoding of:

```
[
  v,             ; uint, = 1
  umk_pub,       ; bstr, 32
  user_id,       ; bstr, 16
  device_id,     ; bstr, 16
  kind,          ; uint: 0 user, 1 bot
  tier,          ; uint: 0 native, 1 browser
  signer_tier,   ; uint: 0 native, 1 browser (tier of the device or entry that signed this device)
  ssk_pub,       ; bstr, 32
  sig_umk_ssk,   ; bstr, 64
  sig_ssk_dev    ; bstr, 64
]
```

The leaf's `signature_key` MUST equal the `dsk_pub` covered by `sig_ssk_dev`; the verifier
reconstructs the signed message from the credential fields and the leaf's signature key. A leaf is
accepted only if:

1. both signatures verify;
2. `umk_pub` equals the pinned UMK for `user_id` on this instance (trust-on-first-use with a
   loud, undismissable alert on change), or no pin exists yet;
3. `dsk_pub` for `device_id` appears, unrevoked, in the newest **signed device list** the verifier
   has seen for this user (below);
4. `dilla_binding` checks of `01-groups.md` pass for the group.

Failing 1, 3 or 4 rejects the leaf (`E_CREDENTIAL`); failing 2 hard-rejects (`E_UMK_CHANGED`).

## Device list

The user's devices are published as a hash-chained, SSK-signed list. The DS stores and serves it;
it cannot forge it. Deterministic CBOR:

```
[
  v,           ; uint, = 1
  user_id,     ; bstr, 16
  version,     ; uint, monotonically increasing from 1
  prev_hash,   ; bstr, 32: SHA-256 of the previous list's CBOR bytes; 32 zero bytes for version 1
  entries,     ; array of [device_id (bstr 16), dsk_pub (bstr 32), tier (uint), added_at (uint),
               ;           revoked_at (uint or null)]
  sig_ssk      ; bstr, 64: Ed25519.sign(SSK_priv, "dilla devices v1" || CBOR of elements 0..4)
]
```

Rules: a verifier keeps the newest `version` it has validated per user and MUST reject a list
whose `version` is not greater than that, whose `prev_hash` does not match, or whose signature
fails. A leaf whose `device_id` is absent or has `revoked_at` set in the newest list is rejected
(`E_DEVICE_UNLISTED`) and any message from it is not rendered. Revocation is therefore
cryptographic and does not depend on the instance.

## Custody by tier

| secret | native device | browser device |
|---|---|---|
| `UMK_priv` | never (only in the recovery header) | never |
| `SSK_priv` | yes | never |
| `DSK_priv` | yes, in the OS keystore | yes, in IndexedDB |
| `K_backup` (archive key) | yes | only if the user enables "history in browser sessions" (default off) |
| MLS group state | yes | yes (OPFS) |

A browser device can therefore decrypt and send in groups it belongs to, but cannot enrol other
devices or publish device lists. Peers show a `web` tag on members whose message came from a
`browser`-tier leaf.

## Pairing

Enrolling a new device is a two-leaf `pairing` group without external senders:

1. The new device generates its DSK and shows a QR code (or a 12-character fingerprint) of
   `SHA-256(dsk_pub)`.
2. The authorising device (which holds `SSK_priv`) creates the pairing group with
   `dilla_binding.kind = 2` and `target_id = new device_id`, and adds the new device's KeyPackage.
   It MUST refuse to continue unless the tree has exactly two leaves and the peer's leaf signature
   key hashes to the scanned fingerprint.
3. Both devices compute the **SAS** from the MLS `epoch_authenticator` of the epoch after the Add
   (below) and the user confirms the same digits appear on both screens.
4. The authorising device sends, as application messages in the pairing group: the signed device
   credential for the new device; and, only if the new device is `native`, `SSK_priv`, `K_backup`
   and the UMK pin table. To a `browser` device it sends the credential only (plus `K_backup` if the
   user opted in).
5. The authorising device publishes a new signed device list including the new device, then both
   devices delete the pairing group.

## Recovery

At signup the client generates a 256-bit **recovery key** `RK` and shows it once, in two forms the
user may write down: 24 BIP-39 English words (BIP-39 checksum, 256-bit entropy) or 52 Crockford
base32 characters in 13 groups of 4 (no checksum). The client MUST require the user to acknowledge
that the key was written down before continuing; it MUST NOT offer a copy button on that screen.

Derived keys: `K_header = HKDF-SHA256(salt = "", IKM = RK, info = "dilla header v1", L = 32)` and
`K_backup = HKDF-SHA256(salt = "", IKM = RK, info = "dilla archive v1", L = 32)`.

The **header** (`06-backup-archive.md`) holds `UMK_priv`, `SSK_priv`, the device list and the UMK
pin table under `K_header`. Recovering on a new device with only `RK`: fetch the header, derive
`K_header`, decrypt, enrol the new device by signing its credential with the recovered `SSK_priv`,
publish a new device list revoking any device the user no longer holds, then restore history from
the archive under `K_backup`. A user who loses every device **and** `RK` loses their history; the
instance cannot help, and the onboarding copy says so.

## Safety number

Two users compare a 60-digit safety number derived from both UMKs:

```
digits = decimal(SHA-256(min(umk_a, umk_b) || max(umk_a, umk_b)))   ; min/max by byte order
safety_number = the first 60 digits of `digits` left-padded with zeros to 78 digits
displayed as 12 groups of 5
```

The **SAS** for pairing (and for optional call verification) is derived from the MLS
`epoch_authenticator` (32 bytes): `sas = the first 30 digits of decimal(epoch_authenticator)
left-padded to 78 digits`, displayed as 6 groups of 5. A `call` group's SAS is shown as the call
code in the voice UI (the daily-use design shows only its first 6 digits as two groups of 3, e.g.
`41 72 90`, the remaining digits on request).

## Error codes

`E_CREDENTIAL`, `E_UMK_CHANGED`, `E_DEVICE_UNLISTED`, `E_DEVICE_LIST_STALE`, `E_PAIRING_LEAVES`,
`E_PAIRING_FINGERPRINT`.
