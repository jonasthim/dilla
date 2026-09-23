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

## API

HTTP endpoints are JSON unless stated; binary MLS objects are base64url strings in JSON and raw
bytes on the gateway. All endpoints require a device session (`03-identity.md`).

| Method and path | Body | Success | Errors |
|---|---|---|---|
| `POST /v1/groups` | `{binding, group_info, ratchet_tree}` from the creator | `201 {group_id, seq}` | `400 binding_invalid`, `403 mode_readable` (text group for a readable channel), `409 group_exists` |
| `GET /v1/groups/{id}/info` | — | `200 {epoch, group_info, tree_hash, seq}` | `404` |
| `GET /v1/groups/{id}/tree` | — | `200 {epoch, ratchet_tree, tree_hash}` | `404` |
| `GET /v1/groups/{id}/handshakes?from={seq}` | — | `200 {items:[{seq, epoch, kind, sender, blob}]}` | `404`, `410 pruned` |
| `POST /v1/groups/{id}/commit` | `{epoch, commit, group_info, welcomes:[{device_id, blob}]}` | `200 {seq, epoch}` | `409 commit_conflict {winning_commit, proposals}`, `425 commit_required {proposals}`, `422 commit_invalid {reason}`, `403 leaf_not_current` |
| `POST /v1/groups/{id}/proposal` | `{epoch, proposal}` (member Update or own-device Remove) | `200 {seq}` | `422`, `403` |
| `POST /v1/groups/{id}/message` | `{epoch, private_message, commitment}` (`commitment` = franking `C`, 32 bytes) | `200 {seq, franking_tag, recv_ts}` | `425 commit_required`, `403 leaf_not_current`, `413 too_large` |
| `POST /v1/groups/{id}/resync` | `{external_commit, group_info}` | `200 {seq, epoch}` | `425 commit_required`, `422` |
| `POST /v1/groups/{id}/fork-report` | `{epoch, seq, reason}` | `202` | — |
| `POST /v1/keypackages` | `{packages:[blob], last_resort: blob}` | `201 {count}` | `422` |
| `GET /v1/devices/{device_id}/keypackage` | — | `200 {blob, last_resort: bool}` | `404` |
| `GET /v1/groups/{id}/messages?from={seq}` | — | `200 {items:[{seq, epoch, uploader_device, blob, commitment, franking_tag, recv_ts}]}` | `410 pruned` |

Gateway frames (CBOR arrays `[type, group_id, payload]`):

- `mls.handshake` — `{seq, epoch, kind, sender, blob}`: a Proposal, Commit or external commit
  accepted by the DS, fanned out to every member device.
- `mls.commit_needed` — `{epoch, proposal_refs, deadline_ms}`: the DS asks one device to commit
  outstanding proposals (invariant 7).
- `mls.epoch_changed` — `{epoch, seq}`: informational, after a commit.
- `message.ct` — `{seq, epoch, uploader_device, blob, commitment, franking_tag, recv_ts}`.
- `mls.welcome` — `{group_id, blob}`: delivered to the device a Welcome is addressed to.

## Invariants

Each invariant has a chaos scenario in `dilla-testkit` named after it.

1. **Registration.** A group is registered with its `dilla_binding`. The DS refuses a `text` group
   for a channel whose mode is `readable` or whose visibility is `discoverable` (`403 mode_readable`).
   `call` groups exist for every voice session regardless of the channel's text mode.
2. **Tree service.** The DS keeps a `PublicGroup` per group. Committers upload a GroupInfo
   **without** the ratchet tree; the DS serves the tree from its own `PublicGroup`, and a joiner
   MUST verify `tree_hash` in the GroupInfo against the served tree before joining.
3. **One commit per epoch.** The first valid Commit for epoch `n` wins; a later one for the same
   epoch gets `409 commit_conflict` with the winning commit and the current outstanding proposals.
