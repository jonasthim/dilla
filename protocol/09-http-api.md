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

The `credential` of the `device` sub-array is opaque to the instance: it is stored as sent (1 to
8192 bytes) and never parsed or read back. Because the instance mints `user_id` in this response,
a registering client cannot know it when it builds the credential: it sends the credential with
16 zero bytes as `user_id`, and after the response rebuilds its MLS credential with the minted
`user_id` without signing anything again (`sig_ssk_dev` does not cover `user_id` and
`sig_umk_ssk` covers `ssk_pub` only, `03` § Keys). Every leaf the device creates carries the
rebuilt credential; the placeholder never appears in a group.

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
| `GET /i/{code}` | — | — | `text/html`, or CBOR when the request asks for `application/cbor`: `[instance(tstr), community_id(bstr16\|null), expires(uint), community_name(tstr\|null)]`. Never mutates; `Cache-Control: no-store`, `Referrer-Policy: no-referrer` |
| `POST /v1/invites/redeem` | — | `[code(tstr)]` | `[invite_id(bstr16), community_id(bstr16\|null), grants_admin(uint)]` |
| `POST /v1/communities/{id}/invites` | E | `[max_uses(uint), ttl_seconds(uint), grants_admin(uint)]` | `201 [invite_id(bstr16), code(tstr), url(tstr), expires(uint)]` |
| `GET /v1/communities/{id}/invites` | E | — | `[[invite_id, community_id\|null, created_by\|null, grants_admin, max_uses, used_count, created, expires_at, revoked_at\|null]]`, newest first, revoked and spent invites included, never a code |
| `DELETE /v1/invites/{id}` | E | — | `204` |

Errors: `410 E_INVITE_INVALID` when the invite is expired, exhausted or revoked.

- A **community invite** is an invite whose `community_id` is set. Minting and listing need
  `create_invite` community-wide (§ Permissions) and membership of the community (`404 E_NOT_FOUND`
  otherwise, as for every community route); `403 E_FORBIDDEN` without the permission.
  `max_uses` is 1–1000 and `ttl_seconds` 1–2 592 000 (thirty days); `grants_admin` is 0 or 1, and 1
  is refused (`403 E_FORBIDDEN`) to anyone who is not an instance admin, because whoever registers
  with the invite becomes one. Anything else out of range is `400 E_INVALID_REQUEST`.
- `code` is the invite's only plaintext, returned once, by the mint. The instance stores its
  SHA-256 and the audit row (`invite.create`) names it by the first four bytes of that hash in
  hex. `url` is the instance's base URL followed by `/i/` and the code.
- `DELETE` revokes: the caller must be a member of the invite's community and either its creator
  or hold `manage_community`. Revoking a revoked invite is a no-op that keeps the first time; an
  unknown invite, one without a community and one of a community the caller is not in are all
  `404`. Each revocation writes an `invite.revoke` audit row.
- `GET /i/{code}` of a community invite names the community; an invite of a deleted community
  answers as an unknown one. A code is accepted as a person types it: hyphens and spaces stripped,
  case ignored, and `0`, `8` and `1` read as `O`, `B` and `I` or `L`.
- `GET /i/{code}`, `POST /v1/invites/redeem` and `POST /v1/communities/{id}/join` share one
  bucket, `limits.rate.invite_per_second` (0.1) with `invite_burst` (5), keyed by the client
  address, so a join is not a way round the limit on guessing codes. A refusal is `429
  E_RATE_LIMITED`; the landing page carries `Retry-After` too.

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
| communities | `POST/GET /v1/communities`, `GET/PATCH/DELETE /v1/communities/{id}`, `GET /v1/communities/{id}/members`, `DELETE /v1/communities/{id}/members/{user_id}`, `POST /v1/communities/{id}/join`, `POST /v1/communities/{id}/leave` |
| channels | `POST/GET /v1/communities/{id}/channels`, `GET/PATCH/DELETE /v1/channels/{id}`, `PUT /v1/channels/{id}/overwrites/{kind}/{target_id}`, `DELETE` the same, `GET /v1/channels/{id}/members`, `PUT/DELETE /v1/channels/{id}/members/{user_id}` |
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

### Communities

Every route below is `E`. A community a caller is not a member of answers `404 E_NOT_FOUND`
exactly as an unknown one does, so a non-member does not learn that it exists; a soft-deleted
community answers `404` to everyone.

| Method and path | Request | Response |
|---|---|---|
| `POST /v1/communities` | `[name(tstr), policy(bstr), min_account_age_seconds(uint), require_mod_2fa(uint)]` | `201 [community_id(bstr16), role_everyone(bstr16), policy_version(uint)]` |
| `GET /v1/communities` | — | `[[community_id(bstr16), name(tstr), owner(bstr16), policy_version(uint)]]`: the live communities the caller is a member of, ordered by `community_id`, unpaginated; `[]` for none |
| `GET /v1/communities/{id}` | — | `[community_id, owner, name, policy, policy_version, min_account_age_seconds, require_mod_2fa, created]` |
| `PATCH /v1/communities/{id}` | `[name(tstr\|null), policy(bstr\|null), min_account_age_seconds(uint\|null), require_mod_2fa(uint\|null)]` | `[policy_version(uint)]` |
| `DELETE /v1/communities/{id}` | — | `204` |
| `GET /v1/communities/{id}/members?after=` | — | `[[user_id, joined, nick, [role_id], username(tstr), display(tstr), kind(uint)]]`, at most 200 per page, ordered by `user_id`; `after` is the last `user_id` of the previous page |
| `DELETE /v1/communities/{id}/members/{user_id}` | — | `204` |
| `POST /v1/communities/{id}/join` | `[invite(tstr\|null)]` | `[community_id]` |
| `POST /v1/communities/{id}/leave` | `[]` | `204` |
| `PUT /v1/communities/{id}/members/{user_id}/roles/{role_id}` | `[]` | `204` |

- The creator is the **owner** and the first member, and the community starts with one role,
  `@everyone`, at position 0, whose id is `role_everyone`. The owner can neither leave nor be
  removed. `PATCH` needs `manage_community` (§ Permissions); `DELETE` is the owner's alone
  (`403 E_FORBIDDEN` for any other member). Removing a member is the **kick** of § Bans. Role
  grants are § Roles'.
- `leave` removes the caller's leaves from every `text` and `call` group of the community's
  channels, as a kick does (§ Bans). `DELETE` closes every such group after the community and its
  channels are tombstoned.
- `name` is 1–255 bytes of UTF-8 with no control character. `require_mod_2fa` is 0 or 1.
  `min_account_age_seconds` is at most 3 153 600 000 (a century); 0 means no gate.
- `policy` is the **policy document** below, and `policy_version` starts at 1 and grows by one on
  every `PATCH` that carries a policy; a `PATCH` without one leaves it. Two concurrent policy
  changes cannot share a version: the loser is `409 E_INVALID_REQUEST` and re-reads.
- `join` refuses (`403 E_FORBIDDEN`) an account the community has banned (§ Bans; a ban whose
  `expires` has passed no longer refuses), a disabled or deleted account and an account younger
  than `min_account_age_seconds`. Joining a community the caller is already a member of is a no-op that
  answers `[community_id]`.
- `join` with `invite = null` on a community whose policy says `"join": "invite"` is
  `403 E_FORBIDDEN`. With a code it spends one use of that community's invite (§ Invites): a
  malformed code is `400 E_INVALID_REQUEST`, and an unknown, expired, exhausted or revoked one, or one
  minted for another community, is `410 E_INVITE_INVALID`. The gates above run first, so a join
  they refuse spends no use, and the use and the membership are written together. An open community
  spends an invite it is given all the same. `max_uses` holds under concurrent joins: exactly that
  many succeed.
- `require_mod_2fa = 1` refuses (`403 E_FORBIDDEN`) a grant of a role whose `allow` carries any
  moderation bit (manage messages, kick, ban, manage channels, manage roles, manage community,
  administrator) to a user who holds neither a confirmed TOTP secret nor a passkey for this
  instance's relying party.
- A member's `nick` is a **display name**, not a handle: free Unicode, NFC, at most 64 characters,
  no control or bidi character. The handle rules do not apply to it. An empty `nick` means the
  member's own display name shows.
- `GET /v1/communities` lists the caller's own memberships and nothing else: a community the
  caller left or was removed from, or one that is soft-deleted, is not listed. It names no
  community in its path, so it has no `404`.
- A member row's `username`, `display` and `kind` (`0` user, `1` bot) are the member's account
  fields, as `GET /v1/accounts/me` answers them to that user; a member whose account row is gone
  answers `""`, `""`, `0`. Only a member of the community reaches the route, so these names are
  visible exactly to the people the member shares the community with.

The **policy document** is a UTF-8 JSON object of at most 16 KiB. The instance stores the bytes the
owner sent and serves them back unchanged, but refuses (`400 E_INVALID_REQUEST`) a document that is
not one object, carries a key this table does not list, or has a value out of range. Every key is
optional; `{}` is every default.

| key | type | default | meaning |
|---|---|---|---|
| `join` | `"open"` or `"invite"` | `"open"` | whether a join needs a community invite |
| `screening` | bool | `false` | membership screening; stored and served, **not enforced** by this version |
| `retention_days` | uint ≤ 36500 | `0` | **archival** retention (`02` § Retention): days an application message every cursor has passed is kept; `0` keeps it indefinitely. In this version it is enforced for attachments only (§ Blobs expires a reference older than it); no message is deleted by it yet |
| `delivery_retention_days` | uint ≤ 30 | `0` | **delivery** retention: `0` is the instance's 30 days; a community may shorten it, never lengthen it. In this version it is stored and served but not enforced: every community gets the instance's 30 days |

### Channels

