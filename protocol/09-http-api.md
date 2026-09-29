# 09 — HTTP API (non-delivery-service)

## Scope

This document is owned by `dillad`, not by the delivery-service contract. `02-delivery-service.md`
freezes with "DS API v1" at the end of W5; this document does **not** freeze then — it covers the
instance document and limits, accounts, devices, sessions, invites, auth ceremonies, communities and
content, rate limits and the `users.flags` bit layout, all of which stay editable as dillad grows.

## Encoding

One body encoding: deterministic CBOR, fixed-position arrays, served and accepted as
`Content-Type: application/cbor` on every `/v1` request and response that has a body. A request
whose `Content-Type` is not `application/cbor` is `415`; a body that fails to decode as
deterministic CBOR is `400 E_INVALID_REQUEST`. Blob bodies are the one exception: raw octets,
`Content-Type: application/octet-stream`.

## Identifiers

Path identifiers are 32 lowercase hex characters (`^[0-9a-f]{32}$`); `{blob_id}` is 64 lowercase
hex. Both are validated before the database or the filesystem is touched. A syntactically malformed
identifier is `400 E_INVALID_REQUEST`; a well-formed but unknown one is `404 E_NOT_FOUND`.

## Sessions

Every endpoint in this document except the ones marked `—` requires a device session exactly as
`02-delivery-service.md`'s `§ Device sessions` defines: `Authorization: Bearer <token>` resolved to
a `sessions` row by `SHA-256(token)`; no cookie and therefore no CSRF surface on `/v1`. The `Auth`
column below uses four scopes:

| scope | meaning |
|---|---|
| `E` | an `enrolled` session |
| `P` | `pending` also accepted |
| `V` | `provisional` also accepted |
| `A` | an `enrolled` session whose user holds the instance-admin flag |
| `—` | no session required |

## Accounts and devices

| Method and path | Auth | Request | Response |
|---|---|---|---|
| `POST /v1/accounts` | — | `[code(tstr), username(tstr), display(tstr), umk_pub(bstr32), ssk_pub(bstr32), sig_umk_ssk(bstr64), password(tstr\|null), device(array)]` where `device = [device_id(bstr16), dsk_pub(bstr32), tier(uint), signer_tier(uint), credential(bstr)]` | `[user_id(bstr16), device_id(bstr16), token(tstr), expires(uint)]` |
| `GET /v1/accounts/me` | E | — | `[user_id, username, display, kind, flags, created]` |
| `PATCH /v1/accounts/me` | E | `[display(tstr\|null), status_msg(tstr\|null)]` | `204` |
| `DELETE /v1/accounts/me` | E (step-up) | `[]` | `204` — credential purge, Removes from every group, tombstone keeping `username` |
| `POST /v1/devices` | E or P | `[device_id, dsk_pub, tier, signer_tier, credential]` | `[device_id]` |
| `GET /v1/devices` | E | — | `[[device_id, tier, signer_tier, verified_at, revoked_at, last_seen]]` |
| `DELETE /v1/devices/{device_id}` | E | — | `204` — revokes, deletes sessions, closes sockets |
| `PUT /v1/users/{user_id}/device-list` | E | `[version(uint), blob(bstr), ssk_signature(bstr64), prev_hash(bstr32)]` | `204` |
| `GET /v1/users/{user_id}/device-list` | E | — | `[version, blob, ssk_signature, prev_hash]` |

`POST /v1/accounts` is the sole exception to the device-session proof rule: it creates the device
and its first session in the same transaction, because the device's key is the one being
registered and there is no prior key to prove possession of.

Two rows above describe more than any released instance does. They are recorded here so a client
plans against what an instance answers, not against what the table would otherwise promise:

- `PATCH /v1/accounts/me` answers `501` with `E_INTERNAL` at wire 1. The body is still validated, so
  a client learns immediately that its display name is refused, but there is nowhere to put the
  result: the repository contract declares no profile update and `users` has no status column. The
  `204` lands when the store gains the method, and a client must not expect it before then.
- `DELETE /v1/accounts/me` tombstones the account keeping its `username`, disables it, and deletes
  every session of every device with their sockets closed. It does **not** yet purge the credential
  rows (password PHC, TOTP secret, recovery-code hashes, WebAuthn credentials, OIDC identity) or
  remove the user from its MLS groups. The tombstone stops every one of those credentials
  authenticating immediately; the stored secrets survive until the credential deletes and the
  group-removal path land, and this paragraph goes when they do.

## Sessions endpoints

| Method and path | Auth | Request | Response |
|---|---|---|---|
| `POST /v1/devices/{device_id}/sessions/challenge` | — | `[]` | `201 [nonce(bstr32), expires(uint)]` |
| `POST /v1/devices/{device_id}/sessions` | — | `[nonce, purpose, sig, credential\|null, login\|null]` | `201 [token, scope, user_id, device_id, expires, idle_expires, generation]` |
| `DELETE /v1/devices/{device_id}/sessions` | E | — | `204` (all sessions of that device) |
| `POST /v1/gateway/ticket` | E | `[]` | `201 [ticket(tstr), expires(uint)]` — single use, 30 s |

