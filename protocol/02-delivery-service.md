# 02 — Delivery service

## Roles

The instance acts as the MLS Delivery Service (RFC 9750 §5) for every group it hosts:

1. **KeyPackage directory**: stores KeyPackages per device, serves one on request, consumes
   ordinary packages on use, never consumes the last-resort package.
2. **Sequencer**: accepts exactly one Commit per epoch per group and totally orders handshake and
   application messages per group (`seq`, a per-group unsigned counter starting at 1).
3. **GroupInfo and tree store**: keeps the latest committer-signed GroupInfo (without the ratchet
   tree) and the ratchet tree it maintains itself from the handshake stream.
4. **External sender**: issues Add and Remove proposals bound to the permission system, and
   `GroupContextExtensions` proposals only for its own key rotation.
5. **Structural validator**: maintains an MLS `PublicGroup` per group (the public state: tree,
   epoch, extensions, leaf credentials) and validates every Proposal, Commit and GroupInfo
   structurally before accepting it. It never holds a group secret and cannot decrypt.

## Device sessions

Every endpoint in this document requires a **device session**. A device session is issued to a
`(user_id, device_id)` pair only against a live proof of possession of that device's `DSK_priv`.

1. `POST /v1/devices/{device_id}/sessions/challenge` — no authentication. The instance answers
   `201 [nonce(bstr 32), expires(uint)]`. The nonce is 32 CSPRNG bytes, single use, 60-second TTL,
   held in memory, deleted on read. The answer is identical for an unknown `device_id`.
2. `POST /v1/devices/{device_id}/sessions` — body
   `[nonce(bstr 32), purpose(uint), sig(bstr 64), credential(bstr|null), login(bstr|null)]`, where

   ```
   sig = Ed25519(DSK_priv,
           "dilla session v1"    ; 16 bytes UTF-8
        || instance_id           ; 16 bytes
        || device_id             ; 16 bytes
        || nonce                 ; 32 bytes
        || purpose)              ; 1 byte: 0 session, 1 renew, 2 provisional
   ```

   The instance answers
   `201 [token(tstr), scope(uint), user_id(bstr 16), device_id(bstr 16), expires(uint), idle_expires(uint), generation(uint)]`.
3. The **token** is 32 bytes from the platform CSPRNG, base64url without padding, stored only as
   `SHA-256(token)`. It is sent as `Authorization: Bearer <token>` on HTTP and in the gateway's
   `IDENTIFY` frame. There is no cookie and therefore no CSRF surface on `/v1`.
4. **Scope** is `0 enrolled`, `1 pending`, `2 provisional`. `enrolled` reaches every endpoint
   subject to the ordinary ACL; `pending` reaches only the two own-backup reads of
   `06-backup-archive.md`; `provisional` reaches only KeyPackage publication for one `pairing`
   group and that group's Welcome and handshakes, and anything else is
   `E_PROVISIONAL_OUTSIDE_PAIRING`.
5. **Lifetime** is a sliding 30 days for `native` devices and 7 days with a 12-hour idle window for
   `browser` devices, renewed by `purpose = 1`. At most **8** live sessions exist per device; the
   oldest is evicted.
6. **Revocation.** Accepting a signed device list that revokes a device MUST delete that device's
   session rows and close its gateway connections in the same transaction. Setting
   `users.disabled_at` does the same for every device of that user.
7. The sole exception to the proof rule above is `POST /v1/accounts`, which creates the device and
   its first session in the same transaction: the device's key is the one being registered, so there
   is no prior key to prove possession of. Every later session for that device goes through the
   challenge.

Refusals: `401 E_UNAUTHENTICATED` for an absent, replayed or expired nonce, a bad signature, or an
unknown device; `403 E_FORBIDDEN` for a disabled account; `429 E_RATE_LIMITED` per source address
and per `device_id`.

## API

Every `/v1` request and response body is deterministic CBOR, a fixed-position array, served and
accepted as `Content-Type: application/cbor`; MLS objects are `bstr`. Path identifiers are 32
lowercase hex characters (`^[0-9a-f]{32}$`). All endpoints require a device session
(`§ Device sessions`).

