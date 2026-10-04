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
| `GET /v1/channels/{id}` | — | `[channel_id, community_id(bstr16\|null), kind, mode, visibility, parent_id(bstr16\|null), name, topic, position, slowmode_seconds, seq]` |
| `GET /v1/communities/{id}/channels` | — | `200 [[channel_id, kind, mode, visibility, parent_id(bstr16\|null), name, topic, position, slowmode_seconds, seq]]`: the live channels the caller may view (`view_channel`, overwrites applied) by `position` then `channel_id`; a category is listed when it or one of its children is visible; `404` for a non-member |
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
| `POST /v1/channels/{id}/calls` | `[]` or `[vdec(tstr)]` | `201 [call_id(bstr16), group_id(bstr16), livekit_url(tstr), token(tstr), ice_servers([[urls([tstr]), username(tstr), credential(tstr)]]), caps([max_audio_bitrate_bps(uint), max_share_bitrate_bps(uint), vp9(uint)])]` when the call is opened, `200` with the same body when it is already live; `409 E_CALL_FULL` | `connect`, and a current leaf of the call group |
| `POST /v1/calls/{call_id}/share` | `[]` | `204` once the device holds a sharing slot and the SFU holds its new permission; `409 E_CALL_SHARERS_FULL`; `404 E_NOT_FOUND` when the call has ended or the device is not in its room; `403 E_FORBIDDEN` while the device's removal or demotion in the call is pending or the device is barred | `connect`, `video` or `screen_share`, and a current leaf of the call's group |
| `DELETE /v1/calls/{call_id}/share` | — | `204`, also when the device held no slot or the call has ended | `view_channel` |
| `DELETE /v1/calls/{call_id}` | — | `204`, also when the call has already ended | `view_channel` and `connect`, and a current leaf of the call's group |

