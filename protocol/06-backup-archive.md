# 06 — Backup archive

The instance stores two kinds of client-encrypted backup per user. It cannot read either.

## Keys

`K_header` and `K_backup` are derived from the recovery key as in `03-identity.md`. AEAD is
AES-256-GCM with a random 96-bit nonce per object; the nonce is stored with the ciphertext.

## Header

One object per user, replaced on every change, uploaded by a `native` device holding `SSK_priv`:

```
plaintext = CBOR [
  v,                ; uint, = 1
  umk_priv,         ; bstr, 32
  ssk_priv,         ; bstr, 32
  device_list,      ; the newest signed device list (03-identity.md), as its CBOR bytes
  pins              ; array of [user_id (bstr 16), umk_pub (bstr 32), first_seen (uint), verified (uint 0|1)]
]
stored = CBOR [ v = 1, nonce (bstr 12), ciphertext (bstr) ]   ; ciphertext = AES-256-GCM(K_header, nonce, plaintext, aad = "dilla header v1")
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
manifest = CBOR [ v = 1, user_id, chunks (array of [device_id, chunk_seq, blob_id (bstr 32 = SHA-256 of stored chunk)]), sig_umk (bstr 64) ]
```

The manifest is signed by the UMK (`"dilla manifest v1" || CBOR of elements 0..2`) by the device
that last performed recovery or signup, or by any `native` device holding a copy of `UMK_priv` in
memory during that operation; between such operations the manifest is re-signed only when a new
device is enrolled (the header is rewritten then anyway). A chunk is at most 4 MiB of plaintext; a
device uploads a chunk when it has 1 MiB of new entries or after 24 hours, whichever is first.

## Restore

1. With `RK`: derive keys, download and decrypt the header, enrol this device (`03-identity.md`,
   "Recovery"), download the manifest, verify `sig_umk`, download every chunk, verify `blob_id`,
   decrypt, merge entries by `msg_id` (an `edit` supersedes by `received_at`; a `delete` wins).
2. With another signed-in device: pair (`03-identity.md`), receive `K_backup` (native only),
   then steps from "download the manifest".
3. A chunk that fails to decrypt or whose `blob_id` mismatches is reported in Settings → Devices
   as a gap with its `device_id` and `chunk_seq`; restore continues with the rest.
