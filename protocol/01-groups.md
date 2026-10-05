# 01 — Groups

## Group kinds

Every end-to-end encrypted conversation or session is one MLS group. There are four kinds:

| kind | value | one per | members (leaves) | external sender |
|---|---|---|---|---|
| `text` | 0 | e2ee text channel, DM or group DM | every device of every member | the instance |
| `call` | 1 | voice session in a voice channel, DM call or group-DM call | every device present in the call | the instance |
| `pairing` | 2 | device enrolment | exactly two leaves: the authorising device and the new device | none |
| `interaction` | 3 | (user, bot) pair | every device of the user plus the bot's device(s) | none |

A `readable` text channel has no group. A call in any voice channel, including a voice channel of
a community whose text channels are `readable`, always has a `call` group: calls are always
end-to-end encrypted.

The instance keeps a `call` group to the devices present in the call. A device that stays out of
the call's room while it holds a leaf — its leave report lost, or disconnected by the instance and
that report lost — loses the leaf: when two room sweeps at least one sweep period apart find the
same leaf, taken in the same epoch, with its device out of the room, and the device was not admitted
to the room in the last 30 seconds, the instance proposes a DS `Remove` of that leaf bound to that
membership, so a device that has rejoined the group since is never removed (`09` § Voice, Leaving).

Groups use MLS ciphersuite `0x0001`. Handshake messages (Proposal, Commit) are sent as
`PublicMessage`; application data as `PrivateMessage`. Application data MUST be padded so that the
`PrivateMessage` ciphertext length is a multiple of 256 bytes (RFC 9420 §6.3.1 padding field).

Group configuration:

- `use_ratchet_tree_extension`: off. The DS serves the ratchet tree (`02-delivery-service.md`).
- `required_capabilities`: extension types `[0xF001]`; proposal types `[]`; credential types
  `[basic]`. `external_senders` is not listed in `extension_types` because RFC 9420 §7.2 forbids
  listing default extension types in `required_capabilities`.
- Past epoch secrets: a client keeps the message secrets of past epochs for 300 seconds in `text`
  groups, 10 seconds in `call` groups, and 0 seconds in `pairing` and `interaction` groups, then
  deletes them.

## dilla_binding

Every group carries a GroupContext extension of type `0xF001` (RFC 9420 private-use range) named
`dilla_binding`. Its `extension_data` is the deterministic CBOR encoding of:

```
[
  v,               ; uint, = 1
  instance_id,     ; bstr, 16 bytes
  community_id,    ; bstr, 16 bytes, or null for DMs, group DMs, pairing and interaction groups
  target_id,       ; bstr, 16 bytes: channel_id for text and call groups in a community;
                   ;   dm_id for DMs and their calls; the new device_id for pairing;
                   ;   the bot's user_id for interaction groups
  kind,            ; uint, 0..3 as in the table above
  policy_version,  ; uint, the instance's policy version at group creation (see 02, invariant 1)
  e2ee_version,    ; uint, = 1
  media_version    ; uint, = 1 for call groups, 0 for the other kinds
]
```

Rules:

1. A client MUST reject a Welcome, GroupInfo, Proposal or Commit whose group's `dilla_binding`
   does not match the instance it is connected to (`instance_id`), the object it expects
   (`community_id`, `target_id`, `kind`), or a version it supports. Error code `E_BINDING`.
2. `dilla_binding` MUST be listed in `required_capabilities.extension_types`, so a leaf that does
   not understand it cannot be added.
3. The extension is immutable for the life of the group. A change requires a new group.

## External senders

`text` and `call` groups carry the instance signing key in the `external_senders` GroupContext
extension (RFC 9420 §12.1.8.1), with a `basic` credential whose identity is the CBOR array
`[v = 1, "instance", instance_id]`. `pairing` and `interaction` groups MUST NOT carry any external
sender; a client MUST reject a `pairing` or `interaction` GroupInfo or Welcome that has one
(`E_EXTERNAL_SENDER_FORBIDDEN`).

Client policy for proposals from the external sender:

| proposal | text / call | pairing / interaction |
|---|---|---|
| Add | accept if the credential passes `03-identity.md` checks and the user is eligible per the client's role snapshot | reject |
| Remove | accept | reject |
| GroupContextExtensions | accept only if the sole change is to `external_senders` and the new instance key is signed by the old one (`03-identity.md`, "Instance key rotation") | reject |
| ReInit, PreSharedKey, Update, any other | reject | reject |

Client policy for proposals from members:

- `Update`: accept only if its leaf node carries a credential byte-identical to the one the
  proposer's leaf holds before the commit; reject otherwise (`E_CREDENTIAL`). The same rule binds a
  member commit's UpdatePath: its leaf node keeps the committer's credential. It binds a resync
  too: an external commit that removes a leaf of the joiner's own device (the `device_id` its new
  leaf names) carries, in its UpdatePath leaf node, exactly the credential the removed leaf held.
  Once a leaf is in a group its credential — which binds the leaf to a `user_id` and a `device_id`
  (`03-identity.md`, "Credential") — is immutable, across a resync included; only a first join
  carries a new credential. The leaf's signature key
  may change under this rule; `03-identity.md`'s leaf checks govern it. A client refuses such a proposal before queueing it and such a commit before merging
  it; the DS refuses both (`02-delivery-service.md`, invariant 4).
