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
- `sig_ssk_dev = Ed25519.sign(SSK_priv, "dilla dsk v1" || device_id || dsk_pub || kind || tier || signer_tier)`
  where `kind`, `tier` and `signer_tier` are one byte each, unsigned (`kind`: 0 user, 1 bot; `tier`:
  0 native, 1 browser; `signer_tier`: 0 native, 1 browser, 2 provisional — see "Pairing"). For a
  browser device signed by a one-shot recovery-key entry, the signer is still the SSK
  (reconstituted from the recovered root object in memory and zeroised afterwards) and
  `signer_tier` in the credential is 1.

Instance key rotation: a new instance signing key is announced with
`sig_old(new_pub || "dilla instance rotate v1")`; clients accept the `GroupContextExtensions`
proposal that replaces `external_senders` only when that signature verifies under the previous key.

### Instance keys

An instance holds two long-lived secrets: the **external-sender signing key**, an Ed25519 keypair
whose public half is the `external_senders` GroupContext extension of every `text` and `call` group,
and the **franking key** `K_frank`, 32 bytes used as the HMAC-SHA256 key of `04-envelope-and-franking.md`
§ Franking. Both are generated once by `dillad init` from the platform CSPRNG and are stored, with
every key they have replaced, in `instances.key_history` as deterministic CBOR:

```
key_history = [
  v,             ; uint, = 1
  entries        ; [+ entry], oldest first
]

entry = [
  kind,          ; uint: 0 external-sender Ed25519 signing key, 1 franking key
  key_id,        ; bstr 16
  public,        ; bstr: the 32-byte Ed25519 public key for kind 0, an empty bstr for kind 1
  secret,        ; bstr 32: the Ed25519 seed for kind 0, K_frank for kind 1
  created,       ; uint, unix seconds
  retired        ; uint or null: unix seconds, null while the entry is current
]
```

`instances.external_sender_key_id` and `instances.franking_key_id` name the one entry of each kind
whose `retired` is null. Rotation appends an entry and sets the previous entry's `retired`; a
retired franking key is kept so that a report franked under it can still be verified, and a retired
signing key is kept so that the rotation signature of this section verifies under it. The history is
instance secret material: it is in a backup (`06-backup-archive.md`, "the instance keys") and it is
never served over `/v1`.

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
  signer_tier,   ; uint: 0 native, 1 browser, 2 provisional (pairing only; see "Pairing")
                 ;   (tier of the device or entry that signed this device)
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
4. `dilla_binding` checks of `01-groups.md` pass for the group;
5. `tier` in the credential equals the `tier` of that `device_id`'s entry in the newest signed
   device list.

Failing 1, 3 or 4 rejects the leaf (`E_CREDENTIAL`); failing 2 hard-rejects (`E_UMK_CHANGED`);
failing 5 rejects the leaf (`E_TIER_MISMATCH`).

## Device list

The user's devices are published as a hash-chained, SSK-signed list. The DS stores and serves it;
it cannot forge it. Deterministic CBOR:

