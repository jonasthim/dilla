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

### Communities

Every route below is `E`. A community a caller is not a member of answers `404 E_NOT_FOUND`
exactly as an unknown one does, so a non-member does not learn that it exists; a soft-deleted
community answers `404` to everyone.

| Method and path | Request | Response |
|---|---|---|
| `POST /v1/communities` | `[name(tstr), policy(bstr), min_account_age_seconds(uint), require_mod_2fa(uint)]` | `201 [community_id(bstr16), role_everyone(bstr16), policy_version(uint)]` |
| `GET /v1/communities/{id}` | — | `[community_id, owner, name, policy, policy_version, min_account_age_seconds, require_mod_2fa, created]` |
| `PATCH /v1/communities/{id}` | `[name(tstr\|null), policy(bstr\|null), min_account_age_seconds(uint\|null), require_mod_2fa(uint\|null)]` | `[policy_version(uint)]` |
| `DELETE /v1/communities/{id}` | — | `204` |
| `GET /v1/communities/{id}/members?after=` | — | `[[user_id, joined, nick, [role_id]]]`, at most 200 per page, ordered by `user_id`; `after` is the last `user_id` of the previous page |
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

The **policy document** is a UTF-8 JSON object of at most 16 KiB. The instance stores the bytes the
owner sent and serves them back unchanged, but refuses (`400 E_INVALID_REQUEST`) a document that is
not one object, carries a key this table does not list, or has a value out of range. Every key is
optional; `{}` is every default.

| key | type | default | meaning |
|---|---|---|---|
| `join` | `"open"` or `"invite"` | `"open"` | whether a join needs a community invite |
| `screening` | bool | `false` | membership screening; stored and served, **not enforced** by this version |
| `retention_days` | uint ≤ 36500 | `0` | **archival** retention (`02` § Retention): days an application message every cursor has passed is kept; `0` keeps it indefinitely |
| `delivery_retention_days` | uint ≤ 30 | `0` | **delivery** retention: `0` is the instance's 30 days; a community may shorten it, never lengthen it |

### Channels

Every route below is `E`. A channel the caller may not view (§ Permissions: `view_channel` in that
channel, overwrites applied), a channel of a community the caller is not a member of included,
answers `404 E_NOT_FOUND` exactly as an unknown or deleted one does. Creating a channel needs
`manage_channels` community-wide; changing and deleting one need it in that channel
(`403 E_FORBIDDEN` otherwise).

| Method and path | Request | Response |
|---|---|---|
| `POST /v1/communities/{id}/channels` | `[kind(uint), mode(uint), visibility(uint), parent_id(bstr16\|null), name(tstr), topic(tstr), position(uint), slowmode_seconds(uint)]` | `201 [channel_id(bstr16), mode(uint), visibility(uint)]` |
| `GET /v1/channels/{id}` | — | `[channel_id, community_id(bstr16\|null), kind, mode, visibility, parent_id(bstr16\|null), name, topic, position, slowmode_seconds, seq]` |
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
  whatever its mode.
- A category is always top level. `parent_id` names a live category of the same community; a text
  or voice channel under a text channel, a nested category and a foreign or deleted parent are
  `400`. In a `PATCH`, null leaves the parent alone and the all-zero id moves the channel to the top
  level. Deleting a category moves its channels to the top level.
- `name` is 1–100 bytes and `topic` at most 1024 bytes of UTF-8, with no control character (a
  topic may carry line breaks and tabs). `position` is at most 2 147 483 647 and
  `slowmode_seconds` at most 21 600. A community's channels are ordered by `position`, ties broken
  by `channel_id` (bytewise), the same on every engine.
- `seq` is the channel's own sequence, which the server-readable message path advances.
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
  the caller does not hold is refused the same way. `403 E_FORBIDDEN`.
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
  `Remove` whose leaf is already gone is dropped (`02` invariant 6).
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
  proposes the `Add` of every other participant's devices (below), and a participant's own client
  may add them itself (`02` invariant 4).
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

## Flags

`users.flags` is a bitfield. Two bits are assigned at `wire_version = 1`:

| bit | meaning |
|---|---|
| 0 | instance admin |
| 1 | bot operator |

Every other bit is reserved, MUST be written as 0 and MUST be ignored on read.