| Method and path | Auth | Request | Response | Errors |
|---|---|---|---|---|
| `POST /v1/groups` | E | `[group_id(bstr16), binding(bstr), group_info(bstr), ratchet_tree(bstr)]` | `201 [group_id, next_seq]` | `E_BINDING_INVALID`, `E_MODE_READABLE`, `E_GROUP_EXISTS` |
| `GET /v1/groups/{id}/info` | E | — | `[epoch, group_info, tree_hash, next_seq]` | `E_NOT_FOUND` |
| `GET /v1/groups/{id}/tree` | E | — | `[epoch, ratchet_tree, tree_hash]` | `E_NOT_FOUND` |
| `GET /v1/groups/{id}/handshakes?from=&limit=` | E | — | `[[seq, epoch, kind, sender, blob]]` | `E_NOT_FOUND`, `E_PRUNED` |
| `POST /v1/groups/{id}/commit` | E | `[epoch, commit(bstr), group_info(bstr), welcomes([[device_id(bstr16), blob(bstr)]]), ratchet_tree(bstr\|null)]` | `[seq, epoch]` | `E_COMMIT_CONFLICT`, `E_COMMIT_REQUIRED`, `E_COMMIT_INVALID`, `E_LEAF_NOT_CURRENT`, `E_INVALID_REQUEST`, `E_RATE_LIMITED` |
| `POST /v1/groups/{id}/proposal` | E | `[epoch, proposal(bstr)]` | `[seq]` | `E_COMMIT_INVALID`, `E_FORBIDDEN` |
| `POST /v1/groups/{id}/message` | E | `[epoch, private_message(bstr)]` | `[seq, franking_tag(bstr32), recv_ts]` | `E_COMMIT_REQUIRED`, `E_LEAF_NOT_CURRENT`, `E_TOO_LARGE`, `E_COMMITMENT_INVALID` |
| `POST /v1/groups/{id}/resync` | E | `[external_commit(bstr), group_info(bstr)]` | `[seq, epoch]` | `E_COMMIT_INVALID`, `E_FORBIDDEN` (freeze-exempt, invariant 5) |
| `POST /v1/groups/{id}/fork-report` | E | `[epoch, seq, reason(tstr)]` | `202 []` | `E_NOT_FOUND` |
| `POST /v1/keypackages` | E or V | `[packages([bstr]), last_resort(bstr\|null)]` | `201 [count]` | `E_COMMIT_INVALID`, `E_TOO_LARGE` |
| `GET /v1/devices/{device_id}/keypackage` | E | — | `[blob, last_resort(uint), kp_ref(bstr)]` | `E_NOT_FOUND`, `E_RATE_LIMITED` |
| `GET /v1/groups/{id}/messages?from=&limit=` | E | — | `[[seq, epoch, uploader_device, blob\|null, commitment\|null, franking_tag, recv_ts, deleted(uint)]]` | `E_PRUNED` |
| `GET /v1/groups/{id}/heal` | E | — | `[epoch, next_seq, generation, need_from_seq]` | `E_NOT_FOUND` |
| `POST /v1/groups/{id}/heal` | E | `[group_info(bstr), tail([[seq,epoch,kind,sender,blob]]), ratchet_tree(bstr\|null)]` | `[epoch, next_seq]` | `E_COMMIT_INVALID`, `E_FORBIDDEN` |
| `GET /v1/welcomes?after=&limit=` | E or V | — | `[[welcome_id, group_id, epoch, commit_seq, blob, ratchet_tree, tree_hash]]` | — |
| `DELETE /v1/welcomes/{welcome_id}` | E or V | — | `204` | `E_NOT_FOUND` |
| `DELETE /v1/groups/{id}/messages/{seq}` | E | — | `204` | `E_NOT_UPLOADER`, `E_NOT_FOUND` |
| `POST /v1/groups/{id}/cursor` | E | `[last_seq, last_epoch]` | `204` | `E_NOT_FOUND` |
| `GET /v1/groups/{id}/proposals` | E | — | `[[ref, kind, target_leaf\|null, blob, void(uint)]]` | `E_NOT_FOUND` |

Two rules the table encodes: a Welcome is **fetched without being consumed** — the `DELETE` is what
marks it delivered, because `StagedWelcome::new_from_welcome` consumes the key material even when
the client then fails — and the Welcome response carries the ratchet tree **as of the welcoming
epoch**, because dilla Welcomes carry no tree and the live tree has moved on.