```
[
  v,           ; uint, = 1
  user_id,     ; bstr, 16
  version,     ; uint, monotonically increasing from 1
  prev_hash,   ; bstr, 32: SHA-256 of the previous list's full 6-element CBOR encoding;
               ;           32 zero bytes for version 1
  entries,     ; array of [device_id (bstr 16), dsk_pub (bstr 32), tier (uint), added_at (uint),
               ;           revoked_at (uint or null)]
  sig_ssk      ; bstr, 64: Ed25519.sign(SSK_priv, "dilla devices v1" || the deterministic CBOR
               ;           encoding of the 5-element array [v, user_id, version, prev_hash, entries])
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

Enrolling a new device is a two-leaf `pairing` group without external senders. The
`04-envelope-and-franking.md` envelope format is NOT used in pairing groups; the only application
message sent in one is the pairing payload defined below.

**Pairing QR payload.** The new device generates its DSK and encodes, as a QR code, Crockford
base32 of the deterministic CBOR `[v = 1, device_id (bstr 16), dsk_pub (bstr 32), umk_pub (bstr 32)]`
— `umk_pub` is the user's own pinned UMK, carried so the authorising device can confirm it. When a
camera is unavailable, the **fingerprint** shown for manual comparison is the first 12 Crockford
base32 characters of `SHA-256(dsk_pub)`.

**Provisional credential.** To open the pairing group, the new device presents the same 10-element
identity array as any credential ("Credential" above), with `signer_tier = 2` (provisional),
`ssk_pub` = 32 zero bytes, `sig_umk_ssk` = 64 zero bytes, `sig_ssk_dev` = 64 zero bytes, and
`umk_pub` = the UMK carried in the pairing QR payload. This credential is accepted only as the
second leaf of a `pairing` group whose `dilla_binding.target_id` equals the credential's
`device_id`; a DS session opened with a provisional credential may publish only one KeyPackage, for
that group, and may receive only that group's Welcome and handshakes. Any other use is rejected
(`E_PROVISIONAL_OUTSIDE_PAIRING`).

1. The new device generates its DSK, opens a DS session with its provisional credential, and shows
   the pairing QR payload (or the fingerprint).
2. The authorising device (which holds `SSK_priv`) creates the pairing group with
   `dilla_binding.kind = 2` and `target_id = new device_id`, and adds the new device's KeyPackage.
   It MUST refuse to continue unless the tree has exactly two leaves and the peer's leaf signature
   key hashes to the scanned fingerprint.
3. Both devices compute the **SAS** from the MLS `epoch_authenticator` of the epoch after the Add
   (below) and the user confirms the same digits appear on both screens.
4. The authorising device sends exactly one application message in the pairing group, the
   **pairing payload**: deterministic CBOR `[v = 1, credential (bstr: the SSK-signed identity CBOR
   of the new device), ssk_priv (bstr 32 or null), k_backup (bstr 32 or null), pins (array of
   [user_id, umk_pub, first_seen, verified] or null)]`. For a `browser` device, `ssk_priv` and
   `pins` are null, and `k_backup` is null too unless the user opted in to "history in browser
   sessions".
5. The authorising device publishes a new signed device list including the new device, then both
   devices delete the pairing group.

## Recovery

At signup the client generates a 256-bit **recovery key** `RK` and shows it once, in two forms the
user may write down: 24 BIP-39 English words (BIP-39 checksum, 256-bit entropy) or 52 Crockford
base32 characters in 13 groups of 4 (no checksum). 256 bits split into 5-bit Crockford groups is 52
characters, not 64 — an arithmetic slip in an earlier draft of the design spec, noted here so it is
not re-litigated. The client MUST require the user to acknowledge that the key was written down
before continuing; it MUST NOT offer a copy button on that screen.

Derived keys: `K_header = HKDF-SHA256(salt = "", IKM = RK, info = "dilla header v1", L = 32)` and
`K_backup = HKDF-SHA256(salt = "", IKM = RK, info = "dilla archive v1", L = 32)`.

The **root object** (`06-backup-archive.md`, "Header") holds `UMK_priv` and `SSK_priv` under
`K_header`; it is written only at signup and at recovery, never on ordinary changes, because
`UMK_priv` is never on a device otherwise. The **state object** holds the device list and the UMK
pin table under `K_backup`; any native device rewrites it on every change. Recovering on a new
device with only `RK`: derive `K_header` and `K_backup`, fetch and decrypt the root object, enrol
the new device by signing its credential with the recovered `SSK_priv`, fetch and decrypt the state
object, publish a new device list revoking any device the user no longer holds, then restore
history from the archive under `K_backup` (`06-backup-archive.md`, "Restore"). A user who loses
every device **and** `RK` loses their history; the instance cannot help, and the onboarding copy
says so.

## Safety number

Two users compare a 60-digit safety number derived from both UMKs:

```
digits = decimal(SHA-256(min(umk_a, umk_b) || max(umk_a, umk_b)))   ; min/max by byte order
safety_number = the first 60 digits of `digits` left-padded with zeros to 78 digits
displayed as 12 groups of 5
```

The **SAS** for pairing (and for optional call verification) is derived from the MLS
`epoch_authenticator` (32 bytes): `sas = the first 30 digits of decimal(epoch_authenticator)
left-padded to 78 digits`, displayed as 6 groups of 5.

## Vectors

`vectors/identity.json`. An implementation conforms when it reproduces `safety_number.digits`,
`sas.digits`, `recovery_key.base32`, `recovery_key.k_header`, `recovery_key.k_backup` and
`credential_identity.cbor`, and when it verifies `credential_identity.fields.sig_umk_ssk` against
`umk_pub` over `"dilla ssk v1" || ssk_pub`, and `sig_ssk_dev` against `ssk_pub` over
`"dilla dsk v1" || device_id || dsk_pub || kind || tier || signer_tier`.

`credential_identity` also carries `umk_priv`, `ssk_priv`, `dsk_priv` and `dsk_pub`. Those are
Ed25519 seeds chosen so the file is reproducible from a fixed input; they are test material and
protect nothing. `dsk_pub` is published because it is covered by `sig_ssk_dev` but is not itself a
field of the credential array: a verifier takes it from the MLS leaf's `signature_key`.

## Error codes

`E_CREDENTIAL`, `E_UMK_CHANGED`, `E_DEVICE_UNLISTED`, `E_DEVICE_LIST_STALE`, `E_PAIRING_LEAVES`,
`E_PAIRING_FINGERPRINT`, `E_TIER_MISMATCH`, `E_PROVISIONAL_OUTSIDE_PAIRING`.