The full session issuance and lifetime rules — scopes, lifetimes, revocation — are
`02-delivery-service.md`'s `§ Device sessions`; this table only locates the routes.

## Invites

| Method and path | Auth | Request | Response |
|---|---|---|---|
| `GET /i/{code}` | — | — | `text/html` + CBOR via content negotiation: instance name, community name, expiry. Never mutates; `Cache-Control: no-store`, `Referrer-Policy: no-referrer` |
| `POST /v1/invites/redeem` | — | `[code(tstr)]` | `[invite_id(bstr16), community_id(bstr16\|null), grants_admin(uint)]` |
| `POST /v1/communities/{id}/invites` | E | — | invite created |
| `GET /v1/communities/{id}/invites` | E | — | `[invite]` |
| `DELETE /v1/invites/{id}` | E | — | `204` |

Errors: `410 E_INVITE_INVALID` when the invite is expired, exhausted or revoked.

## Auth ceremonies

| Method and path | Auth | Request | Response |
|---|---|---|---|
| `POST /v1/auth/password/login` | — | `[username(tstr), password(tstr)]` | `[assertion(tstr), needs_totp(uint)]` |
| `POST /v1/auth/password` | E (step-up) | `[old(tstr\|null), new(tstr)]` | `204` |
| `POST /v1/auth/totp/enroll` | E | `[]` | `[secret(tstr), otpauth_url(tstr)]` |
| `POST /v1/auth/totp/confirm` | E | `[code(tstr)]` | `[recovery_codes([tstr])]` |
| `POST /v1/auth/totp/verify` | — | `[assertion(tstr), code(tstr)]` | `[assertion(tstr)]` |
| `POST /v1/auth/recovery/verify` | — | `[assertion(tstr), code(tstr)]` | `[assertion(tstr)]` |
| `POST /v1/auth/passkey/register/begin` | E | `[]` | `[ceremony_id(bstr16), options(tstr)]` (the library's JSON, opaque to the client's CBOR layer) |
| `POST /v1/auth/passkey/register/finish` | E | `[ceremony_id(bstr16), response(tstr)]` | `[cred_id(bstr)]` |
| `POST /v1/auth/passkey/login/begin` | — | `[]` | `[ceremony_id(bstr16), options(tstr)]` |
| `POST /v1/auth/passkey/login/finish` | — | `[ceremony_id(bstr16), response(tstr)]` | `[assertion(tstr)]` |
| `GET /v1/auth/oidc/start` | — | — | `302` to the IdP, PKCE `S256`, state cookie `__Secure-dilla-oidc` scoped to this route only |
| `GET /v1/auth/oidc/callback` | — | — | `302` back to the client with a one-time `assertion` |

The `assertion` is a short-lived one-time **enrolment assertion**: it proves host login and is spent
by `POST /v1/devices/{device_id}/sessions` on the `pending` path. It is never a session token and
never reaches `/v1` beyond that one endpoint.

## Communities and content

| Area | Routes |
|---|---|
| communities | `POST /v1/communities`, `GET/PATCH/DELETE /v1/communities/{id}`, `GET /v1/communities/{id}/members`, `DELETE /v1/communities/{id}/members/{user_id}`, `POST /v1/communities/{id}/join`, `POST /v1/communities/{id}/leave` |
| channels | `POST /v1/communities/{id}/channels`, `GET/PATCH/DELETE /v1/channels/{id}`, `PUT /v1/channels/{id}/overwrites/{kind}/{target_id}`, `DELETE` the same, `GET /v1/channels/{id}/members`, `PUT/DELETE /v1/channels/{id}/members/{user_id}` |
| roles | `POST /v1/communities/{id}/roles`, `PATCH/DELETE /v1/roles/{id}`, `PUT/DELETE /v1/communities/{id}/members/{user_id}/roles/{role_id}` |
| bans | `PUT /v1/communities/{id}/bans/{user_id}`, `DELETE` the same, `GET /v1/communities/{id}/bans` |
| invites | `POST /v1/communities/{id}/invites`, `GET /v1/communities/{id}/invites`, `DELETE /v1/invites/{id}` |
| DMs | `POST /v1/dms` `[recipients([bstr16])]` → `[channel_id]`; `GET /v1/dms` |
| readable | `POST /v1/channels/{id}/messages` `[envelope(bstr)]` → `[seq, franking_tag, recv_ts]`; `GET /v1/channels/{id}/messages?from=`; `PATCH`/`DELETE /v1/channels/{id}/messages/{seq}`; `GET /v1/channels/{id}/search?q=&limit=&before=`; `PUT /v1/channels/{id}/read-state` |
| blobs | `PUT/GET/HEAD/DELETE /v1/channels/{cid}/blobs/{blob_id}` (raw octets, `201` new / `200` already present, `422 E_INVALID_REQUEST` on a hash mismatch, `507 E_STORAGE_FULL`), `DELETE /v1/admin/blobs/{blob_id}` |
| backups | `PUT /v1/backups/{kind}/{chunk_seq}`, `GET /v1/backups`, `GET /v1/backups/{kind}/{chunk_seq}`, `DELETE` the same |
| reports | `POST /v1/reports` `[group_id, seq, envelope(bstr), k_f(bstr32)]`, `GET /v1/reports`, `PATCH /v1/reports/{id}` |
| voice | `POST /v1/channels/{id}/calls` → `[call_id, group_id, livekit_url, token, ice_servers]`, `DELETE /v1/calls/{call_id}` |
| admin | `GET /v1/admin/diagnostics`, `GET /v1/admin/audit`, `POST /v1/admin/users/{id}/disable` |