Every route below is `E`. A channel the caller may not view (§ Permissions: `view_channel` in that
channel, overwrites applied), a channel of a community the caller is not a member of included,
answers `404 E_NOT_FOUND` exactly as an unknown or deleted one does. Creating a channel needs
`manage_channels` community-wide; changing and deleting one need it in that channel
(`403 E_FORBIDDEN` otherwise).

| Method and path | Request | Response |
|---|---|---|
| `POST /v1/communities/{id}/channels` | `[kind(uint), mode(uint), visibility(uint), parent_id(bstr16\|null), name(tstr), topic(tstr), position(uint), slowmode_seconds(uint)]` | `201 [channel_id(bstr16), mode(uint), visibility(uint)]` |
| `GET /v1/channels/{id}` | — | `[channel_id, community_id(bstr16\|null), kind, mode, visibility, parent_id(bstr16\|null), name, topic, position, slowmode_seconds, seq, text_group_id(bstr16\|null)]` |
| `GET /v1/communities/{id}/channels` | — | `200 [[channel_id, kind, mode, visibility, parent_id(bstr16\|null), name, topic, position, slowmode_seconds, seq, text_group_id(bstr16\|null)]]`: the live channels the caller may view (`view_channel`, overwrites applied) by `position` then `channel_id`; a category is listed when it or one of its children is visible; `404` for a non-member |
| `PATCH /v1/channels/{id}` | `[name(tstr\|null), topic(tstr\|null), mode(uint\|null), visibility(uint\|null), parent_id(bstr16\|null), position(uint\|null), slowmode_seconds(uint\|null)]` | `204` |
| `DELETE /v1/channels/{id}` | — | `204` |

| field | values |
|---|---|
| `kind` | `0` text, `1` voice, `2` category, `3` DM, `4` group DM. `3` and `4` are not created through a community (`400`) |
| `mode` | `0` end-to-end encrypted, `1` server-readable |
| `visibility` | `0` private, `1` invite, `2` discoverable |

- A channel whose visibility is `invite` or `discoverable` is **server-readable**. Creating one
  with `mode = 0` is not an error: the instance stores `mode = 1` and answers it, and the client
  labels the channel from the answer. A `PATCH` that would make a visible channel end-to-end
  encrypted is `400 E_INVALID_REQUEST`; make it private first. `mode` and `visibility` may not
  change in the same `PATCH` (`400`), because the order they were applied in would decide the
  outcome. This is the rule `02`'s invariant 1 enforces on registration: an MLS `text` group is
  refused for such a channel (`403 E_MODE_READABLE`), while a voice channel's `call` groups exist
  whatever its mode. A `PATCH` that takes an end-to-end-encrypted text channel out of end-to-end
  encryption (to `mode = 1`, or to a visibility that forces it) closes the channel's open `text`
  group after the change commits, and from then on no `Add` or join is admitted to it; its `call`
  group, if any, is untouched.
- A category is always top level. `parent_id` names a live category of the same community; a text
  or voice channel under a text channel, a nested category and a foreign or deleted parent are
  `400`. In a `PATCH`, null leaves the parent alone and the all-zero id moves the channel to the top
  level. Deleting a category moves its channels to the top level.
- `name` is 1–100 bytes and `topic` at most 1024 bytes of UTF-8, with no control character (a
  topic may carry line breaks and tabs). `position` is at most 2 147 483 647 and
  `slowmode_seconds` at most 21 600. A community's channels are ordered by `position`, ties broken
  by `channel_id` (bytewise), the same on every engine.
- `seq` is the channel's own sequence, which the server-readable message path advances.
- `text_group_id` is the `group_id` of the channel's oldest open `text` group (`01` § Group kinds),
  an epoch-unknown one included (`02` invariant 11), for a channel that carries one: kind `0`, `3`
  or `4` in mode `0`. It is `null` while no such group is open — the client then registers one
  (`02`, `POST /v1/groups`) — and always `null` for a server-readable channel, a voice channel and
  a category. A client joins the group it names (`01` § Joining) and does not register another
  while it is not `null`.
- Deleting a community deletes its channels in the same transaction. Deleting a channel, or its
  community, closes the channel's open `text` and `call` groups (`02`) once the deletion has
  committed.

### Roles

Every route below is `E`, and every one needs `manage_roles` community-wide (for an overwrite, in
that channel); a caller who is not a member of the community answers `404 E_NOT_FOUND`.

| Method and path | Request | Response |
|---|---|---|
| `POST /v1/communities/{id}/roles` | `[name(tstr), color(uint), position(uint), allow(uint), deny(uint), hoist(uint), mentionable(uint)]` | `201 [role_id(bstr16)]` |
| `PATCH /v1/roles/{id}` | the same seven fields, each `\|null`; null leaves a field alone | `204` |
| `DELETE /v1/roles/{id}` | — | `204` |
| `PUT /v1/communities/{id}/members/{user_id}/roles/{role_id}` | `[]` | `204` |
| `DELETE /v1/communities/{id}/members/{user_id}/roles/{role_id}` | — | `204`; `404` when the member does not hold the role |
| `PUT /v1/channels/{id}/overwrites/{kind}/{target_id}` | `[allow(uint), deny(uint)]` | `204` |
| `DELETE /v1/channels/{id}/overwrites/{kind}/{target_id}` | — | `204`; `404` when there is no such overwrite |

- **Rank.** A role's `position` orders it; higher is more senior. The owner is above every role;
  anyone else acts only on roles strictly below their own highest role. Creating, changing,
  moving, deleting, granting and revoking a role at or above it is `403 E_FORBIDDEN`.