A commit's `welcomes` are addressed: each `device_id` must be a device the commit's own applied Add
proposals add, and a commit that addresses a Welcome to any other device is refused with
`E_COMMIT_INVALID` and `rule = "welcome_addressee"` — otherwise any committer could queue opaque
blobs to arbitrary devices, telling each the id and epoch of a group it was never added to. A commit
carries at most 256 Welcomes (`01`'s `MAX_ADDS`); more is `E_INVALID_REQUEST`. The instance answers
membership and the epoch from the path, the session and the head of the body before it reads the
rest, and a device has one commit upload in flight at a time (`E_RATE_LIMITED` for a second).

`commitment` in the `GET /v1/groups/{id}/messages` items is the stored value of `C`, read by the DS
from `private_message.authenticated_data` at upload time; it is not a separate client-supplied
field.

`GET /v1/instance` and `GET /v1/instance/limits` are dillad's own surface, not the delivery
service's — `02` freezes with "DS API v1" at the end of W5 while the instance document must stay
editable — and are defined in `protocol/09-http-api.md`'s `## Instance` section instead.

## Gateway frames

Every frame is the deterministic-CBOR fixed-position array

```
frame = [ op, n, group_id, payload ]
  op       ; uint, the opcode below. The dotted names are documentation labels only.
  n        ; uint. S→C: the per-session replay sequence, starting at 1; 0 means the frame is
           ;   not replayable. C→S: the client's correlation id, echoed in ERROR; 0 = no reply.
  group_id ; bstr 16, or null when the frame is not group-scoped.
  payload  ; array, fixed positions, shape determined by op.
```

Two counters exist and are never conflated: the per-group delivery-service **`seq`**, which is
durable and appears inside payloads, and the per-session replay **`n`**, which lives only in memory
and only in element 1.

### Control (0–15) — `group_id = null`, `n = 0`

Two exceptions to the heading, and only two. `ready` (3) and `resumed` (4) are replayable and
carry `n ≠ 0`: a resumed connection whose `resumed` frame was dropped has no record of the replay
window it was given, and `ready`'s per-group digest is what a client with a refused resume heals
from. `commit_ack` (12) is group-scoped and carries a `group_id`; it is the one client opcode that
does.

| op | label | dir | payload |
|---|---|---|---|
| 0 | `hello` | S→C | `[wire_versions([uint]), e2ee_versions([uint]), media_versions([uint]), heartbeat_ms(uint), max_frame_bytes(uint), instance_id(bstr 16), generation(uint), backoff_ms(uint), backoff_jitter_ms(uint)]` — the last two are invariant 7's back-off window: a device that is not sent `mls.commit_needed` waits `backoff_ms + random(0..backoff_jitter_ms)` before volunteering a commit |
| 1 | `identify` | C→S | `[session_token(tstr), wire_version(uint), e2ee_version(uint), media_version(uint), caps(uint)]` |
| 2 | `resume` | C→S | `[session_token(tstr), resume_token(bstr 32), generation(uint), last_n(uint)]` |
| 3 | `ready` | S→C | `[device_id(bstr 16), user_id(bstr 16), generation(uint), resume_token(bstr 32), wire_version(uint), e2ee_version(uint), media_version(uint), keypackages_remaining(uint), groups([[group_id(bstr 16), epoch(uint), last_seq(uint), proposals_outstanding(uint)]])]` |
| 4 | `resumed` | S→C | `[replayed_from(uint), replayed_to(uint), resume_token(bstr 32)]` — the token rotates on every `resumed`, so the frame that announces a resume also issues the credential for the next one; a client that keeps the token from `ready` after resuming is refused |
| 5 | `invalid_session` | S→C | `[resumable(uint), reason(tstr)]` |
| 6 | `heartbeat` | C→S | `[last_n(uint), active(uint)]` |
| 7 | `heartbeat_ack` | S→C | `[server_ts(uint)]` |
| 8 | `reconnect` | S→C | `[reason(tstr), after_ms(uint)]` |
| 9 | `error` | S→C | `[cid(uint), code(tstr), detail(tstr)]` |
| 10 | `subscribe` | C→S | `[group_ids([bstr 16])]` |
| 11 | `unsubscribe` | C→S | `[group_ids([bstr 16])]` |
| 12 | `commit_ack` | C→S | `[round(uint)]`, `group_id` set — the acknowledgement invariant 7 counts lost rounds against |

### Delivery service (16–31) — `group_id` set

| op | label | `n` | payload |
|---|---|---|---|
| 16 | `mls.handshake` | ≠ 0 | `[seq(uint), epoch(uint), kind(uint), sender(uint\|null), blob(bstr)]` |
| 17 | `mls.commit_needed` | 0 | `[epoch(uint), proposal_refs([bstr]), deadline_ms(uint), round(uint)]` |
| 18 | `mls.epoch_changed` | ≠ 0 | `[epoch(uint), seq(uint)]` |
| 19 | `message.ct` | ≠ 0 | `[seq(uint), epoch(uint), uploader_device(bstr 16), blob(bstr), franking_tag(bstr 32), recv_ts(uint)]` |
| 20 | `mls.welcome` | ≠ 0 | `[welcome_id(uint), epoch(uint), commit_seq(uint), blob(bstr), ratchet_tree(bstr), tree_hash(bstr 32)]` |
| 21 | `message.deleted` | ≠ 0 | `[seq(uint), deleted_at(uint)]` |

`mls.commit_needed` carries `deadline_ms` **relative to the moment the frame is handed to the
connection's writer**; the instance re-bases it at that moment and the client starts its timer on
receipt. It is `n = 0` and therefore never replayed: an election that was decided while the client
was away is stale by definition, and the instance re-elects.

`message.ct` is fanned out to **every** member device including the uploader's, so the per-group
`seq` stream is dense on every device.

`mls.welcome` is a convenience, not the delivery: every Welcome is durably queued and served by
`GET /v1/welcomes`. The instance sends the frame only when the Welcome blob and the welcoming
epoch's ratchet tree fit the `max_frame_bytes` it advertised in `hello` — a frame above it would
close the joiner's connection rather than reach it, and a real group's tree (620 KiB at 1,500
leaves) routinely does not fit. When no `mls.welcome` arrives, a device that expects to be added —
it published KeyPackages, or it is completing a pairing — polls `GET /v1/welcomes`, whose items carry
the same tree.

### Non-E2EE and interactions (32–47) — `n ≠ 0`

| op | label | payload |
|---|---|---|
| 32 | `message.plain` | `[channel_id(bstr 16), seq(uint), sender(bstr 16), envelope(bstr), franking_tag(bstr 32), edited(uint), deleted(uint)]` |
| 33 | `interaction` | `[interaction_id(bstr 16), bot_user_id(bstr 16), kind(uint), blob(bstr)]` |

### Ephemeral (48–63) — `n = 0`, never replayed, never persisted

| op | label | payload |
|---|---|---|
| 48 | `presence` | `[user_id(bstr 16), status(uint), since_ts(uint), status_msg(tstr)]` |
| 49 | `typing` | `[user_id(bstr 16), device_id(bstr 16), typing(uint), expires_ts(uint)]` |
| 50 | `voice_state` | `[user_id(bstr 16), device_id(bstr 16), call_id(bstr 16), flags(uint)]` |

Opcodes 64–127 are reserved for future `wire_version`s; 128 and above are never used. An opcode
outside the negotiated `wire_version` is a hard error (`E_FRAME_TYPE`), never ignored. A frame of
the wrong element count for its opcode is `E_FRAME_SHAPE`; a frame that fails the deterministic
decoder is `E_FRAME_CBOR`; a frame over `max_frame_bytes` is `E_FRAME_LIMIT`. A client frame whose
opcode is not group-scoped but that carries a non-null `group_id` is `E_FRAME_SHAPE`, and so is a
group-scoped client frame whose `group_id` is null — the second rule is what stops `commit_ack`
being silently dropped rather than refused.

### Close codes (RFC 6455 private range)

| code | name | resumable |
|---|---|---|
| 4000 | `unknown_error` | yes |
| 4001 | `not_identified` | no |
| 4002 | `decode_error` | no |
| 4003 | `unauthenticated` | no |
| 4004 | `session_revoked` | no |
| 4006 | `version_unsupported` | no |
| 4007 | `invalid_n` | no |
| 4008 | `rate_limited` | yes |
| 4009 | `session_timeout` | no |
| 4010 | `going_away` | yes |

A structured failure is sent as an `error` frame **before** the close, because the close reason is
capped at 123 bytes.

### Handshake records

`kind` is a uint with exactly three values: **0 proposal, 1 commit, 2 external_commit**. A Welcome
is not a handshake — it has its own wire format, its own frame and its own endpoints.

`sender` is the **leaf index** (uint) of the sending member, or **null** when the sender is the
instance's external sender. An instance additionally records the sending `device_id` beside the
handshake, resolved through its own member table; that record is not on the wire.

## Invariants

Each invariant has a chaos scenario in `dilla-testkit` named after it.

1. **Registration.** A group is registered with its `dilla_binding`. The DS refuses a `text` group
   for a channel whose visibility is `invite` or `discoverable`, or whose mode is `readable`
   (`403 E_MODE_READABLE`). `call` groups exist for every voice session regardless of the channel's
   text mode.
2. **Tree service.** The DS keeps a `PublicGroup` per group. Committers upload a GroupInfo
   **without** the ratchet tree; the DS serves the tree from its own `PublicGroup`, and a joiner
   MUST verify `tree_hash` in the GroupInfo against the served tree before joining.
3. **One commit per epoch.** The first valid Commit for epoch `n` wins; a later one for the same
   epoch gets `409 E_COMMIT_CONFLICT` with the winning commit and the current outstanding proposals.
4. **Commit validity.** A Commit is accepted only if: it is signed by a current leaf or is a valid
   external commit; it references every outstanding non-void DS proposal (invariant 6); it
   contains no `Update` from the committer; every member-originated `Remove` targets the
   committer's own user; every `Add` carries a credential whose user is eligible under the channel's
   ACL and whose DSK is in the newest signed device list the DS holds; the `PublicGroup` validates
   it structurally; and the uploaded GroupInfo's epoch is `n + 1`. Otherwise `422 E_COMMIT_INVALID`.
5. **Freeze.** While any DS proposal is outstanding for a group, application messages get
   `425 E_COMMIT_REQUIRED`, and external commits get `425 E_COMMIT_REQUIRED` too — **unless no member
   device is online**, in which case the external commit is accepted, the outstanding proposals are
   re-issued for the new epoch, and `mls.commit_needed` goes to the joiner. After any commit that
   omitted DS proposals (only possible via this exception), non-void ones are re-issued and the
   freeze stays. `POST /v1/groups/{id}/resync` is exempt from this freeze: an own-leaf external
   commit is how a device that has fallen out of the epoch returns, and making it wait on a
   membership commit deadlocks exactly the device that cannot act. Two guards apply: the resync is
   refused with `E_FORBIDDEN` when the resyncing device is the target of an outstanding non-void
   instance Remove, and the instance re-issues its outstanding proposals for the new epoch
   immediately afterwards. `POST /v1/groups/{id}/resync` from a device that holds **no** leaf in the
   group is not a resync but a join (`01-groups.md`, "Joining"): it is gated by the channel ACL
   (`E_NOT_FOUND` to a device the ACL does not admit, as every read answers it), it is held by the
   freeze above, and the joiner's leaf must be its own device with its DSK in its user's newest
   signed device list (invariant 4's Add clause). A device the ACL admits may read
   `GET /v1/groups/{id}/info` and `/tree` to build that external commit.
6. **Void.** Before proposing, the DS validates a KeyPackage (lifetime not expired, capabilities
   include `0xF001`, not consumed) and a Remove target (leaf still present). A DS proposal older
   than its TTL — 30 seconds in `call` groups, 24 hours in `text` groups — is marked **void**; a
   Commit MAY omit void proposals. The underlying action is retried with a fresh KeyPackage, or
   dropped if the target leaf is already gone. When every instance proposal of a group has gone
   void, the freeze lifts even if no member device is online. A device is **online** while it holds
   a gateway connection in state `ready` whose last liveness mark — `ready`, `resumed` or a
   `heartbeat` frame — is newer than the instance's `session_idle_close` window (default 90 s, with
   clients beating every 30 s). A device whose only session is inside the resume grace window has no
   connection and is therefore not online.
7. **Committer election.** `mls.commit_needed` goes to the lowest-index online device, bot devices
   first; other devices back off `300 ms + random(0..300 ms)`; a 2-second watchdog nudges the next
   candidate; after three lost rounds the failing device is removed by a DS Remove. A lost round
   counts against a device only if that device acknowledged the task — the frame reaching the
   connection's writer is not an acknowledgement. The acknowledgement is the `commit_ack` frame
   (opcode 12), group-scoped, whose payload echoes the `round` of the `mls.commit_needed` it
   answers. Three acknowledged-and-lost rounds remove the device; unacknowledged rounds only
   advance the election.
8. **Current-leaf sends.** Application messages are accepted only from a device session whose
   leaf is in the current `PublicGroup` (`403 E_LEAF_NOT_CURRENT`). The DS reads the franking
   commitment `C` from `private_message.authenticated_data` and MUST reject an upload whose
   `authenticated_data` is not exactly 32 bytes (`422 E_COMMITMENT_INVALID`); it then computes and
   stores the franking tag `T` over that value (`04-envelope-and-franking.md`, "Franking").
9. **Fork handling.** A member that cannot process an accepted Commit reports it
   (`POST /fork-report`) and resyncs to the DS head by external commit. Three distinct reports
   against one Commit quarantine the committer: DS Remove of its leaf and a flag on the device.
10. **Retention.** Handshakes are kept 30 days. Retention has two independent halves. **Delivery
    retention** is how long the instance keeps an object so that a device that was away can still
    fetch it: handshakes 30 days; application ciphertext until every member device's cursor has
    passed it or 30 days, whichever comes first; Welcomes 30 days; KeyPackages until consumed or
    until their MLS lifetime expires. **Archival retention** is the community's own policy for
    application ciphertext that every cursor has already passed (default: indefinite), recorded per
    message in `expires`, where an absent value means "retained". An instance MAY shorten either
    half per community policy; it MUST NOT lengthen the handshake window beyond 30 days without also
    lengthening client-side past-epoch retention, which this version does not allow. Cursors are per
    device.
11. **Restore.** `dillad restore` bumps the instance `generation`; every group becomes
    epoch-unknown and every response carries the new generation. A member heals a group by
    `POST /v1/groups/{id}/heal`, uploading its member-signed GroupInfo together with its handshake
    tail (at most **64** items). The instance rebuilds its `PublicGroup` from its own restored
    state blob and replays the tail through it; it adopts the result only when its own stored epoch
    is **≤** the uploaded GroupInfo's epoch, the tail replays cleanly, and the GroupInfo's
    `tree_hash` equals the rebuilt tree's. When the instance holds no usable state blob for the
    group, the healing member additionally uploads the ratchet tree in the same request — the one
    upload where the tree is allowed, because the instance has none — and the instance reseeds from
    it; RFC 9420 §12.4.3.3's signed `tree_hash` makes that source safe. If no heal succeeds within
    24 hours the group is closed and re-created by the channel owner's device. All non-last-resort
    KeyPackages are purged on restore. Live calls end.

### Testkit scenario DSL

The chaos scenarios are `.scn` files in `testkit/scenarios/`: one statement per line, `#` comments.
They run against `dilla-testkit`'s in-memory delivery service, or against a running instance when
the file says `ds <url>` or the runner is given `--ds <url>` (which wins). This list is informative;
the parser in `testkit/src/scenario/parse.rs` is the reference.

Base vocabulary: `instance`, `client`, `sync`, `group`, `join`, `external_join`, `send`,
`expect_decrypts`, `remove`, `go_offline`, `go_online`, `expect_reject <code> <statement>`.

Added for the remote delivery service:

- `ds <url>` — run against the instance at `url`; only before the first `client`.
- `kick <actor> <target>` — the instance proposes removing `target`'s device on `actor`'s authority.
- `advance_clock <duration>` — move the instance clock by `30s`, `5m`, `24h` or `90d`.
- `expect_frame <op> [field=value …]` — the last client to act received that frame, by its label above.
- `expect_425 <statement>` — the statement is refused `425 E_COMMIT_REQUIRED`.
- `snapshot <name>` — the test host snapshots the instance's state under `name`.
- `restore_snapshot <name>` — the test host restores it, as `dillad restore` would.
- `commit <actor>` — the actor commits for the current epoch of every group it is in.
- `join_many <group> <count>` — `count` new clients join, at most 256 Adds per commit.
- `expect_decrypts_all <actor>` — everything the actor received since its last such assertion decrypts.
- `expect_quarantined <actor>` — the instance reports the actor's device quarantined (invariant 9).
- `expect_closed <group>` — the instance reports the group closed (invariant 11).
- `resync <client> <group>` — the client drops its copy of the group and returns by an own-leaf
  external commit (`POST /resync`, invariant 9).
- `fork_report <client> <group>` — the client reports the last commit it received for the group as
  one it cannot process (`POST /fork-report`, invariant 9).
- `heal <client> <group>` — the client uploads its GroupInfo and handshake tail to a restored
  instance (`POST /heal`, invariant 11).
- `ack_commit <client>` — the client acknowledges its latest `mls.commit_needed` with `commit_ack`
  and does nothing else (invariant 7).
- `admit <group> <client>` — the instance proposes adding the client's device (invariant 6).

Probes for invariants 1, 4 and 8, which break exactly one rule each:

- `expect_reject <code> rule=<rule> <statement>` — as `expect_reject`, and the `E_COMMIT_INVALID`
  must name that invariant-4 rule (`member_remove_scope`, `outstanding_proposals`,
  `external_joiner`, …).
- `client <name> device_list=none|revoked` — the client's user publishes no signed device list, or
  one whose entry for the device is revoked (default `signed`).
- `external_join <client> <group> [as=<uploader>] [leaf_key=fresh]` and
  `resync <client> <group> [as=<uploader>]` — the client's external commit is uploaded under the
  uploader's session, or its leaf carries a signature key that is not the device's DSK.
- `mark_revoked <client>` — the test host marks the device revoked in the store and leaves its
  session, the window a revocation can race.
- `send_bad_commitment <client> <group> <len>` — a message whose `authenticated_data` is `len`
  bytes rather than 32 (invariant 8).
- `channel <target> [visibility=private|invite|discoverable] [mode=e2ee|readable]` — the test host
  records the channel invariant 1 checks a `text` group against.

Against an instance, `join … via=welcome` is the protocol's own join: the instance proposes the Add
and a member commits it, because a member's own Add is refused by every receiver in a `text` or
`call` group (`01-groups.md`, "Client policy for proposals from members").

## Errors

Every `/v1` refusal is an HTTP status plus a body that is the deterministic-CBOR fixed-position
array

```
error = [
  code,            ; tstr, one of the codes below
  detail,          ; tstr, human text; may be empty; a client MUST NOT parse it
  retry_after_ms   ; uint or null; present only for E_RATE_LIMITED and E_COMMIT_REQUIRED
]
```

served as `Content-Type: application/cbor`. Codes are stable strings and are the only thing a
client switches on. Four refusals carry additional fixed-position elements appended after
`retry_after_ms`, and only those four:

```
E_COMMIT_CONFLICT : [code, detail, null, winning_commit(bstr), proposals([bstr])]
E_COMMIT_REQUIRED : [code, detail, retry_after_ms, proposals([bstr])]
E_COMMIT_INVALID  : [code, detail, null, rule(tstr)]
E_VERSION         : [code, detail, null, wire([uint]), e2ee([uint]), media([uint])]
```

| HTTP | code | meaning | client action |
|---|---|---|---|
| 400 | `E_INVALID_REQUEST` | malformed body, malformed identifier, wrong array length | do not retry unchanged |
| 400 | `E_BINDING_INVALID` | `dilla_binding` absent, wrong version, or not matching the object | do not retry |
| 400 | `E_VERSION` | no version in common; the extra elements list what the instance supports | reconnect with a supported version, or tell the user to update |
| 400 | `E_ENVELOPE_SHAPE` | the envelope is not a 9-element deterministic CBOR array, or a field has the wrong type or length | do not retry unchanged |
| 400 | `E_ENVELOPE_TYPE` | the type byte names no envelope type this version knows | do not retry unchanged |
| 400 | `E_ENVELOPE_LIMIT` | a field or list exceeds a `protocol/04` § Limits bound | shrink the field and resend |
| 401 | `E_UNAUTHENTICATED` | no device session, or an expired or revoked one | establish a session (`§ Device sessions`) |
| 403 | `E_FORBIDDEN` | the session is authenticated but not permitted | none |
| 403 | `E_CHANNEL_MODE` | the operation is not allowed for this channel's mode | use the surface the mode does allow |
| 403 | `E_LEAF_NOT_CURRENT` | the sending device's leaf is not in the current tree | resync by external commit; show "you are no longer a member" if refused |
| 403 | `E_MODE_READABLE` | text groups are not allowed for this channel | none; the channel is server-readable |
| 403 | `E_NOT_UPLOADER` | only the uploading user may delete this object | none |
| 403 | `E_PROVISIONAL_OUTSIDE_PAIRING` | a `provisional` session reached anything but its one `pairing` group | finish enrolment, then establish an `enrolled` session |
| 404 | `E_NOT_FOUND` | no such group, device, message or blob | none |
| 409 | `E_GROUP_EXISTS` | this `group_id` is already registered | mint a new `group_id` |
| 409 | `E_COMMIT_CONFLICT` | another commit won this epoch | discard the pending commit, process the winner, retry |
| 410 | `E_PRUNED` | retention has deleted a row of the requested stream at or above `from` (`from` is the first `seq` wanted; the instance records the highest deleted `seq` of each stream, so the answer is exact) | resync; mark older messages "undecryptable (too old)" |
| 410 | `E_INVITE_INVALID` | the invite is expired, exhausted or revoked | none |
| 413 | `E_TOO_LARGE` | the object exceeds the instance limit | split or attach |
| 422 | `E_COMMIT_INVALID` | structural or policy failure; `rule` names the clause | do not retry unchanged; resync if behind |
| 422 | `E_COMMITMENT_INVALID` | `private_message.authenticated_data` is not exactly 32 bytes | recompute `C` and resend |
| 425 | `E_COMMIT_REQUIRED` | outstanding DS proposals must be committed first | commit them (or wait for `mls.commit_needed`), then resend |
| 429 | `E_RATE_LIMITED` | a token bucket is empty | wait `retry_after_ms`; a `Retry-After` header in whole seconds carries the same value |
| 500 | `E_INTERNAL` | an unexpected server fault; the detail is always empty | retry with backoff |
| 507 | `E_STORAGE_FULL` | the instance or the user's quota is exhausted | none |

A **syntactically invalid** identifier in a path is `400 E_INVALID_REQUEST`; a syntactically valid
but unknown one is `404 E_NOT_FOUND`.

That is **25 rows**: this file's original eighteen plus `E_VERSION`, `E_PROVISIONAL_OUTSIDE_PAIRING`
and `E_INTERNAL` (deviation ID12), plus the four Plan 2 consumes — `E_ENVELOPE_SHAPE`,
`E_ENVELOPE_TYPE`, `E_ENVELOPE_LIMIT` and `E_CHANNEL_MODE` (deviation ID12 as amended; controller
ruling 2026-09-24). The first three are Plan 1a's own Go code — `server.CodeVersion`,
`Sessions.Middleware` and `WriteError`'s fallback — and `scripts/check-protocol-docs.mjs`'s
`checkErrorVocabulary` diffs this table against `internal/server/errors.go` in both directions, so
the three could not have been left out without CI failing.

The last four are declared **here**, in the one task that owns the vocabulary, even though their
only call sites are Plan 2's. The three `E_ENVELOPE_*` codes are 400 and mirror the Rust envelope
module's own codes and the `protocol/vectors/` reject corpus one-for-one: a server-readable
channel's instance **is** a receiver in `protocol/04`'s sense, so it refuses exactly what a client
refuses and a client switches on one vocabulary. `E_CHANNEL_MODE` is **403**, not 400 — the request
is well formed and the session is authenticated; the operation is simply not allowed for the
channel's mode (an earlier draft of Plan 2 gave it 400 in a table row and 403 at its call site; the
controller resolved it to 403). Declaring all four here is what keeps
`scripts/check-protocol-docs.mjs` green from Plan 1's first commit onward, because that script
diffs the table against `internal/server/errors.go` in both directions and a code in one and not
the other fails CI.