The blob delete rule: a `DELETE` on `/v1/channels/{cid}/blobs/{blob_id}` removes the **reference**,
only for the uploading user; the file is unlinked by the sweeper when the last reference is gone and
`unref_since` is older than `blobs.gc_grace`. Global removal is the admin verb and writes a
tombstone, because content addressing otherwise lets anyone re-`PUT` the same bytes.

## Rate limits

Every bucket is in-process, keyed by `(class, subject)` where subject is the device session, the
user, or the client address (IPv6 keyed by `/64`, not `/128`). A refusal never reserves a token it
then gives back: an `Allow`-style check mutates nothing when it refuses. `retry_after_ms` in the
error array is the bucket's actual deficit, rounded up to the next millisecond; the `Retry-After`
header carries the same value in whole seconds. The commit and proposal paths are metered
separately and loosely, so the delivery service's own throttle never becomes the reason its
committer-election watchdog removes a device.

Body caps: `max_ciphertext_bytes + 4096` on `POST /v1/groups/{id}/message`; 96 KiB on
`POST /v1/channels/{id}/messages` and `PATCH /v1/channels/{id}/messages/{seq}` (`protocol/04`'s own
worst-case legal envelope is ≈ 74 KiB, so a smaller cap would refuse a maximal but valid envelope
before the validator ever saw it); 64 KiB on every other CBOR route; `blobs.max_blob_bytes` on a
blob `PUT`.

## Instance

| Method and path | Auth | Request | Response | Errors |
|---|---|---|---|---|
| `GET /v1/instance` | — or E (`instance.discovery`) | — | the discovery document below | `401` |
| `GET /v1/instance/limits` | — | — | the limits array below | — |

The discovery document is an eleven-element array, in this order:

```
[
  wire_versions,           ; [uint]
  e2ee_versions,           ; [uint]
  media_versions,          ; [uint]
  instance_id,             ; bstr 16
  generation,              ; uint
  name,                    ; tstr, the instance domain
  registration_mode,       ; uint
  auth_methods,            ; [uint], ascending, no duplicates
  policy_version,          ; uint
  external_sender_key_id,  ; bstr 16
  external_sender_pub      ; bstr 32
]
```

`external_sender_key_id` and `external_sender_pub` are the key id and the Ed25519 public key of the
instance's current external-sender signing key (`03-identity.md` § Instance keys): the entry of
`key_history` the instance row names. A client creating a `text` or `call` group puts
`external_sender_pub` in the group's `external_senders` extension, which is how the instance can
propose into it. Only the public half is served; `key_history` itself never is. After a rotation
the document carries the new key, and the rotation proposal of `03` is how existing groups move.

`registration_mode` is **0 invite-only, 1 open, 2 closed**. Invite-only is 0 because it is the
default an instance starts in; `closed` accepts no new account by any route. `auth_methods` values
are **0 password, 1 totp, 2 passkey, 3 oidc**. Every other value of either field is reserved and a
client MUST ignore an `auth_methods` entry it does not know rather than refusing the document.

The limits array is eleven unsigned integers, in this order:

```
[
  max_ciphertext_bytes, max_blob_bytes, max_attachments, max_previews,
  max_keypackages_per_device, keypackage_refill_threshold, blob_quota_bytes,
  heartbeat_ms, max_frame_bytes, handshake_retention_days, ciphertext_retention_days
]
```

`max_frame_bytes` is `max_ciphertext_bytes + 512` and is the same number the gateway advertises in
its `hello` frame; an instance that changes `limits.max_ciphertext_bytes` moves both together.

Every HTTP response under `/v1` carries `X-Dilla-Generation: <uint>`, so an HTTP-only client notices
a restore without holding a gateway connection.

## Flags

`users.flags` is a bitfield. Two bits are assigned at `wire_version = 1`:

| bit | meaning |
|---|---|
| 0 | instance admin |
| 1 | bot operator |

Every other bit is reserved, MUST be written as 0 and MUST be ignored on read.