- **No new authority.** A role's `allow` and `deny`, and an overwrite's, may name only bits the
  caller holds (for an overwrite, in that channel); a grant or revoke of a role that carries a bit
  the caller does not hold is refused the same way, and so is a grant or revoke of a role whose
  overwrite in any channel names a bit the caller does not hold in that channel (a role that opens
  a private channel the caller cannot see is not the caller's to hand out). `403 E_FORBIDDEN`.
- **`@everyone`** is the role at position 0, created with the community and held by every member.
  No other role may be created at or moved to position 0, `@everyone` is never moved, deleted,
  granted or revoked, and all of these are `400 E_INVALID_REQUEST`; its fields and bits may be
  changed like any other role's.
- `name` is 1–100 bytes of UTF-8 with no control character, `color` is at most `0xFFFFFF`
  (24-bit RGB), `position` is 1 to 2 147 483 647, `hoist` and `mentionable` are 0 or 1, and a
  community holds at most 250 roles. A bit outside § Permissions' table is `400`.
- `require_mod_2fa` (§ Communities) additionally gates a grant.
- **Overwrites.** `{kind}` is `0` (the target is a role of the channel's community) or `1` (the
  target is a member of it); anything else is `400`, and an unknown target is `404`. An overwrite
  may not allow and deny the same bit, nor carry a community-wide bit (§ Permissions), both `400`.
  A second `PUT` for the same target replaces the pair.

### Bans

Every route below is `E`. A caller who is not a member of the community answers `404 E_NOT_FOUND`
exactly as an unknown community does. The three ban routes need `ban_members` community-wide and
the kick needs `kick_members` (§ Permissions); `403 E_FORBIDDEN` otherwise.

| Method and path | Request | Response |
|---|---|---|
| `PUT /v1/communities/{id}/bans/{user_id}` | `[reason(tstr), expires(uint\|null)]` | `204` |
| `DELETE /v1/communities/{id}/bans/{user_id}` | — | `204`; `404` when there is no such ban |
| `GET /v1/communities/{id}/bans` | — | `[[user_id, reason, by_user, created, expires(uint\|null)]]`, newest first |
| `DELETE /v1/communities/{id}/members/{user_id}` (kick) | — | `204`; `404` when the target is not a member |

- **Rank.** Nobody may ban or kick the owner, and anyone but the owner acts only on a user whose
  highest role is strictly below their own; a caller who holds no role but `@everyone` acts on
  nobody, and nobody acts on themself. `403 E_FORBIDDEN`.
- A **ban** needs an account of this instance (`404` otherwise) but not a member: a ban may
  precede a join. It removes the membership, and `join` refuses the account while the ban stands.
  A second `PUT` replaces the reason, the moderator, the time and the expiry.
- `reason` is at most 512 bytes of UTF-8 with no control character but line breaks and tabs.
  `expires` is a unix second in the future and at most 3 153 600 000 seconds (a century) away, or
  null for a ban that stands until it is lifted; anything else is `400 E_INVALID_REQUEST`. A ban
  whose `expires` has passed no longer refuses a join but stays listed, as the moderation history,
  until it is lifted.
- A **kick** removes the membership and writes no ban: the user may join again at once.
- Lifting a ban re-adds the user to nothing; they join again.
- After a ban, a kick or a `leave` has committed, the instance, as the external sender (`02`
  § Roles), issues one `Remove` proposal for every live leaf of the user in every `text` and `call`
  group of the community's channels. Each freezes its group (`02` invariant 5) until a member
  commits it, so a user kicked while offline cannot read past the epoch that removes them; a
  `Remove` whose leaf is already gone is dropped (`02` invariant 6). The user's channel membership
  rows and their own (kind 1) channel overwrites for the community go in the same transaction as
  the membership, so a later rejoin starts from the roles and `@everyone` alone. A kind-1
  overwrite whose target is not a member can still be deleted (the target's rank counts as 0);
  writing one still needs a member. The `Remove`s do not depend
  on the request: a client that disconnects after the `204` (or before it) does not cut them short,
  and a `Remove` that is still never issued is proposed by the instance's sweep, which, a page of
  groups at a time, proposes a `Remove` for every live leaf of an open `text` or `call` group whose
  user the channel ACL no longer admits and that no outstanding instance `Remove` targets.
- Every ban, lift and kick writes an audit row naming the moderator (`ban.create`, `ban.delete`,
  `member.kick`).

### DMs

A DM (`kind = 3`, two participants) or group DM (`kind = 4`, three or more) is a channel with no
community: `community_id` is null, `mode` is always `0` (end-to-end encrypted) and `visibility`
`0` (private). Its participants are the only users who see it; to anyone else every route below
and `GET /v1/channels/{id}` answer `404 E_NOT_FOUND`, exactly as an unknown channel does. Every
route is `E`.

| Method and path | Request | Response |
|---|---|---|
| `POST /v1/dms` | `[recipients([bstr16])]` | `201 [channel_id(bstr16)]` new; `200 [channel_id]` the existing 1:1 DM |
| `GET /v1/dms` | — | `[[channel_id, kind(uint), members([bstr16])]]`, newest first, ties broken by `channel_id` |
| `GET /v1/channels/{id}/members` | — | `[[user_id(bstr16)]]`, ordered by `user_id` (bytewise) |
| `PUT /v1/channels/{id}/members/{user_id}` | — | `204` |
| `DELETE /v1/channels/{id}/members/{user_id}` | — | `204`; `404` when the user is not a participant |

- The participants of `POST /v1/dms` are the caller and `recipients`, duplicates dropped. Fewer
  than two (no recipient but the caller) is `400 E_INVALID_REQUEST`, and so is more than the
  instance's group-DM cap, `livekit.max_voice_participants` (so that every participant fits in the
  DM's call). An unknown account is `404`; a disabled or deleted one is `403 E_FORBIDDEN`
  (a disabled account is v1's block).
- A **1:1 DM** is idempotent: its `channel_id` is derived, not random, as the first 16 bytes of
  `SHA-256("dilla dm v1" || lo || hi)`, where `lo` and `hi` are the two user ids sorted bytewise
  and the label is its 11 ASCII bytes. Either participant opening it again, from either side, gets
  `200` and the same id, which is also the `target_id` of its `text` and `call` groups
  (`01` § dilla_binding). The id is a name, not a capability: it opens nothing to a
  non-participant. A group DM's `channel_id` is random, because its membership changes.
- A DM's `text` and `call` groups are registered by a participant (`02` invariant 1) with a
  binding whose `community_id` is null and whose `target_id` is the `channel_id`; the instance
  proposes the `Add` of every other participant's devices (below). A participant's client never
  `Add`s anyone to a DM's `text` group (`01` "Client policy for proposals from members"): a device
  enters it by the Welcome of the commit that carries the instance's `Add`, or by its own external
  commit.
- The member routes set a **group DM**'s participants; any participant may add or remove any
  other, and themself. A 1:1 DM's pair is fixed, and a community channel's membership follows its
  permissions: `PUT` and `DELETE` on either are `403 E_FORBIDDEN`. `GET` lists a community
  channel's members for anyone who may view it. Adding past the cap is `400`; adding an unknown
  account `404`, a disabled or deleted one `403`; adding a participant again changes nothing.
- After a participant is added or removed and the change has committed, the instance, as the
  external sender (`02` § Roles), proposes an `Add` for every device of every participant that
  holds an available KeyPackage and is not already in the DM's `text` group, and a `Remove` for
  every live leaf of a user who is no longer a participant in its `text` and `call` groups. An
  `Add` or `Remove` the instance already has outstanding is not proposed again. A device with no
  available KeyPackage is not proposed; it is added by a later change once it has published one.
- Opening a DM and every add and remove write an audit row (`dm.create`, `channel.member.add`,
  `channel.member.remove`).

### Readable channels

A server-readable text channel (`kind = 0`, `mode = 1`; every `invite` or `discoverable` channel
is one) carries its messages through the routes below instead of an MLS group. The instance
stores each envelope (`04`) as sent and indexes its text for search. Every route is `E`. A caller
who may not view the channel gets `404 E_NOT_FOUND`, as for an unknown channel; for any other
channel — an end-to-end encrypted one, a voice channel or a category — every route answers
`403 E_CHANNEL_MODE`, and an end-to-end encrypted channel's messages go through
`POST /v1/groups/{id}/message` (`02`).

| Method and path | Request | Response | Permission |
|---|---|---|---|
| `POST /v1/channels/{id}/messages` | `[envelope(bstr)]` | `[seq(uint), franking_tag(bstr 32), recv_ts(uint)]` | `send_messages`; `pin_messages` for a type 5 or 6 envelope, `add_reactions` for a type 3 or 4 |
| `GET /v1/channels/{id}/messages?from=&limit=` | — | `[[seq, sender(bstr16), envelope(bstr), franking_tag(bstr 32), created, edited\|null, deleted\|null]]` | `read_history` |
| `PATCH /v1/channels/{id}/messages/{seq}` | `[envelope(bstr)]` | `204` | the author, with `send_messages` |
| `DELETE /v1/channels/{id}/messages/{seq}` | — | `204` | the author only (`403 E_NOT_UPLOADER` for anyone else) |
| `GET /v1/channels/{id}/search?q=&limit=&before=` | — | `[[channel_id, seq, sender, snippet(tstr), score_micros(uint), created]]` | `read_history` |
| `PUT /v1/channels/{id}/read-state` | `[last_read_seq(uint)]` | `204` | `view_channel` |

- **Posting.** `seq` is the channel's own sequence (`GET /v1/channels/{id}` element 10), one step
  per message; `recv_ts` is the instance's clock and is the message's `created`. The instance is a
  receiver in `04`'s sense and refuses exactly what a client refuses, storing nothing partial: an
  envelope that is not a nine-element deterministic CBOR array, or any element of the wrong major
  type or length — `msg_id` and a non-null `thread_id` or `reply_to` 16 bytes, `k_f` 32, an
  attachment's `blob_id` 32, `key` 32 and `nonce` 12, an attachment an eight-element and a preview a
  four-element array — is `400 E_ENVELOPE_SHAPE`; a `type` above 6 is `400 E_ENVELOPE_TYPE`; and any
  bound of `04`'s § Envelope limits (`body` per type, 4 attachments, 2 previews, `mime`, `thumb`,
  `url`, `title`, `description`, preview `image`) is `400 E_ENVELOPE_LIMIT`. The body cap is 96 KiB
  (§ Rate limits). Only a message's (type 0) or an edit's (type 1) `body` is search content, and only
  there does the instance count mentions: the number of distinct `<@…>` targets (a 32-hex-digit user
  or role id, `everyone` or `here`), stored with the message for moderation.
- **Message references.** On a server-readable channel an envelope's `reply_to` and `thread_id`
  carry the target's channel `seq` as a big-endian uint64 in the low eight bytes, with the high
  eight bytes zero; in an end-to-end encrypted group they carry the target's `msg_id` unchanged,
  because there the server has no key to resolve (`04` § Envelope).
- **Envelope types.** A reaction (3, 4) needs `add_reactions` and a pin or unpin (5, 6) needs
  `pin_messages`; both are appended like a message, and clients fold them. An edit (1) or a delete
  (2) on `POST` is the alias of `PATCH` or `DELETE` on the `seq` its `reply_to` names: it is applied
  in place, not appended, and answers `204` with no body. Without a `reply_to`, or with one whose
  high eight bytes are not zero, it is `400 E_ENVELOPE_SHAPE`. An alias delete, being a `POST`,
  also needs `send_messages`.
- **Editing** is the author's alone (`403 E_FORBIDDEN` for anyone else) and takes a type 0 or 1
  envelope (`400 E_ENVELOPE_TYPE` otherwise). The instance re-franks the new envelope: `T` is
  recomputed over its `C`, the editing device and the edit's time, which the message records as
  `edited`, under the current franking key, and the key id is recorded with it. A tag over the
  replaced bytes could never verify.
- **Slow mode.** Inside `slowmode_seconds` of the caller's previous message in the channel, a post
  is `429 E_RATE_LIMITED` with `retry_after_ms` the time left; `bypass_slowmode` is exempt. A
  deleted message still counts, so deleting and reposting does not reset the wait.
- **Franking.** A readable envelope carries its `k_f` in the clear, so the instance computes `04`'s
  commitment `C` itself, unchanged. The tag `T` is `04`'s with two substitutions, because a
  readable channel has no MLS group: `channel_id` in place of `group_id`, and `0` for the epoch. The
  instance records which of its franking keys made the tag, so a report still verifies after a
  rotation.
- **Deleting** tombstones the message: its envelope becomes empty, it leaves the search index, and
  `GET` lists it with its `deleted` time; the franking tag stays for a report. Delete-for-everyone is
  the uploader's alone: anyone else, `manage_messages` or not, is `403 E_NOT_UPLOADER` (moderator
  deletion needs a signed moderation event, which this version does not define). An unknown or
  already deleted `seq` is `404`, and so is an edit of a deleted message. `{seq}` that is not a decimal uint
  is `400 E_INVALID_REQUEST`.
- **Live delivery.** Every accepted post, edit and delete is sent as `message.plain` (op 32, `02`)
  to every live connection of every user who may view the channel and is still a member of its
  community, the author included; `edited` and `deleted` are `1` on an edit's and a delete's frame,
  and a delete's `envelope` is empty.
- **Listing.** `from` is the first `seq` wanted (default: the first message); `limit` defaults to
  50 and is capped at 256.
- **Search.** `q` is words: a trailing `*` makes a word a prefix, text in double quotes is a phrase
  (`""` inside it is a quote), and a leading `-` excludes the word or phrase after it; every other
  character separates words. Matching folds case and diacritics (`haller` finds `håller`) and does
  not stem. A query with no word at all is `400 E_INVALID_REQUEST`; a query of exclusions only
  answers every message in scope without them. The scope is every server-readable text channel of
  `{id}`'s community the caller may view and read the history of. Hits are best first, ties broken
  by the newer `seq`; a `limit` outside 1 to 100 is 50; `before` returns only hits whose `seq`
  is below it. The snippet marks each match with `[` and `]`, and `score_micros` is the relevance
  score times 10^6, rounded, because deterministic CBOR carries no floats.
- **Read state** never moves backwards and never past the channel's newest `seq`: a lower value
  is ignored and a higher one is lowered to it.

### Blobs

An attachment's ciphertext (`04` § Envelope, `attachments`) is stored under its own SHA-256, `blob_id`, and
published into a channel by a **reference**. The reference is the access rule: a blob is read only
through a channel that holds a reference to it and that the caller may read. Every route is `E`,
works for a text channel of either mode, a voice channel and a DM, and answers `404 E_NOT_FOUND`
to a caller who may not view the channel, as for an unknown one; a category holds no attachments
(`403 E_FORBIDDEN`). `{blob_id}` is 64 lowercase hex characters (§ Identifiers). Bodies are raw
octets, `Content-Type: application/octet-stream`, never CBOR; the `PUT` answer and every refusal
are CBOR as everywhere else.

| Method and path | Request | Response | Permission |
|---|---|---|---|
| `PUT /v1/channels/{id}/blobs/{blob_id}` | the ciphertext | `201 [blob_id(bstr 32), size(uint)]` when the bytes are new, `200` with the same body when they were already stored | `attach_files` |
| `GET /v1/channels/{id}/blobs/{blob_id}` | — | `200` the ciphertext, or `206` for a `Range` request | `read_history` |
| `HEAD /v1/channels/{id}/blobs/{blob_id}` | — | `200` with the `GET` headers and no body | `read_history` |
| `DELETE /v1/channels/{id}/blobs/{blob_id}` | — | `204` | `view_channel`, and the uploading user only (`403 E_NOT_UPLOADER` for anyone else) |

- **Uploading.** The instance hashes the body while it writes it and keeps it only when the digest
  equals `{blob_id}`; otherwise the answer is `422 E_INVALID_REQUEST` and nothing is stored. The
  body is hashed even when the blob is already stored: the upload is the proof that the caller
  holds the bytes, so knowing a `blob_id` is never enough to publish it into another channel, and
  a forward re-uploads. A `PUT` into a channel that already holds a reference to the blob adds
  nothing. A body over `blobs.max_blob_bytes` is `413 E_TOO_LARGE`; a `Content-Type` other than
  `application/octet-stream` is `415 E_INVALID_REQUEST`; bytes an instance administrator removed
  are `410 E_PRUNED`, because content addressing would otherwise hand the removed name straight
  back.
- **Quota.** `blobs.quota_bytes_per_user` bounds the ciphertext bytes of the distinct blobs a user
  references, from any of their devices; a blob in several channels counts once. An upload that
  would pass it is `507 E_STORAGE_FULL`, and so is any upload once it is reached; an upload that
  announces a `Content-Length` taking the user past the quota is refused before its body is read.
  `blobs.store_max_bytes` bounds the whole instance the same way (every stored blob counts,
  including one no channel references any more), `507 E_STORAGE_FULL` before the body is read.
- **Upload rate.** Each user may start `blobs.uploads_per_minute` uploads a minute and upload
  `blobs.upload_bytes_per_day` bytes a day (both refill continuously); over either the answer is
  `429 E_RATE_LIMITED` with its `retry_after_ms`, before the body is read. Every byte the instance
  reads spends the day's budget, whether the upload is stored, refused or later deleted: deleting
  an attachment frees quota, never budget.
- **Reading.** `GET` answers `404 E_NOT_FOUND` whenever this channel holds no reference, even when
  the bytes exist, so the answer never says that an unreachable blob exists; `HEAD` has the same
  rule. The response carries `Content-Type: application/octet-stream`,
  `Content-Disposition: attachment`, `X-Content-Type-Options: nosniff`,
  `Content-Security-Policy: default-src 'none'; sandbox`, `Cross-Origin-Resource-Policy:
  same-origin`, `Cache-Control: private, max-age=31536000, immutable`, `Accept-Ranges: bytes`,
  `ETag: "<blob_id hex>"` and `Repr-Digest: sha-256=:<base64 of blob_id>:`, and no
  `Last-Modified`. `Range`, `If-Range`, `If-Match` and `If-None-Match` follow RFC 9110; an
  unsatisfiable range is `416` with a plain-text body, without the `ETag` and `Cache-Control`.
  A blob an instance administrator purged is `410 E_PRUNED` on `GET` and `HEAD` too.
- **Deleting.** `DELETE` removes this channel's **reference**, never the bytes. Only the user
  whose device made the reference may delete it, from any of their devices; anyone else —
  including a holder of `manage_messages` and the community owner — is `403 E_NOT_UPLOADER`,
  because moderator deletion needs a signed moderation event this version does not have. Deleting
  a reference that is already gone is `204`, so a retry is harmless. When the last reference to a
  blob anywhere goes, the instance marks the blob unreferenced, and unlinks the file once
  `blobs.gc_grace` (default 24 h) has passed with no reference created in between; a forward that
  re-uploads the bytes inside that window keeps them.
- **Retention.** An attachment's retention is its community's archival retention: a reference
  older than the community policy's `retention_days` (§ Communities) is removed, and the blob then
  follows the deletion rule above. A community without `retention_days`, a DM and a group DM keep
  attachments indefinitely. Deleting a channel removes its references. Attachment retention never
  follows `02`'s 30-day delivery window, because an archive restore needs attachments far older.

### Voice

A call happens in a voice channel, a DM or a group DM, and its media keys come from the channel's
**call group** (`01`, group kind 1), which its clients register as for any group. A call is keyed by
the call group's call id (`mls_groups.call_id`, the channel id for a call group the instance
registered), so every device of the group lands in the same call. Every route below is `E`; a
caller who may not view the channel gets `404 E_NOT_FOUND`, as for an unknown one.

