# 06 — Backup archive

The instance stores two kinds of client-encrypted backup per user. It cannot read either.

## Keys

`K_header` and `K_backup` are derived from the recovery key as in `03-identity.md`. AEAD is
AES-256-GCM with a random 96-bit nonce per object; the nonce is stored with the ciphertext.

## Header

Two objects per user, kept separate because `UMK_priv` must never be written back to a device after
signup or recovery while the device list and pin table change often.

**Root object.** Written only at signup and at recovery, never on ordinary changes, by the device
performing that operation:

```
plaintext = CBOR [ v = 1, umk_priv (bstr 32), ssk_priv (bstr 32) ]
stored = CBOR [ v = 1, nonce (bstr 12), ciphertext (bstr) ]
          ; ciphertext = AES-256-GCM(K_header, nonce, plaintext, aad = "dilla root v1")
```

**State object.** Rewritten by any `native` device on every change (new device paired, device
revoked, a UMK pinned or verified):

```
plaintext = CBOR [
  v,            ; uint, = 1
  device_list,  ; bstr: the newest signed device list (03-identity.md), as its CBOR bytes
  pins          ; array of [user_id (bstr 16), umk_pub (bstr 32), first_seen (uint), verified (uint 0|1)]
]
stored = CBOR [ v = 1, nonce (bstr 12), ciphertext (bstr) ]
          ; ciphertext = AES-256-GCM(K_backup, nonce, plaintext, aad = "dilla state v1")
```

## Archive

Decrypted message history, not MLS keys: restoring MLS group state would clone a leaf (sender
ratchet and nonce reuse) and hand current epoch secrets to anyone with the recovery key. Each
device writes immutable **chunks** of the messages it has decrypted; the user's devices merge by
`msg_id`.

```
chunk plaintext = CBOR [
  v,             ; uint, = 1
  device_id,     ; bstr, 16
  chunk_seq,     ; uint, per device, increasing
  entries        ; array of [group_id (bstr 16), channel_id (bstr 16), epoch (uint), seq (uint),
                 ;           sender_device (bstr 16), received_at (uint), envelope (bstr: 04 envelope CBOR)]
]
chunk stored = CBOR [ v = 1, device_id, chunk_seq, nonce (bstr 12), ciphertext (bstr) ]
               ; ciphertext = AES-256-GCM(K_backup, nonce, plaintext, aad = "dilla archive v1" || device_id || chunk_seq(8))
manifest = CBOR [ v = 1, user_id, chunks (array of [device_id, chunk_seq, blob_id (bstr 32 = SHA-256 of stored chunk)]), sig_ssk (bstr 64) ]
```

The chunk layout has no `msg_id_range` field; it is dropped because it is derivable from `entries`
(each entry's `envelope` carries its own `msg_id`).

The manifest is signed by the SSK: `sig_ssk = Ed25519.sign(SSK_priv, "dilla manifest v1" || the
deterministic CBOR encoding of the 3-element array [v, user_id, chunks])`. Any `native` device
holding `SSK_priv` re-signs the manifest whenever it uploads a chunk. A chunk is at most 4 MiB of
plaintext; a device uploads a chunk when it has 1 MiB of new entries or after 24 hours, whichever is
first.

## Restore

1. With `RK`: derive `K_header` and `K_backup`, download and decrypt the root object under
   `K_header` to recover `UMK_priv` and `SSK_priv`, download and decrypt the state object under
   `K_backup`, enrol this device (`03-identity.md`, "Recovery"), download the manifest and verify
   `sig_ssk` against the SSK recovered from the root object, download every chunk, verify
   `blob_id`, decrypt, merge entries by `msg_id` (an `edit` supersedes by `received_at`; a `delete`
   wins).
2. With another signed-in device: pair (`03-identity.md`), receive `K_backup` (native only),
   then steps from "download the manifest".
3. A chunk that fails to decrypt or whose `blob_id` mismatches is reported to the user as a gap
   with its `device_id` and `chunk_seq`; restore continues with the rest.

## Operator note: the instance backup

Informative. Everything above is the per-user backup, which clients encrypt and the instance
cannot read. `dillad backup` is a different thing: the operator's archive of the whole instance,
written by the server for `dillad restore`, and it carries the objects above only as the
ciphertext the instance already stores.

> Backups hold no end-to-end-encrypted plaintext: they contain ciphertext, server-readable channel content, revealed report envelopes, TLS material and the instance keys.

The archive is one gzip-compressed PAX tar whose member order is part of the format (format
version 1): `dilla-backup/MANIFEST.json` first, then the database snapshot
(`db/dilla.sqlite`, a `VACUUM INTO` copy, or `db/dilla.dump`, the Postgres logical dump),
`config/dilla.toml`, `keys/instance.json` (the instance keys of `03-identity.md` and the ACME
account key), `README.txt`, and the attachment blobs as `blobs/<aa>/<bb>/<blob_id hex>` in byte
order. The manifest records every other member's path, size and SHA-256 in that order, plus the
format, goose schema version, engine and instance `generation`; `dillad backup verify` checks all
of them, and an archive whose schema is newer than the binary is refused. Headers and the gzip
header carry no host state, so two backups of an unchanged instance at the same instant are
byte-identical.