`E_TOO_LARGE` fires at **131072 bytes** of MLS ciphertext on `POST /v1/groups/{id}/message`. The
gateway's inbound read limit is **16384 bytes** (`gateway.read_limit_bytes`) because no inbound
frame carries ciphertext; the outbound `max_frame_bytes` advertised in `hello` is
`max_ciphertext_bytes + 512` = **131584**, and a client sets its own WebSocket read limit from it.

## Retention

Defaults: handshakes 30 days; application ciphertext per invariant 10; KeyPackages until consumed
or their MLS lifetime expires (clients set 90 days); GroupInfo latest only; `PublicGroup` state
current epoch only, with the last 64 handshakes retained for restore. Retention has two independent
halves. **Delivery retention** is how long the instance keeps an object so that a device that was
away can still fetch it: handshakes 30 days; application ciphertext until every member device's
cursor has passed it or 30 days, whichever comes first; Welcomes 30 days; KeyPackages until
consumed or until their MLS lifetime expires. **Archival retention** is the community's own policy
for application ciphertext that every cursor has already passed (default: indefinite), recorded per
message in `expires`, where an absent value means "retained". An instance MAY shorten either half
per community policy; it MUST NOT lengthen the handshake window beyond 30 days without also
lengthening client-side past-epoch retention, which this version does not allow.

Cursors: a device's cursor advances only on an **explicit client acknowledgement**, never on
fan-out — a frame put on a writer queue is not a delivery. The prune floor is the minimum cursor
over devices that are not revoked, not disabled and seen within the 90-day inactivity window; a
device outside that set does not hold the floor.