| Method and path | Request | Response | Permission |
|---|---|---|---|
| `POST /v1/channels/{id}/calls` | `[]` or `[vdec(tstr)]` | `201 [call_id(bstr16), group_id(bstr16), livekit_url(tstr), token(tstr), ice_servers([[urls([tstr]), username(tstr), credential(tstr)]]), caps([max_audio_bitrate_bps(uint), max_share_bitrate_bps(uint), vp9(uint)])]` when the call is opened, `200` with the same body when it is already live; `409 E_CALL_FULL`; `429 E_RATE_LIMITED` with `retry_after_ms` (a few milliseconds, transient) when the device was cut from the relay in the same millisecond or while the request was served; after the relay credential is minted, the refusal its gate would have given (`403 E_FORBIDDEN` barred, `403 E_LEAF_NOT_CURRENT`, `404 E_NOT_FOUND` without `view_channel`, `403 E_FORBIDDEN` without `connect`) when that changed while the request was served; `503 E_UNAVAILABLE` with `retry_after_ms` when the call ended as the request opened it (see **Ending**) | `connect`, and a current leaf of the call group |
| `POST /v1/calls/{call_id}/share` | `[]` | `204` once the device holds a sharing slot and the SFU holds its new permission; `409 E_CALL_SHARERS_FULL`; `404 E_NOT_FOUND` when the call has ended or the device is not in its room; `403 E_FORBIDDEN` while the device's removal or demotion in the call is pending or the device is barred | `connect`, `video` or `screen_share`, and a current leaf of the call's group |
| `DELETE /v1/calls/{call_id}/share` | — | `204`, also when the device held no slot or the call has ended | `view_channel` |
| `POST /v1/calls/{call_id}/stats` | `[candidate_type(uint), relay_protocol(uint\|null), rtt_ms(uint), fraction_lost_permille(uint), decrypt_failures(uint), frames_encrypted(uint)]` | `204`; `429 E_RATE_LIMITED` above one report per device per 5 s; `404 E_NOT_FOUND` once the call has ended; `403 E_FORBIDDEN` for a barred device; `400 E_INVALID_REQUEST` for `decrypt_failures` or `frames_encrypted` above 1048576 | `view_channel` and `connect`, and a current leaf of the call's group |
| `DELETE /v1/calls/{call_id}` | — | `204`, also when the call has already ended or its call group is closed; `403 E_FORBIDDEN` for a barred device and for a device that is listen-only in the call's room for media that is not dilla's | `view_channel` and `connect`, and a current leaf of the call's group while that group is open |

- **The leaf gate.** A token is minted only for a device whose leaf is in the call group's
  **current epoch**: added at or before it and not removed. Any other device — a removed one, one
  whose leaf the instance records only from a later epoch, one with no leaf, or any device while
  the group is epoch-unknown after a restore — is `403 E_LEAF_NOT_CURRENT`, so a device that
  cannot derive the call's media keys cannot join its room either. A channel of another kind is
  `400 E_INVALID_REQUEST`; a voice channel whose call group is not registered yet is
  `404 E_NOT_FOUND`. While a call is live, "the call group" is the one the call was opened on,
  never merely the newest open call group of the channel: a leaf of any other call group is
  `403 E_LEAF_NOT_CURRENT` for that call. A closed call group holds no leaf at all: no commit of it
  can land, so no device is admitted to a call on it. A live call whose group has been closed ends
  at the next start that passes the gate, which opens a fresh call on the channel's current call
  group, or at the room sweep (below), whichever comes first.
- **Capacity.** A start that finds `livekit.max_voice_participants` other devices already in the
  call's room is `409 E_CALL_FULL`. The count leaves out the caller's own device (a rejoin replaces
  its old session), disconnected participants and non-device participants; it is advisory and
  fails open when the SFU cannot answer. The SFU's own room cap is authoritative: a device that
  passes the count in a race with another is refused by the SFU's WebSocket upgrade (HTTP 500), and
  a client shows "could not join the call" for that.