- `Remove`: accept only if the target leaf belongs to the proposer's own user — the committer's for
  a `Remove` carried in the commit (device revocation), the proposing member's for a `Remove`
  proposal the commit references (a member leaving, below); reject otherwise
  (`E_MEMBER_REMOVE_FORBIDDEN`). Removing other users is the instance's job, bound to roles. A
  member's `Remove` never cancels or stands in for the instance's `Remove` of the same leaf while it
  is only proposed: a committer holding both commits the instance's. RFC 9420 allows one `Remove`
  per leaf in a commit, and OpenMLS commits the later of two queued for one leaf, so a client queues
  a member's `Remove` in front of an instance `Remove` of the same leaf it already holds, whatever
  order it received them in, and keeps both queued. A commit that applies the member's instead is
  still accepted: it removes the same device, and the DS counts the instance's `Remove` as
  satisfied (`02-delivery-service.md`, invariant 4).
- `Add`: accept only in `pairing` (first join of the second leaf) and `interaction` groups (the
  user's device adding the bot device or a new own device); reject in `text` and `call` groups.
- `GroupContextExtensions`, `ReInit`, `PreSharedKey`: reject.

External commits (RFC 9420 §12.4.3.2) are accepted in `text` and `call` groups for: joining a
community's channels, adding a new device of an existing member, joining a call, and resyncing.
The `Remove` proposal inside an external commit MUST target only a leaf with the joiner's own
`device_id`; otherwise the client rejects the commit (`E_EXTERNAL_COMMIT_REMOVE`).

## Joining

- An online device joins by **external commit** using the GroupInfo and ratchet tree served by
  the DS. The DS refuses external commits while a DS proposal is outstanding, except when no member
  device is online (`02-delivery-service.md`, invariant 5).
- An offline device is added by a **DS Add proposal** carrying one of the device's KeyPackages,
  committed by an online member. Each device keeps 32 ordinary KeyPackages plus 1 **last-resort**
  KeyPackage on the DS; a join that consumed the last-resort package MUST be followed by an
  `Update` from that device in its next commit opportunity.
- Creating a private channel, or granting a role that opens a channel to many members, is done by
  the DS issuing Add proposals in batches: the creator's device commits at most 256 Adds per
  commit, each producing one Welcome, until all eligible devices are members.
- A member leaves a channel or a call by a `Remove` **proposal** of its own leaf, which another
  member commits — a device cannot commit its own removal (RFC 9420 forbids a committer removing
  itself) — or is removed by the DS. A client leaving a call posts that proposal before it
  disconnects from the SFU. A member proposal never cancels, voids, blocks or replaces a DS
  proposal: when the DS is already removing the leaf (a kick, a ban, an eviction) it refuses the
  member's own `Remove` with `409 E_REMOVE_PENDING`, which the client reads as "I am being removed"
  and answers by withdrawing its refused proposal, without retrying (a client that re-uploads its
  own proposal, for instance after a lost answer, is answered as the first time — never with this
  code — and keeps its proposal);
  and the DS issues its own `Remove` of a leaf regardless of the member's own `Remove` of it
  (`02-delivery-service.md`, invariant 6).

## Cadence

- **Update cadence (post-compromise security):** a device in a `text` group sends an `Update`
  proposal at most every `24h × max(1, ceil(leaves / 64))` and only if it has sent at least one
  application message since its last `Update`. In `call` groups a device rotates its leaf at least
  every 60 minutes, by an empty commit with an UpdatePath or an `Update` proposal another member
  commits; this is a client obligation the DS does not check. The DS never commits: it elects one
  committer per round for its own proposals (02, invariant 7).
- **Inactivity:** a device that has not connected for **90 days** is removed from every group by a
  DS `Remove` proposal (founder decision 2026-09-23). It rejoins by external commit.
- **Quarantined and revoked devices:** the leaf of a device that is quarantined (`02` invariant 9)
  or revoked is removed from every `text` and `call` group (DMs included) by a DS `Remove`, which
  the instance's periodic reconcile proposes again for as long as the device holds a leaf there
  with no DS `Remove` of it outstanding (`02` invariants 9 and 11). Each such `Remove` freezes its
  group until a member commits it, so a revocation is followed by a membership commit in every
  group the device was in. `pairing` and `interaction` groups carry no external sender: there a
  member removes a revoked device of its own user itself (§ External senders, member `Remove`s).
- **Epoch rotation on membership change:** every Add or Remove is a new epoch; senders MUST NOT
  send application data in an epoch whose commit they have not processed.

## Error codes

`E_BINDING`, `E_EXTERNAL_SENDER_FORBIDDEN`, `E_MEMBER_REMOVE_FORBIDDEN`, `E_EXTERNAL_COMMIT_REMOVE`,
`E_UNSUPPORTED_VERSION`, `E_UNSUPPORTED_SUITE`. Codes are stable strings; clients MAY show them in
diagnostics.