4. **Commit validity.** A Commit is accepted only if: it is signed by a current leaf or is a valid
   external commit; it references every outstanding non-void DS proposal (invariant 6); it
   contains no `Update` from the committer; every member-originated `Remove` targets the
   committer's own user; every `Add` carries a credential whose user is eligible under the channel's
   ACL and whose DSK is in the newest signed device list the DS holds; the `PublicGroup` validates
   it structurally; and the uploaded GroupInfo's epoch is `n + 1`. Otherwise `422 commit_invalid`.
5. **Freeze.** While any DS proposal is outstanding for a group, application messages get
   `425 commit_required`, and external commits get `425 commit_required` too — **unless no member
   device is online**, in which case the external commit is accepted, the outstanding proposals are
   re-issued for the new epoch, and `mls.commit_needed` goes to the joiner. After any commit that
   omitted DS proposals (only possible via this exception), non-void ones are re-issued and the
   freeze stays.
6. **Void.** Before proposing, the DS validates a KeyPackage (lifetime not expired, capabilities
   include `0xF001`, not consumed) and a Remove target (leaf still present). A DS proposal older
   than its TTL — 30 seconds in `call` groups, 24 hours in `text` groups — is marked **void**; a
   Commit MAY omit void proposals. The underlying action is retried with a fresh KeyPackage, or
   dropped if the target leaf is already gone.
7. **Committer election.** `mls.commit_needed` goes to the lowest-index online device, bot devices
   first; other devices back off `300 ms + random(0..300 ms)`; a 2-second watchdog nudges the next
   candidate; after three lost rounds the failing device is removed by a DS Remove.
8. **Current-leaf sends.** Application messages are accepted only from a device session whose
   leaf is in the current `PublicGroup` (`403 leaf_not_current`).
9. **Fork handling.** A member that cannot process an accepted Commit reports it
   (`POST /fork-report`) and resyncs to the DS head by external commit. Three distinct reports
   against one Commit quarantine the committer: DS Remove of its leaf and a flag on the device.
10. **Retention.** Handshakes are kept 30 days. Application ciphertext is kept until every member
    device's cursor has passed it, or 30 days, whichever is first. Cursors are per device.
11. **Restore.** `dillad restore` bumps the instance `generation`. Every group becomes
    epoch-unknown. The first member-signed GroupInfo with epoch ≥ the stored epoch, together with
    that member's handshake tail (clients keep the last 64 handshakes per group), is replayed
    through the `PublicGroup` and adopted. If none arrives within 24 hours the group is closed and
    re-created by the channel owner's device. All non-last-resort KeyPackages are purged on
    restore. Live calls end.

## Errors

| HTTP | code | meaning | client action |
|---|---|---|---|
| 409 | `commit_conflict` | another commit won this epoch | discard own pending commit, process the winning one, retry |
| 425 | `commit_required` | outstanding DS proposals must be committed first | commit them (or wait for `commit_needed`), then resend |
| 422 | `commit_invalid` | structural or policy failure, `reason` names the rule | do not retry unchanged; resync if the local state is behind |
| 403 | `leaf_not_current` | the sending device's leaf is not in the current tree | resync by external commit; show "you are no longer a member" if the resync is refused |
| 403 | `mode_readable` | text groups are not allowed for this channel | none; the channel is server-readable |
| 410 | `pruned` | requested `seq` is older than retention | resync by external commit; mark older messages "undecryptable (too old)" |
| 413 | `too_large` | ciphertext exceeds the instance limit (default 64 KiB) | split or attach |

## Retention

Defaults: handshakes 30 days; application ciphertext per invariant 10; KeyPackages until consumed
or their MLS lifetime expires (clients set 90 days); GroupInfo latest only; `PublicGroup` state
current epoch only, with the last 64 handshakes retained for restore. An instance MAY shorten
these for `text` groups per community policy; it MUST NOT lengthen the handshake window beyond 30
days without also lengthening client-side past-epoch retention, which this version does not allow.