- **The token.** `token` is a LiveKit room-join JWT for the call's room whose identity is the device
  id. It carries the **base grant** only: subscribe, never data, and publish for the microphone when
  the device holds `speak` — never the camera or the screen, even for a device that holds a sharing
  slot. A device without `speak` is listen-only. The camera and screen sources (`video` the camera,
  `screen_share` the screen and its audio) reach a session only as the permission the instance pushes
  after `POST …/share` (below), so a token can never be replayed for video after the device stopped
  sharing; a client that reconnects with a fresh token while it shares POSTs `…/share` again, which
  is idempotent for a slot it holds. When the request carries `vdec` — the device's video decoders,
  comma-separated from `vp8`, `h264` and `vp9`, each at most once (any other spelling is
  `400 E_INVALID_REQUEST`) — the token carries it as the participant attribute `dilla.vdec`, which
  the other devices read to choose a codec every subscriber can decode. The token is valid for one
  hour, but its lifetime bounds neither a session nor a rejoin: the SFU re-issues a connected
  participant's token every five minutes from its current grants, valid for at least ten more
  minutes, so a client that stays connected always holds a token it could rejoin with. What bounds
  access is the signalling proxy, which checks every join and resume against the device's current
  state (below), and the cuts in "Losing access". `livekit_url` is where the client connects with it: `wss://` and the
  instance's own host (its public IP in `acme_ip`), whose `/rtc` paths the instance proxies to its
  in-process SFU, which listens only on `livekit.bind_address`, a loopback IP literal (the
  instance refuses any other value at start). Every start opens the call's room in
  the SFU first and the SFU never opens one on a join, so a token for a room the instance has closed
  is refused by the SFU (HTTP 404). A call gets a fresh room each time it is opened, so a device of
  the previous call cannot remain in the next one. `caps` is what the client applies to its publish
  options: `livekit.max_audio_bitrate_kbps` and `livekit.max_share_bitrate_kbps` in bits per second,
  and `vp9` 1 when `livekit.vp9` is on, else 0 (the instance refuses `livekit.vp9 = true` at start
  until VP9 has a frame test vector and a measured run through the SFU, so `vp9` is 0 today). An instance that runs no SFU (`livekit.enabled =
  false`) still answers every refusal above, and a start that passes them is `501 E_INTERNAL` with
  no call recorded.
- **Sharing.** A device takes a **sharing slot** before it publishes its camera or its screen: one
  slot per device covers camera, screen and screen audio together, screen audio never needs one of
  its own, and the microphone never does. At most `livekit.max_publishers` devices of a call hold a
  slot; the next `POST …/share` is `409 E_CALL_SHARERS_FULL`, decided by the instance alone, so of
  two devices racing for the last slot exactly one wins. The instance pushes the device's complete
  new permission to the SFU before it answers `204`; the client publishes only after the SFU's
  permission update shows the new source. `DELETE …/share` takes the camera and screen sources away
  first and frees the slot after. The slot is also freed when the device loses both `video` and
  `screen_share`, when it is cut from the call, when a share or a permission push finds it no longer
  in the room, and when the call ends; a slot belongs to the room it was taken in and never carries
  into a later call. The instance also frees the slot when its SFU reports that the device stopped
  its last camera and screen track (the camera and screen sources are taken away first) — unless
  the SFU shows the device publishing a camera or screen track again by the time the report is
  handled, as when it switches from one to the other — or left the room; those reports can be late
  or lost, so a device that stops sharing sends `DELETE …/share` itself, and the room sweep frees
  the slot of a device its room no longer holds, so a device that crashed or whose leave report was
  lost holds its slot no longer than the room sweep's bound (below); one whose removal or demotion is
  pending keeps it until that repair lands. A permission change during a call is pushed to the SFU
  immediately after it (below).