- **The leaf gate.** A token is minted only for a device whose leaf is in the call group's
  **current epoch**: added at or before it and not removed. Any other device — a removed one, one
  whose leaf the instance records only from a later epoch, one with no leaf, or any device while
  the group is epoch-unknown after a restore — is `403 E_LEAF_NOT_CURRENT`, so a device that
  cannot derive the call's media keys cannot join its room either. A channel of another kind is
  `400 E_INVALID_REQUEST`; a voice channel whose call group is not registered yet is
  `404 E_NOT_FOUND`. While a call is live, "the call group" is the one the call was opened on,
  never merely the newest open call group of the channel: a leaf of any other call group is
  `403 E_LEAF_NOT_CURRENT` for that call. A live call whose group has been closed ends at the next
  start that passes the gate, which opens a fresh call on the channel's current call group.
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
  in-process SFU, which listens only on `livekit.bind_address`. Every start opens the call's room in
  the SFU first and the SFU never opens one on a join, so a token for a room the instance has closed
  is refused by the SFU (HTTP 404). A call gets a fresh room each time it is opened, so a device of
  the previous call cannot remain in the next one. `caps` is what the client applies to its publish
  options: `livekit.max_audio_bitrate_kbps` and `livekit.max_share_bitrate_kbps` in bits per second,
  and `vp9` 1 when `livekit.vp9` is on, else 0. An instance that runs no SFU (`livekit.enabled =
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
  into a later call. A device that stops its last camera or screen track, or leaves the room, without
  `DELETE …/share` keeps its slot until one of those happens; freeing it on the SFU's own track and
  departure events is a later change. A permission change during a call is pushed to the SFU at once.
- **Losing access.** A device is **barred** from every call when the device is revoked or
  quarantined (`02` invariant 9) or its user is disabled or deleted: a start answers it
  `403 E_FORBIDDEN` and mints nothing, a share answers `403 E_FORBIDDEN`, and the signalling proxy
  refuses it. A device that is barred, or whose user loses `view_channel` or `connect` in the
  channel, is disconnected from the call's room with every `"<device>#…"` participant of it, before
  the call group's `Remove` of its leaf is committed, and its sharing slot is freed. That happens
  **at once**, within the request that made the change, for a role or overwrite change, a kick, a
  leave, a ban, a group-DM removal and a channel's visibility change. A device revocation through
  `DELETE /v1/devices/{id}` or an account deletion, a user disable through the admin route, and a
  fork quarantine **queue** the cut at once, without waiting on the SFU, and the instance's
  background loop, woken by the request, makes it immediately after on its own (within its next
  pass); the device is refused everywhere meanwhile, since it is barred. A queue that is full leaves
  the cut to the room sweep. A change written to the database by another process — `dillad admin user
  disable` or `delete`, an admin device revoke — and a device admitted by the signalling proxy just
  before it lost access are caught by the **room sweep**: at most every 30 seconds the instance
  lists its SFU's rooms and, for each live call's room, applies the same rule to every participant,
  so such a device is disconnected within about 30 seconds (one sweep pass covers at most 64 rooms;
  a larger instance takes one pass per 64 rooms). The sweep also closes every room that belongs to no
  live call — a room whose close failed when its call ended, an older room of a call, a name that is
  no call's. When the instance cannot resolve a participant's permissions or state, it takes every
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
  `400 E_INVALID_REQUEST`. The paths are metered per client address on the `unauth` bucket of
  `[limits.rate]` (`429 E_RATE_LIMITED` with `retry_after_ms`). The instance removes a `publish`
  query parameter and the `CF-Connecting-IP` and `X-Real-IP` headers before the request reaches the
  SFU, and `X-Forwarded-For` carries only the client address the instance resolved.
- **Relays.** `ice_servers` is the `RTCIceServer` list for the client's peer connection: one entry
  when the instance runs its TURN relay, with a fresh ephemeral credential — `username` is
  `"<expiry>:<device_id>"` (unix seconds, `turn.credential_ttl` ahead) and `credential` is
  `base64(HMAC-SHA1(turn shared secret, username))`, the time-limited REST form TURN servers
  validate — and an empty array when it runs none. The relay is `turns:` on the instance's 443,
  where the instance tells a STUN stream from HTTP by its first bytes after the TLS handshake; in
  `behind_proxy` it is a separate operator-configured TCP port, and without one the list is empty
  and the client's "relay unavailable" dialog applies: the call is direct UDP or nothing. That
  relay is plain `turn:` on the listen port, because the instance terminates no TLS for it there
  (a recorded deviation from the spec, plan dillad-2 **D25**): its credential username and
  allocation traffic cross the network in cleartext unless a TLS front the operator runs carries
  it, while the media itself stays DTLS-SRTP with SFrame. When `turn.public_url` is set, in any
  mode, it is the one URL in `urls`, verbatim — for a proxy that terminates TLS for the relay
  (`turns:`) or publishes it on another port. At most
  `turn.allocations_per_device` relay allocations are live per device (default 2); another is
  refused with STUN error 486 until one ends. The relay reaches only the instance's own SFU (its
  `livekit.node_ip`, and with `livekit.advertise_internal_ip` the host's interface addresses LiveKit
  also offers): a `CreatePermission` or `ChannelBind` for any other peer is refused with STUN
  error 403, and with LiveKit off every one is. The filter is by IP address only: every port of an
  admitted address stays reachable through the relay, the SFU's own and any other service bound on
  those addresses, including `127.0.0.1` when `livekit.node_ip` is unset.
- **Ending.** `DELETE` ends the call for everyone and is kept to its participants. A restore ends
  every live call (`02` invariant 11).

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
  detail(tstr), fix(tstr)]]`, the `dillad doctor` legs the running instance can answer itself,
  under doctor's names and in doctor's order: `database` (the schema version), `data_dir` (its
  mode), `wasi` (the core the delivery service validates in), `udp` and `blobs` (every referenced
  file present, no stray files). `status` is 0 OK, 1 WARN, 2 FAIL; `fix` is the operator's next
  step or `""`. The legs that probe the network or need a process of their own — the config
  parse, the SQLite pragmas, clock skew, the certificate and a TURN allocation — are only
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

## Flags

`users.flags` is a bitfield. Two bits are assigned at `wire_version = 1`:

| bit | meaning |
|---|---|
| 0 | instance admin |
| 1 | bot operator |

Every other bit is reserved, MUST be written as 0 and MUST be ignored on read.