- **Losing access.** A device is **barred** from every call when the device is revoked or
  quarantined (`02` invariant 9) or its user is disabled or deleted: a start answers it
  `403 E_FORBIDDEN` and mints nothing, a share and an end (`DELETE /v1/calls/{call_id}`) answer
  `403 E_FORBIDDEN`, and the signalling proxy refuses it. A device that is barred, or whose user
  loses `view_channel` or `connect` in the channel, is disconnected from the call's room with every
  `"<device>#…"` participant of it, before the call group's `Remove` of its leaf is committed, and
  its sharing slot is freed. No request waits on the SFU for that: a role or overwrite change, a
  kick, a leave, a ban, a group-DM removal, a channel's visibility change, a device revocation
  through `DELETE /v1/devices/{id}` or an account deletion, a user disable through the admin route,
  a fork quarantine and a commit that removes a device from a call group each **queue** the cut once
  their change has landed, and the instance's background loop, woken by the request, makes it
  immediately after on its own; the request answers without waiting for it. "Immediately after" is
  at once when the loop is idle; when the loop is in one of its passes (a retry pass, at most 15
  seconds; a room sweep, at most 20; the closing of ended calls' rooms, at most 15), the queued cut
  is made between two calls or rooms of that pass, after at most one call's work (2 seconds of
  waiting for the call's serialisation and its bounded SFU calls). A cut that has to visit many
  calls (a role change in a large community) runs for at most 15 seconds and leaves every call it
  did not reach to the next retry pass, at most five seconds later. Meanwhile the device is
  refused everywhere, since the start, share and signalling-proxy checks re-read its state, its
  permissions and its leaf on every request. The queue is bounded (1024 entries) and coalesces
  repeats; a request that does not fit makes the loop run the room sweep (below) at once, so its
  cut waits for the room sweep's bound. A change written to the database by another process —
  `dillad admin user disable` or `delete`, an admin device revoke — and a device admitted by the signalling proxy just
  before it lost access are caught by the **room sweep**: on the loop's five-second tick, at most
  every 30 seconds, the instance lists its SFU's rooms and, for each live call's room, applies the
  same rule to every participant. **The room sweep's bound**: one pass visits at most 64 rooms,
  going on from where the last pass stopped, lasts at most 20 seconds (the rooms it does not reach
  wait for the next pass), and skips a call whose serialisation stays busy for 2 seconds (it is
  visited again at the next pass); a pass starts after the tick's queued work and retry pass. So a
  room is reached within about 30 seconds per 64 live call rooms when the SFU answers promptly,
  and one more period for each pass cut short or call skipped. The sweep also closes every room that belongs to no
  live call — a room whose close failed when its call ended, an older room of a call, a name that is
  no call's — and ends a live call whose channel is deleted or whose call group is closed, closing
  its room. When the instance cannot resolve a participant's permissions or state, it takes every
  publish grant away from that participant rather than leave the old one in place. A participant
  whose identity is no device of the instance is removed from a call's room. A removal or demotion
  the SFU does not take stays **pending**: the device keeps counting against
  `livekit.max_publishers`, a start of the call answers it `403 E_FORBIDDEN` and the signalling proxy
  refuses it, and the instance retries every five seconds and at that device's next start, share or
  signalling request until the SFU holds a permission within the device's entitlement or the device
  has left. Every slot transition and every permission the instance pushes for a call is serialised
  per call, so the devices that may publish a camera or screen source are always among the slot
  holders. A start, a share, an unshare or the signalling proxy that cannot take that serialisation
  within two seconds — the SFU is stuck on the call — answers `503 E_UNAVAILABLE` with
  `retry_after_ms`; the client retries after the delay. Once it has it, a request holds it for at most
  six seconds and the instance's own background work for at most ten per call.
- **The signalling proxy.** The `/rtc` paths admit only `GET` (anything else is `405`). The access
  token — a non-empty `Authorization` header, which must then be `Bearer`, else the `access_token`
  query parameter — must be one the instance minted (`403 E_FORBIDDEN` otherwise), for a device, and
  that device must be a current leaf of the live call whose room the token names
  (`403 E_LEAF_NOT_CURRENT` otherwise), so a device the call group has removed cannot rejoin with a
  token the SFU re-issued to it. The device must not be barred, its user must still hold
  `view_channel` and `connect` in the channel, and no removal or demotion of it may be pending
  (`403 E_FORBIDDEN`), and the token may
  confer nothing beyond the device's current base grant (`403 E_FORBIDDEN`): a token minted while
  the device held `speak` is refused once `speak` is revoked, and a token the SFU re-issued while the
  device shared (it carries the camera) is refused for a fresh join — the client starts the call
  again for a base token and POSTs `…/share`. A resume of a session is exempt from the per-source
  comparison only, because the SFU keeps a resumed participant's own permission and never reads the
  token's, and refuses a resume of a participant it does not hold; every other check applies. The
  instance reads a resume exactly as its SFU does: without `join_request`, `reconnect` `1` or
  `true`; with `join_request` (the `/rtc/v1` form), the `reconnect` field of the base64url
  `WrappedJoinRequest`'s `JoinRequest`, uncompressed or gzip. A `join_request` the SFU would refuse —
  not base64url, not protobuf, or larger than 1 MiB raw or once decompressed — is
  `400 E_INVALID_REQUEST`. A join the checks above admit must also name signalling protocol 17 —
  the `protocol` query parameter without `join_request`, the `JoinRequest`'s `client_info.protocol`
  with it — and, with `join_request`, a `client_info.sdk` the SFU's enum names; any other value,
  including none, is `400 E_INVALID_REQUEST`, because the SFU labels its metrics with both. The
  paths are metered per client address on the `unauth` bucket of
  `[limits.rate]` (`429 E_RATE_LIMITED` with `retry_after_ms`). The instance removes a `publish`
  query parameter and the `CF-Connecting-IP` and `X-Real-IP` headers before the request reaches the
  SFU, and `X-Forwarded-For` carries only the client address the instance resolved.
- **Relays.** `ice_servers` is the `RTCIceServer` list for the client's peer connection: one entry
  when the instance runs its TURN relay, with a fresh ephemeral credential — `username` is
  `"<expiry>:<device_id>:<issued>"` — the expiry in unix seconds, `turn.credential_ttl` ahead
  (default one hour), and the time it was minted in unix milliseconds, never ahead of the
  instance's clock — and
  `credential` is `base64(HMAC-SHA1(turn shared secret, username))`, the time-limited REST form
  TURN servers validate — and an empty array when it runs none. A client passes this list to its
  peer connection even when it is empty, so the SFU's own server list never reaches it, and sets
  `bundlePolicy: 'max-bundle'`. The relay is `turns:` on the instance's 443, where the instance
  tells a STUN stream from HTTP by its first bytes after the TLS handshake; in `behind_proxy` it is
  a separate operator-configured TCP port, and without one the list is empty and the client's
  "relay unavailable" dialog applies: the call is direct UDP or nothing. That relay is plain `turn:`
  on the listen port, because the instance terminates no TLS for it there (a recorded deviation
  from the spec, plan dillad-2 **D25**): its credential username and allocation traffic cross the
  network in cleartext unless a TLS front the operator runs carries it, while the media itself stays
  DTLS-SRTP with SFrame. When `turn.public_url` is set, in any mode, it is the one URL in `urls`,
  verbatim — for a proxy that terminates TLS for the relay (`turns:`) or publishes it on another
  port. The credential's expiry is checked on `Allocate` only: an allocation made before it keeps
  refreshing and permitting after it, until `turn.max_allocation_age` (default two hours, never
  shorter than `turn.credential_ttl`) has passed since the credential was issued (the issue time it
  carries), when every request made with that credential is refused and the client's next ICE
  restart allocates anew. The bound is per credential: a refresh made with a newer credential of the
  same device keeps the allocation, and channel data, which is never authenticated, flows until its
  permission or channel binding lapses (at most five and ten minutes). A device that is cut — revoked,
  quarantined, logged out, of a user who is disabled, or removed from a call's room for any reason
  (barred, no longer a leaf of the call group, without `view_channel` or `connect`, evicted, or
  disconnected for media that is not dilla's) — loses the relay at once: every credential of it
  issued at or before the cut's millisecond (never later than the instance's clock) is refused on
  every request, and its allocations end. Its `Allocate`s whose relay pion was still creating as the
  cut landed are refused with STUN error 508 — and so may be every `Allocate` of that device for up
  to 5 seconds after the last of them, a fresh credential's included, so a client retries a refused
  `Allocate` after more than 5 seconds. A device that may still take part in a call gets a credential
  issued after the cut from its next `POST /v1/channels/{id}/calls`; a client whose relay refuses it
  (a failed relayed pair, an allocation the relay dropped, an `Allocate` refused 400, 401 or 508)
  re-POSTs that route and ICE-restarts with the new list. A start whose device was cut in the same
  millisecond, or while the start was served, is answered `429 E_RATE_LIMITED` with a
  `retry_after_ms` of a few milliseconds and no credential; it changes no cut, and the retry's own
  gates answer whether the device may still call. The instance's wall clock stepping backwards
  stretches that wait: until the clock passes a device's cut again, its starts are answered
  `429 E_RATE_LIMITED` with a `retry_after_ms` that names the remaining time (a credential issued at
  or before the cut would be refused by the relay anyway), and a step back past the process start
  refuses every device's start the same way until the clock passes the start. A start whose gates changed after the credential
  was minted (barred, no longer a leaf, without `view_channel` or `connect`) is refused with that
  gate's code, and the device is cut as of then, which covers the credential just minted. The
  relay refuses every credential issued before its process started: the cuts are held in memory
  only, and a restart ends every call anyway (the SFU runs in the same process), so every client
  re-POSTs the calls route for a fresh credential. Should the instance ever hold more live cuts than
  it can store (65 536), the cut that does not fit refuses every device's credentials issued up to
  it, so every relayed client re-fetches its servers rather than any revocation being forgotten. A
  device another process bars (`dillad admin`) is found by the relay itself on its next
  authenticated request — which can be up to 30 seconds late, because a lookup that found the device
  not barred is trusted for 30 seconds — or, while it holds an allocation and sends only channel data, by a re-check
  every 30 seconds that trusts a lookup for 30 seconds: within 62 seconds of the revocation at worst
  (two periods and a 2-second lookup); while the database cannot answer, such a device stays bounded
  by `turn.max_allocation_age` only. A user disabled in the instance's own process loses every
  device's relay when the call cut queue processes the user, at once while the SFU runs and the
  queue (1024 pending cuts) has room; otherwise, as for a revocation by another process, through the
  relay's own lookup, and the room sweep removes such a device from every call room within its
  period. A client keeps fresh servers by repeating `POST /v1/channels/{id}/calls` before
  `turn.credential_ttl` runs out and handing the new list to its peer connection for that restart.
  The relay checks the username strictly: exactly three fields, both numbers unsigned decimal
  digits without a leading zero, the device a device id, the issue time no more than 2 seconds
  ahead of its clock, and a lifetime no longer than `turn.credential_ttl` and those 2 seconds
  (`turn.credential_ttl` is at least one minute). An `Allocate` is accepted while the relay's clock,
  in milliseconds, is at most the expiry times 1000 — that millisecond included, the next one
  refused — so a credential never works for an `Allocate` past its
  issue time plus `turn.credential_ttl`. `dillad doctor` mints its probe credential in its own
  process: run from another host, it needs that host's clock within 2 seconds of the instance's, or
  the relay refuses the probe. At most
  `turn.allocations_per_device` relay allocations are live per device (default 4); another is
  refused with STUN error 486 until one ends, and the instance counts the refusals. An allocation
  the relay cannot create (STUN error 508 — a relay of an address family the relay address is not,
  say) holds no slot. Four is two
  networks through one ICE-restart overlap: a browser holds about `T × N × U` allocations — T = 1
  gathering transport under `max-bundle` (seven during the first offer under the default
  `balanced`), N = the networks it gathers on, U = 1 relay URL. Whatever the devices, at most 8192
  relay allocations are live on the instance; another is refused with STUN error 486 until one
  ends. The relay reaches only the instance's own SFU, at addresses the SFU both offers and
  receives media on: `livekit.node_ip` when it is an address the SFU listens on in the instance's
  host, or when `livekit.advertise_internal_ip` is false (it is then the SFU's only candidate, and
  relayed media leaves the host for it and comes back), and with `livekit.advertise_internal_ip`
  the host's interface addresses the SFU listens on — none inside `livekit.ips_excludes`. A
  `CreatePermission` or `ChannelBind` for any other peer is refused with STUN error 403, and with
  LiveKit off every one is. On an admitted address the relay exchanges datagrams only with the
  SFU's media port (`livekit.udp_port`, or the SFU's 50000-60000 range when it is 0) and never
  with another relay allocation: a datagram a client sends to any other port, or one that arrives
  from any other port, is dropped without an error. With `livekit.udp_port` 0 that range is a range
  of ports, not the SFU's sockets alone: any UDP service bound in 50000-60000 on an admitted address
  is reachable through the relay too. The relay offers UDP relays only: an `Allocate`
  with `REQUESTED-TRANSPORT` TCP (RFC 6062) is refused with STUN error 508, so no `Connect` can open
  a TCP connection through it; an `Allocate` with `EVEN-PORT` or `RESERVATION-TOKEN` is refused with
  STUN error 508 too. A connection to the relay that has created no allocation within 30 seconds of
  connecting is closed, and so is one that has gone 61 minutes since its allocation was created or
  since its last authenticated request while it held one; other bytes, an `Allocate` refused after
  authentication, and requests that fail authentication (a revoked device, an expired credential)
  keep no connection open.
- **Call stats.** A device in a call reports its connection about every 30 seconds: the selected
  candidate's type (0 host, 1 srflx, 2 prflx, 3 relay), the relay's transport when it is a relay
  (0 udp, 1 tcp, 2 tls; null for any other type), the round-trip time in milliseconds (at most
  60 000), the fraction of packets lost in thousandths (at most 1000), and the frames it failed to
  decrypt and the frames it encrypted since its previous report (each at most 1 048 576). Anything
  else is `400 E_INVALID_REQUEST`. The leaf gate and `connect` apply as for a share
  (`403 E_FORBIDDEN` without `connect`), and a barred device is `403 E_FORBIDDEN`. The instance
  keeps the reports in memory only, for the admin's diagnostics (§ Admin) and counters that name no
  device, and accepts one per device per 5 seconds (`429 E_RATE_LIMITED` with `retry_after_ms`); a
  report sent sooner is refused before anything else is checked.
- **Media that is not dilla's.** Every track a device publishes must be `dilla-sframe/1` (`05`) and
  of its source's kind (audio for the microphone and screen audio, video for the camera and the
  screen). The first track the SFU reports otherwise — flagged unencrypted, or of the wrong kind,
  in the SFU's report of the publication or in its participant list as the room sweep reads it
  (one publication counts once, whichever saw it first) — makes the device listen-only for the rest of the call's room: every publish permission is taken
  away (which unpublishes its tracks), its sharing slot is freed, a start mints it a listen-only
  token, the signalling proxy admits it listen-only, and a share answers `403 E_FORBIDDEN`. A second
  such track disconnects it from the room.
- **Ending.** `DELETE` ends the call for everyone and is kept to its participants. A call also ends
  when the SFU closes its room — 20 seconds after the last participant leaves, or 300 seconds after
  it was opened when nobody joined; a report of the close of a room the SFU has since re-opened
  under the same name, for a start that came after it, ends nothing, and neither does one the
  instance cannot check against its SFU (the call then stays recorded live, with no room, until its
  next start re-opens the room) — when a start finds its call
  group closed, and when its channel, or the community of its channel, is deleted. Ending a call
  **closes its call group** first, then ends its voice session, closes its room (disconnecting
  everyone still in it), frees every sharing slot and sends `voice_state` with `flags` 0 (`02` §
  Gateway frames) for every device still in it; the next call registers a fresh call group (`01`),
  and a start before one is registered is `404 E_NOT_FOUND`. A start that read the call group open
  just before an end closed it, and so would reopen the call on a closed group, ends that call again
  at once and answers `503 E_UNAVAILABLE` with `retry_after_ms`; its retry opens the next call or is
  `404 E_NOT_FOUND`. A deleted channel's call is ended in the record within the delete request, so
  every start, share and signalling-proxy request refuses it from then on; its room is closed
  immediately after by the background loop. When the instance cannot read the channel's live calls
  in the delete request, the room sweep ends them within its bound (the signalling proxy refuses
  every join of a deleted channel's call meanwhile). A restore ends every live call (`02` invariant 11).
- **Leaving.** A device leaves a call by posting its self-Remove proposal to the call group (`01`
  § Joining) and only then disconnecting from the SFU. The instance learns of the leave from the
  SFU — under a millisecond after a graceful disconnect on loopback, and 20–22 seconds after a crash
  or a lost network (the SFU's ICE timeout plus its cleanup; `docs/spikes/2026-10-livekit-webhooks.md`
  measured 20.4–21.9 seconds with a killed client) — and the SFU's reports can arrive up to about 45
  seconds late after the instance's receiver was briefly unavailable, or not at all. On that report
  the instance frees the device's sharing slot and proposes its own `Remove` of the device's leaf,
  whether or not the device posted one (whichever of the two is committed removes it, `02`
  invariant 6); the `Remove` is of the leaf the leaving session was admitted with by the signalling
  proxy — that leaf, taken in that epoch — and is not proposed when the device has since left the
  call group or rejoined it (at another leaf, or the same leaf added again in a later epoch), nor
  when the instance does not know the session's admission. When that membership is gone but the
  same device holds another leaf of the call group — it re-joined the group from inside the call,
  as a resync does — the `Remove` is of the leaf it holds now, provided the SFU shows the device out
  of the room and it was not admitted in the last 30 seconds; otherwise the sweep below decides.
  The admission is recorded only for a join the signalling proxy lets through to the SFU: a request
  it refuses records none. A leave of a session the device has
  already replaced by rejoining, and a leave the SFU reports after the call has ended, change
  nothing. A device that stays out of the call's room while it holds a leaf of the call group — its
  leave report lost, or disconnected by the instance and the report of that lost — loses the leaf
  too: when a room sweep (or any reconcile of the whole room: a room resync, a channel- or
  community-wide grant change) finds a current leaf whose device is not in the room, and one at
  least one sweep period (30 seconds) later finds the same leaf, taken in the same epoch, still not in it,
  the instance proposes its `Remove`, bound to that membership. A device the signalling proxy
  admitted, or a start gave a token, in the last 30 seconds is left alone while it connects. So such
  a leaf is removed within about two sweep periods, longer under the room sweep's bound (above),
  and never once the device has rejoined the group. The `voice_state` frames
  these reports cause are coalesced per device: a device's latest state is sent at most every
  250 milliseconds. A device the call group removes is
  disconnected from the room as soon as the commit is accepted (the background loop removes it, the
  committer's request does not wait for it), a removal the SFU does not take is
  retried like any other pending removal, the room sweep disconnects any participant that is no
  current leaf of the call group, and the signalling proxy refuses its rejoin.

### Reports

A report reveals one message to the instance's admins so they can verify what was sent (`04` §
Franking). Filing is `E` for any enrolled session; the queue and its status are instance-admin only
(§ Flags), `403 E_FORBIDDEN` for anyone else.

| Method and path | Request | Response |
|---|---|---|
| `POST /v1/reports` | `[group_id(bstr 16), seq(uint), envelope(bstr), k_f(bstr 32)]` | `201 [report_id(bstr 16), verification_result(tstr)]` |
| `GET /v1/reports?limit=` | — | `[[report_id(bstr 16), reporter(bstr 16), group_id(bstr 16), seq(uint), revealed_envelope(bstr), verification_result(tstr), status(uint), created(uint)]]` |
| `PATCH /v1/reports/{id}` | `[status(uint), result(tstr)]` | `204` |

- **The target.** A `group_id` that names a registered MLS group is a ciphertext message of that
  group; any other is read as a server-readable channel's `channel_id`, whose messages carry the
  same franking tuple with the channel id in the `group_id` slot and epoch `0` (§ Readable
  channels). A message the instance never stored is `404 E_NOT_FOUND`; a deleted one is still
  reportable, because the tuple outlives the content. A malformed body, or a `k_f` that is not 32
  bytes, is `400 E_INVALID_REQUEST`. The body cap is 96 KiB, as on the envelope routes, so a
  maximal legal envelope can be reported.
- **Verification.** The instance recomputes `04`'s `C` from the submitted `envelope` and `k_f` and
  compares it with the `C` it stored at upload, then recomputes `T` from its own stored `(group_id,
  epoch, seq, uploader_device, recv_ts)` and that `C` under the franking key the message records
  (`03` § Instance keys: retired franking keys are kept for this), and compares it with the stored
  tag. On a server-readable message edited since, the stored tuple is the edit's: the editing
  device and the edit's time. A report that does not verify is still filed: it is evidence about
  the reporter. `verification_result` is exactly one of `verified` (both equations hold),
  `envelope_malformed` (not a `04` envelope, so no `C`), `no_commitment_stored` (the instance holds
  no `C` for the message), `commitment_mismatch` (the envelope or `k_f` is not what was sent),
  `franking_key_unavailable` (the key the message names is no longer held), `franking_key_unknown`
  (a message stored before its key was recorded, and no retained key made its tag) and
  `tag_mismatch` (`C` matches but the stored tag does not).
- **What is kept and shown.** The report stores exactly the submitted `envelope` bytes, `k_f`, the
  id of the key the message was franked with, the result and the reporter. The queue shows the
  eight elements above and nothing else about the group: no other message and no member list.
  Authorship rests on the instance's session-to-device record, an operator attestation that is
  deniable to third parties.
- **The queue.** Newest first (ties by `report_id`), at most `limit` (default 100, at most 1000).
- **Status.** `0` open (the state a report is filed in), `1` resolved, `2` dismissed; any other
  value is `400 E_INVALID_REQUEST`, and so is a `result` over 1 024 bytes or with a NUL. An unknown
  report is `404`. `PATCH` never changes `verification_result`, which is the instance's finding and
  not a moderator's; `result` becomes the detail of an audit row whose action is `report.reopen`,
  `report.resolve` or `report.dismiss` and whose target is the report id in hex.

### Admin

The instance-admin routes. Every one is `E` and needs a user whose `users.flags` has bit 0 set
(§ Flags); anyone else is `403 E_FORBIDDEN`. Every action is written to the audit log.

| Method and path | Request | Response |
|---|---|---|
| `DELETE /v1/admin/blobs/{blob_id}` | `[reason(tstr)]` | `204` |
| `GET /v1/admin/audit?since=&limit=` | — | `[[actor(bstr 16)\|null, action(tstr), target(tstr), detail(tstr), at(uint)]]` |
| `POST /v1/admin/users/{id}/disable` | `[disabled(uint)]` | `204` |

- **Purge.** `DELETE /v1/admin/blobs/{blob_id}` removes every reference to the blob in every
  channel, deletes it and unlinks the file at once, and records a tombstone, so a later `PUT`,
  `GET` or `HEAD` of those bytes is `410 E_PRUNED`. Without the tombstone, content addressing would
  hand the purged name straight back to anyone still holding the ciphertext. Purging bytes the
  instance does not hold still records the tombstone, so the table is also the operator's
  blocklist; a second purge of the same bytes is `204`. `reason` is 1..1024 bytes with no NUL and
  becomes the audit row's `detail` under the action `blob.purge`, whose `target` is the blob id in
  hex. A purge removes **bytes, not content**: every attachment is encrypted under its own random
  key, so the same file sent again by anyone has a different `blob_id`.
- **Audit.** The rows whose `at` is at or after `since` (unix seconds, default 0), newest first, at
  most `limit` (default 100, at most 1000). An empty log is an empty array.
- **Disable.** `[1]` sets the user's `disabled_at` and, in the same transaction, deletes every
  session of every device of that user; `[0]` clears `disabled_at`. Any other value is
  `400 E_INVALID_REQUEST`, an unknown user `404 E_NOT_FOUND`. The audit action is `user.disable`
  or `user.enable` with the user id in hex as `target`.
- **Diagnostics.** `GET /v1/admin/diagnostics` answers `200 [[name(tstr), status(uint),
  detail(tstr), fix(tstr)]]`: first the `dillad doctor` legs the running instance can answer
  itself, under doctor's names and in doctor's order — `database` (the schema version), `data_dir`
  (its mode), `wasi` (the core the delivery service validates in), `udp`, `blobs` (every referenced
  file present, no stray files) — then two legs of the instance's own, which doctor does not have:
  `calls` (the call stats of the last 15 minutes: how many of the calls that reported are still
  live, the reports, how many had a relay selected, the median and 95th-percentile round-trip time,
  and the decrypt failures against the frames encrypted; WARN while any decrypt failure was
  reported) and `turn_relay` (the relay's live allocations and the quota refusals since start;
  WARN after any refusal). `status` is 0 OK, 1 WARN, 2 FAIL; `fix` is the operator's next step or
  `""`. The legs that probe the network or need a process of their own — the config parse, the
  SQLite pragmas, clock skew, the certificate and doctor's `turn` leg, a TURN allocation — are only
  `dillad doctor`'s, so an admin request never makes the instance dial out. The report runs only
  after the admin check.

Informative: the operator's own surface is `dillad admin <noun> <verb>`, run at a shell on the
instance's host and acting as the operator, who is not a `users` row. `user list|show|disable|
enable|delete`, `invite create|list|revoke`, `community list|show`, `device revoke`, `blob purge`
and `audit` read and write the same tables as the routes above. Every verb that changes state
writes an audit row with a null `actor` (and the same `action` names: `user.disable`, `user.enable`,
`user.delete`, `invite.create`, `invite.revoke`, `device.revoke`, `blob.purge`); a read-only verb
writes none. `invite create` prints the link once and stores only its hash; the audit row and the
log carry the 8-hex reference. The command is a separate process from `dillad serve` and cannot
close a gateway connection; the running instance ends the connections of a disabled user or a
revoked device within one heartbeat interval (`02` § Device sessions, item 6). `user delete` is the
tombstone of `DELETE /v1/accounts/me`: the handle stays reserved. The command refuses a database
whose schema is not the one the binary embeds (exit 78).

## Permissions

A permission set is a 64-bit unsigned integer; `roles.allow`, `roles.deny` and a channel
overwrite's `allow` and `deny` all carry it. The values are fixed and never renumbered, because a
stored row is a number, not a name. Bit 62 and above are never used, because `allow` and `deny`
are stored in a signed 64-bit integer on Postgres. A stored bit outside this table is ignored.

| bit | name | scope |
|---|---|---|
| 0 | `view_channel` | channel |
| 1 | `send_messages` | channel |
| 2 | `manage_messages` | channel |
| 3 | `pin_messages` | channel |
| 4 | `attach_files` | channel |
| 5 | `add_reactions` | channel |
| 6 | `read_history` | channel |
| 7 | `connect` | channel |
| 8 | `speak` | channel |
| 9 | `video` | channel |
| 10 | `screen_share` | channel |
| 11 | `create_invite` | channel |
| 12 | `kick_members` | community |
| 13 | `ban_members` | community |
| 14 | `manage_channels` | channel |
| 15 | `manage_roles` | community |
| 16 | `manage_community` | community |
| 17 | `view_audit_log` | community |
| 18 | `mention_everyone` | channel |
| 19 | `bypass_slowmode` | channel |
| 20 | `administrator` | community |
| 21 | `mute_members` | channel |
| 22 | `move_members` | channel |
| 23 | `manage_nicknames` | community |

A **community** bit is about the community, not one channel: a channel overwrite can neither grant
nor remove it. `@everyone` is the role at position 0 and applies to every member; no other role may
be created at or moved to position 0. A user's permissions in a channel resolve in this order:

1. The community owner holds every bit.
2. Starting from none, `@everyone` and then each role the user holds, in ascending `position`
   (ties broken by role id, bytewise), apply their `deny` and then their `allow`.
3. `administrator` in the result means every bit; without `view_channel`, no bit at all.
4. The channel's role overwrites for the roles applied in step 2, in the same order, then the
   user's own overwrite, apply their `deny` and then their `allow`; community bits keep their
   value from step 2.
5. `administrator` means every bit; without `view_channel`, no bit at all.

A DM or group DM (§ DMs) has no community, no roles and no overwrites: each participant holds
exactly `view_channel`, `send_messages`, `pin_messages`, `attach_files`, `add_reactions`,
`read_history`, `connect`, `speak`, `video` and `screen_share` in it, and anyone else holds nothing.

## Rate limits

Every bucket is in-process, keyed by `(class, subject)` where subject is the device session, the
user, or the client address (IPv6 keyed by `/64`, not `/128`). A refusal never reserves a token it
then gives back: an `Allow`-style check mutates nothing when it refuses. `retry_after_ms` in the
error array is the bucket's actual deficit, rounded up to the next millisecond; the `Retry-After`
header carries the same value in whole seconds. The commit and proposal paths are metered
separately and loosely, so the delivery service's own throttle never becomes the reason its
committer-election watchdog removes a device.

Body caps: `max_ciphertext_bytes + 4096` on `POST /v1/groups/{id}/message`; 96 KiB on
`POST /v1/channels/{id}/messages`, `PATCH /v1/channels/{id}/messages/{seq}` and `POST /v1/reports`
(`protocol/04`'s own worst-case legal envelope is ≈ 74 KiB, so a smaller cap would refuse a maximal
but valid envelope before the validator ever saw it); 64 KiB on every other CBOR route; `blobs.max_blob_bytes` on a
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

## Operational endpoints

These are not under `/v1` and carry no CBOR.

| Method and path | Auth | Response |
|---|---|---|
| `GET /healthz` | — | `200 ok` while every background worker makes progress; `500` naming the stalled ones otherwise |
| `GET /readyz` | — | `200 {"status":"ready"}`, or `503` with `"unready"` and only the failed gates named, or `"draining"` during shutdown |
| `GET <metrics.path>` (default `/metrics`) | `Bearer` token when `metrics.require_admin` | the Prometheus text exposition; `401` without the token |

The metrics token is the environment variable `DILLA_METRICS_TOKEN`, never a `dilla.toml` key: the
configuration file is diffed and copied around, and the token is a credential (systemd's
`EnvironmentFile=` is where it belongs). With `metrics.require_admin = true` and the variable unset,
the instance guards the endpoint with a random token nobody holds and logs that every scrape will be
refused, so an unset token never leaves the endpoint open.

## Web client and content manifest

The instance serves the browser client from its own origin. The client therefore needs no CORS
(the instance sends none) and passes the gateway's same-host `Origin` rule (`02` § Gateway frames,
Connecting). The served tree is embedded in the binary when it is built; a binary built without the
client serves a one-page placeholder that names itself with `<meta name="dilla-web"
content="placeholder">`.

**Which requests the client answers.** A request for which the instance has a route — every route
of this document and of `02`, `GET /gateway`, `/rtc`, `GET /i/{code}` and the operational
endpoints — is answered by that route when its method is routed. A path equal to or below one of the
reserved prefixes `/v1/`, `/gateway`, `/rtc`, `/i/`, `/healthz`, `/readyz`, `/metrics` and `/debug/`
(each also without its trailing `/`) is never answered by the client: an unknown one is
`404` with the body `404 page not found`, a known one asked with the wrong method `405` with
`Allow`. Every other request is the client's, in this order:

1. A method other than `GET` or `HEAD` is `405` with `Allow: GET, HEAD`.
2. A path containing `..` or a NUL byte is `404`. `/` is `index.html`.
3. A path naming a file of the manifest is that file.
4. A path whose last segment contains no `.` is `index.html` with `200`: the client's own routes
   (`/welcome`, `/c/<community>/<channel>`) are resolved in the browser.
5. Anything else is `404`.

**Headers.** Every file is served with an explicit `Content-Type` chosen by extension and never
sniffed: `.html` `text/html; charset=utf-8`, `.js` `text/javascript; charset=utf-8`, `.css`
`text/css; charset=utf-8`, `.wasm` `application/wasm`, `.json` `application/json`, `.woff2`
`font/woff2`, `.woff` `font/woff`, `.svg` `image/svg+xml`, `.png` `image/png`, `.ico` `image/x-icon`,
`.txt` `text/plain; charset=utf-8`; a tree holding a file of any other extension is refused at
start. `ETag` is the file's quoted SHA-256 from the manifest, and a request whose `If-None-Match`
names it is `304` (which carries no `Content-Type`). Files under `/assets/` (content-hashed by the
build) are `Cache-Control: public, max-age=31536000, immutable`; every other file, `index.html`
included, is `Cache-Control: no-cache`.

Every `200` and every `304` of every file, whatever its extension, carries the same set of headers:

    X-Content-Type-Options: nosniff
    Referrer-Policy: no-referrer
    X-Frame-Options: DENY
    Permissions-Policy: camera=(), microphone=(), display-capture=(), geolocation=()
    Content-Security-Policy: default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; img-src 'self'; font-src 'self'; connect-src 'self' ws://HOST wss://HOST; worker-src 'self'; media-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'

The policy is on every file, not only on HTML, because a dedicated worker loaded from a URL takes
its policy from its own script response, not from the document that started it, and the client's
worker holds its keys and does its network calls. web-1 grants no camera, microphone, screen
capture, `blob:` image or media source; the changes that need them widen these two headers with
their own row in `07`. `HOST` is the request's `Host` header when it is a host name or IPv4 address
of at most 253 characters, or a bracketed IPv6 literal, either with an optional port; for any other
`Host` the two `ws` sources are left out. The client's own `404` and `405` answers carry only
`X-Content-Type-Options: nosniff` from Go's `http.Error`; they carry no CSP, ETag, Cache-Control or
policy headers. No `Strict-Transport-Security`, `Cross-Origin-Opener-Policy`,
`Cross-Origin-Embedder-Policy` or `Access-Control-*` header is sent: TLS termination and HSTS belong
to the operator's proxy, and the client needs no cross-origin isolation. Behind a proxy that
rewrites `Host`, the CSP names the rewritten host and the browser refuses the gateway connection;
such a proxy must forward the original `Host`.

**The content manifest.** The root of the tree holds `dilla-manifest.json`, one JSON object on one
line followed by a newline:

    {"v":1,"files":[{"path":"assets/index-AbC123.js","sha256":"<64 lowercase hex>","size":12345},{"path":"index.html","sha256":"…","size":678}]}

`files` lists every regular file of the tree except the manifest itself, by its `/`-separated path
relative to the root, in strictly ascending byte order of `path`, with the SHA-256 of its bytes as
64 lowercase hex digits and its length in bytes. The instance verifies the tree against it when it
starts and refuses to start when `v` is not `1`, when an entry is malformed or out of order, when
`index.html` is not listed, when a listed file is missing, differs in size or digest, or is not a
regular file, or when a file is present that is not listed; it then serves only the bytes it
verified. The manifest is the per-file integrity record a later client-side or third-party check
can be built on; it is not itself served.

**The invite landing page.** The invite landing page (`GET /i/{code}`, `text/html`) links to
`/welcome?invite=<code>` on its own origin; the client prefills its invite field from it.

## Flags

`users.flags` is a bitfield. Two bits are assigned at `wire_version = 1`:

| bit | meaning |
|---|---|
| 0 | instance admin |
| 1 | bot operator |

Every other bit is reserved, MUST be written as 0 and MUST be ignored on read.
