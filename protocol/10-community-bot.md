# 10 — Community bot

## Scope

Internal first-party bot contracts for wire 3. The `/v1` prefix is unchanged;
E2EE and media remain version 1. One independently signed native bot identity per
community, operated by a separate service. No public SDK or third-party bot
installation interface. This contract defines formats; implementation status is
tracked in the bot plan rather than inferred from this document.

## Encoding

Use the deterministic subset in `04`: uint64, bstr, tstr, arrays and null only,
minimal heads, definite lengths, no trailing bytes, at most eight nesting levels.
All identifiers in this document are nonzero bstr16, lowercase hex in URL paths.
Length limits are encoded bytes, not characters. Raw byte fields containing CBOR
are decoded separately under the same strict rules. Error responses expose stable
codes, never submitted messages, provider credentials or signing material.

## Application requests

A type-0 envelope body is `dilla.bot/1:` plus UNPADDED canonical base64url of
strict deterministic CBOR. Total UTF-8 body <=4000 bytes. Reject whitespace,
noncanonical encodings/pad bits, padding, bad prefix or binary. CBOR array:
`[1, request_id, community_id, channel_id|null, operation, revision|null, expires|null, args]`.
Request_id is also the stable mutation operation id. Context validation requires
an expected community id from the authenticated interaction binding, never the
payload itself. Actor comes ONLY from authenticated MLS sender; no actor field.

Operation, arguments, channel requirement, mutation:
- 0 overview.get: [], no channel, read
- 1 settings.get: [section 0..5], no channel, read
- 2 settings.put: [section 0..5, document bstr(1..2400)], no channel, mutation
- 10 music.state: [], channel required, read
- 11 music.search: [query tstr(1..200 UTF8 bytes)], channel required, read
- 12 music.enqueue: [input tstr(1..2048 UTF8 bytes)], channel required, mutation
- 13 music.pause: [], channel required, mutation
- 14 music.resume: [], channel required, mutation
- 15 music.skip: [], channel required, mutation
- 16 music.stop: [], channel required, mutation
- 17 music.seek: [position_ms uint], channel required, mutation
- 18 music.volume: [percent uint 0..100], channel required, mutation
- 19 music.shuffle: [], channel required, mutation
- 20 music.repeat: [mode uint 0..2], channel required, mutation
- 21 music.remove: [queue_item_id], channel required, mutation
- 22 music.move: [queue_item_id, before_item_id|null], channel required, mutation
- 23 music.clear: [], channel required, mutation
- 30 welcome.preview: [template tstr(1..2000 UTF8 bytes)], no channel, read
- 40 roles.list: [cursor uint], no channel, read (selections use human HTTP)
- 50 announcements.list: [cursor uint], no channel, read
- 51 announcements.put: [schedule_id|null, document bstr(1..2200)], no channel, mutation
- 52 announcements.delete: [schedule_id], no channel, mutation
- 60 moderation.cases: [cursor uint], no channel, read
- 61 moderation.evidence: [action_request_id, reason tstr(0..1024 UTF8 bytes), excerpt tstr(0..512 UTF8 bytes)], no channel, mutation

For no-channel operations channel MUST be null. For reads revision/expires MUST
be null. For mutations both MUST be uint; expiry must satisfy now < expires <=
now+30 (seconds), rejecting overflow; stale revisions are checked against current
state by dispatcher. Do not enforce deadline during a structural encode/decode:
provide explicit validate_context(expected_community, now) that checks it. Decode
must still enforce presence/types and args. Context mismatch/expiry refuse.
Document bstr payloads must themselves be deterministic CBOR arrays (not arbitrary
bytes); sections' actual fields are validated by feature dispatcher. They never
contain generic SQL or executable code. Reject empty/whitespace-only query/input;
control characters U+0000..001F and U+007F disallowed in those two inputs only.

Response CBOR (same body-prefix and encoded byte limit):
`[1, request_id, community_id, status uint0..9, revision|null, data bstr(0..2400)]`.
Nonempty data is strict deterministic CBOR array. Empty data allowed. status:
0 ok,1 invalid,2 forbidden,3 expired,4 conflict,5 unavailable,6 busy,7 not_found,
8 upgrade_required,9 internal. Validate expected community on response separately;
request correlation is caller's job. Pagination is by encoded body size.

## Signed moderation removal

Unsigned proof: `[1, request_id, actor_user, actor_device, community_id, group_id,
 target_seq uint>0, expires uint>0]`. Signature preimage is ASCII
`dilla moderation removal v1` (NO NUL) concatenated with canonical encoded proof.
Detached Ed25519 signature64; signer is registered device key. Core signs; server
checks current session user/device, matching community/group, hierarchy/permission,
and now < expires <= now+30 on new acceptance. Codec exposes preimage and context
validation; signature crypto functions can follow in native-helper/moderation tasks.
Accepted stored proofs remain evidence after expiry; decoding never applies time.

## Durable structural event

`[1, event_id, sequence uint>0, community_id, timestamp uint, kind uint1..7, data]`.
Data schemas (all arrays) by kind:
1 member_join [user_id, episode_id]
2 member_leave [user_id, episode_id]
3 installation [installation_id, state uint0..5, revision uint]
4 permission [target_kind uint0..3, target_id, revision uint]
5 channel [channel_id, change uint0..2, revision uint]
6 moderation [action_id, request_id, actor_user, actor_device, target_user|null,
 group_id|null, target_seq uint>0|null, action uint0..6, expires uint|null]
7 role_panel [panel_id, revision uint, active uint0..1]
State:0pending,1enrolling,2joining,3ready,4disabled,5error. Permission target:
0community,1channel,2role,3member. Channel change:0created,1updated,2deleted.
Moderation:0warn,1timeout,2kick,3ban,4remove,5clear_timeout,6unban. For remove,
group+target_seq required and target_user optional; other actions require target_user,
group+target_seq null. Timeout requires expires>timestamp; other actions expires
null except ban may have expires>timestamp. Identifiers and metadata only: no
message text, reasons, excerpts, names, URLs. Max encoded event4096 bytes.
Validate community separately against route/session binding. Stream retention30d;
ack semantics and pagination handled by API. Event id survives retries.

## Send receipt

`[1, operation_id, community_id, group_id, ciphertext_sha256 bstr32,
 status uint0..1, sequence uint>0|null, epoch uint|null]`.
0pending requires null sequence/epoch;1accepted requires both uint (seq>0).
Max512 bytes. Context validation requires expected community and group.
Caller installation/device is authenticated externally; receipt lookup scoped
accordingly. Retry uses same operation id; conflicting ciphertext hash refuses.
Resolve unknown outcome before encrypting again. Receipt is structural and never
contains decrypted body. Both codecs must reject non-bstr IDs/hashes.

## Helper transport envelope

Private inherited Unix socket; 4-byte BIG-ENDIAN unsigned length (excluding prefix),
1..1048576 bytes. No network listener. Request `[1, request_id, operation uint1..16,
 payload bstr]`; response `[1, request_id, status uint0..9, payload bstr]`.
Payload is encoded strict deterministic CBOR array (possibly empty array), maximum
1048480 bytes and total encoded body<=1048576. No empty raw bstr. Request operations:
1open,2bootstrap,3enroll_complete,4session,5key_packages,6group_apply,7prepare_send,
8send_receipt,9call_epoch,10sign_removal,11state_get,12state_transaction,
13cursor_ack,14key_packages_uploaded,15shutdown,16group_transfer. No generic SQL or identity-key
export. The open key arrives only in this private channel or a protected
descriptor. Truncated, mismatched and oversized lengths close the connection
without allocating the announced body. Request and response decoders are distinct.

### Helper payloads

One helper opens one installation and serializes every core mutation. Its state
directory is fixed at process launch; no operation accepts a database path. Before
any schema access it applies the 32-byte database key and verifies decryption by
reading `sqlite_schema`. New directory mode is 0700, files 0600, process umask077;
symlinks and insecure existing state paths are refused. Database, WAL, temporary
files and crash diagnostics are included in this boundary. Open binds the stored
installation, instance and community; any later mismatch refuses. The key is
zeroized after configuring the connection and is never returned or logged.

In the table, `body` is a bounded byte string containing the existing core's
deterministic CBOR input/output for the named operation, validated again by that
operation; it is never SQL. A void result is `[]`. Scalar results are wrapped in
an array. Returned core bodies are `[body]` to keep the helper payload an array.
Unknown operations/suboperations fail with status1, unsupported state with5,
revision conflicts with4, and internal failures with9 plus `[]`. Error responses
never contain database, provider or decrypted-message error text.

| Op | Request payload | Successful response |
| --- | --- | --- |
| 1 open | `[instance_id, community_id, installation_id, database_key32]` | `[store_version, identity_info_body]` |
| 2 bootstrap | `[instance_id, community_id, installation_id]` | `[umk_pub32, ssk_pub32, sig_umk_ssk64, device]` |
| 3 enroll_complete | `[bot_user, username, now]` | `[final_credential, signed_device_list_body]` |
| 4 session | `[suboperation, ...arguments]`, below | core body or void |
| 5 key_packages | `[count, last_resort]`, count1..32, last_resort0..1 | `[upload_body]` |
| 6 group_apply | `[suboperation, ...arguments]`, below | core body or void |
| 7 prepare_send | `[operation_id, group_id, send_request_body, now]` | `[message_id, upload_body]` |
| 8 send_receipt | `[operation_id, receipt_body, send_response_body]` | `[]` |
| 9 call_epoch | `[suboperation, group_id]`, below | core body or void |
| 10 sign_removal | `[request_id, group_id, target_sequence, expires, now]` | `[proof, signature64]` |
| 11 state_get | `[suboperation, ...arguments]`, below | state records |
| 12 state_transaction | `[transaction_id, changes]`, below | `[revisions]` |
| 13 cursor_ack | `[group_id, through_sequence, through_epoch]` | `[]` |
| 14 key_packages_uploaded | `[package_refs]`, at most100 distinct bstr32 | `[]` |
| 15 shutdown | `[]` | `[]`, then close |
| 16 group_transfer | `[suboperation, ...arguments]`, below | transfer result |

Bootstrap is repeatable across restarts and returns the same pending identity.
It fixes Bot/Native/Native together and cannot adopt a human identity or overwrite
another installation. Enrollment completion is repeatable for the same account;
conflicting account completion fails. A bot bootstrap cannot be completed through
human signup. The helper verifies the final credential and signed device list
before any KeyPackage or group operation. Signing removal derives actor/account,
device and community from this identity and the bound group, never caller fields.
It signs the exact removal preimage above after validating the 30-second window.

Session suboperations are: 0 identity `[]`; 1 sign `[nonce32,purpose0..1]`;
2 store `[token,expires,idle_expires]`; 3 read `[]`; 4 clear `[]`;
5 device_list `[]`; 6 device_list_published `[]`. Token text is bounded to256
bytes and exists only within protected IPC and the encrypted store. Session
responses never include an identity signing key or recovery key.

Group suboperations are: 0 list `[]`; 1 inspect `[group_id]`;
2 create `[operation_id,group_id,target_id,kind,policy,external_sender_pub32|null]`;
3 registered `[operation_id,group_id,next_sequence]`;
4 discard `[operation_id,group_id]`;
5 external_join `[operation_id,group_id,channel_id,kind,policy,group_info,tree]`;
6 joined `[operation_id,group_id,sequence]`;
7 welcomes `[welcomes_body,expected_bindings_body]`;
8 apply `[group_id,handshakes_body,messages_body,through_sequence]`;
9 build_commit `[operation_id,group_id,proposals_body]`;
10 confirm_commit `[operation_id,group_id]`;
11 abort_commit `[operation_id,group_id]`; 12 cursor `[group_id]`;
13 revalidate_sender `[group_id,leaf_index,limit]`;
14 trust_sender `[group_id,leaf_index,requested_user,history_body,head_list,now]`;
15 proposed_adds `[group_id,proposals_body]`;
16 trust_add `[group_id,proposals_body,index,requested_user,history_body,head_list,now]`;
17 pending_leaves `[]`; 18 events_read `[after_delivery_id,limit]`;
19 events_ack `[through_delivery_id]`; 20 intent_result `[operation_id]`.
Here argument arrays expand after the suboperation number rather than adding a
nested array. Kind is the existing text, call or interaction group kind. Text and
call groups require this installation's community. Interaction groups preserve
`01`'s null community, target equal to this bot's account and no external sender;
the helper additionally persists their installation/community association and
eligible human participant. Interaction creation requires null external sender;
text/call creation requires the public key. External join is unavailable for
interaction groups; their membership uses ordinary signed Add/Welcome processing.
Welcome expectations, participants and actual bindings must agree with that
scope. Sender validation uses the existing credential/device-list chain;
unvalidated pending history must never produce actionable bot messages.
Revalidation limit1..256; leaf index at most uint32 max. Network pages are bounded
by encoded size; indivisible large group objects use group_transfer below.
Actionable decrypted messages are delivered through the durable event journal,
retaining the core-authenticated sender and server receipt time. A user field in
application content cannot replace attribution.

### Group upload intents and recovery

Operation ids are nonzero bstr16. Create, external_join and build_commit persist
their exact public upload body and canonical input hash in the same core storage
unit as the MLS mutation. The intent binds operation id, installation, group and
suboperation. A matching pending retry returns those bytes; conflicting input
fails. This applies to both direct requests and group_transfer. The native core
must not generate another pending commit after a lost helper or HTTP response.

intent_result returns `[kind,group_id,state,result|null]`, or `[null]` if absent.
kind is2 create,5 external_join or9 build_commit; state0 pending,1 accepted or2
refused. Pending result is the exact original core upload body as bstr. Registered,
joined, confirm_commit and their matching discard/abort operations resolve only
the matching intent in the same unit as the core transition. They retain the
resolution argument hash: equal retries are no-ops, conflicting outcomes or
sequence arguments fail. Resolved intents retain input/binding/state metadata and
clear the large result. Retrying a crypto-producing operation for a resolved id
returns conflict; intent_result provides its outcome without generating crypto.

The Go client persists its operation id before requesting an intent and queries
it after restart. It resolves an intent only after determining the authoritative
server outcome from a matching binding, handshake and epoch or a conclusive
refusal. A missing response is not refusal. Group application and Welcome retries
instead recover through persisted source progress and group membership; successful
late sender revalidation recovers through the event journal.

### Authenticated event journal

Only a validated native Bot identity can populate or read the journal. Accepted
non-own text-group applications enter it in the same core unit as their verified
message insertion, before folding changes their body. Successful pending-sender
revalidation does the same, even for an older source sequence. No event is created
from an undecryptable, pending, mismatched, deleted or pruned row, a call-group
application, or an own upload echo. Group scope comes from the verified stored
binding. The initial feed admits only text groups in the installation community;
interaction admission and its event context require the later typed installation
binding and are refused until that contract is implemented.

Each event has an independent, monotonically increasing delivery id. The unique
source key is `(group_id,source_sequence)`, which remains after acknowledgement.
A newly authenticated old message receives a new delivery id. The event shape is:

`[delivery_id,group_id,community_id,channel_id,source_sequence,epoch,recv_ts,
 sender_user,sender_device,sender_kind,sender_tier,sender_leaf,message_id,
 envelope_type,original_body,reply_to|null,thread_id|null]`.

The original body is the authenticated envelope body, bounded by the existing
envelope limit. Sender fields derive from MLS credential, uploader agreement and
device-list validation. Internal provenance retains the signature-key information
needed for current trust checks; no private key, franking key or raw envelope is
exported to Go.

events_read has limit1..100 and returns `[events,next_delivery_id,high_water]`.
Its exclusive cursor is the greater of after_delivery_id and the durable ack.
Pages obey the full encoded response limit. next_delivery_id is the last examined
id, including retracted rows; a live row excluded for size stays unexamined. An
oversized first live row fails, never silently skips. high_water is the maximum
created delivery id. events_ack persists its id and clears acknowledged plaintext;
an equal ack is an idempotent retry, while lower or future ids fail. Compact
source/delivery/disposition metadata remains until a proven non-replay floor
permits removal. This acknowledgement is distinct from server cursor_ack op13.

Tombstones, author deletions and trust retraction suppress queued plaintext in
the same unit that withdraws their source. This includes late tombstones,
message_deleted, fold-driven target deletion and trust quarantine. An authenticated
author-delete event may itself be delivered while its target is suppressed.
Drain rechecks source status and current group binding/state/trust; a journal row
alone is not authority. Go persists feature progress before acknowledging, uses
stable effect ids on redelivery, and checks current permission before acting.
There is no atomic transaction spanning an external effect and the local journal.

### Bounded group transfer

Some server-valid group objects exceed one helper frame. Op16 retains the1MiB
frame cap while carrying a typed op6 logical request/result in bounded chunks.
Only target operation6 is allowed: no nested transfer, path, SQL, identity export
or arbitrary byte store. Input and result are each at most32MiB; existing core
and server operation limits still apply, including the256-Welcome commit limit.

| Suboperation payload | Response |
| --- | --- |
| `[0,6,input_length,input_sha256]` | `[transfer_id]` |
| `[1,transfer_id,offset,chunk_bstr]` | `[next_offset]` |
| `[2,transfer_id]` | `[target_status,result_length,result_sha256]` |
| `[3,transfer_id,offset,requested_length]` | `[chunk_bstr]` |
| `[4,transfer_id]` | `[]` |

transfer_id is a generated opaque bstr16 bound to the initiating request and
inherited socket connection. One transfer exists per helper; chunks are at most
768KiB. Validate declared lengths before allocation, exact increasing upload
offsets, full length and SHA256 before executing. Reads require execution and an
in-range slice of1..768KiB; repeated reads are allowed. Repeated execute returns
the same saved descriptor without executing again on that connection. A target
failure returns its normal sanitized status with deterministic `[]` as result.

Transfers use no disk staging. Clear and zeroize buffers on failure, release,
shutdown or disconnect. Upload has a30-second deadline from begin; completed
results expire after30 idle seconds. A silent peer must not prevent expiry.
A second connection cannot resume/read another transfer.
Unknown ids, invalid length/hash/offset/target or reads before execution fail with
status1; contention uses6. Core mutation stays serialized; unrelated mutation
requests receive6 until release rather than blocking the socket. Shutdown remains
available. Transport-owned input, result and encoding/chunk scratch stay
within96MiB in aggregate; do not multiply whole-payload copies. Core MLS working
state separately follows its existing bounds.

The Go parent enforces execution deadlines and terminates an unresponsive helper.
A transfer descriptor is not durable proof of execution: after interruption,
the client uses the typed intent or source-progress recovery rules above. It never
blindly repeats a crypto-producing operation or discards uncertain network work.

Call suboperations are: 0 media_epoch; 1 join_check; 2 leave_proposal; 3 rotate;
4 forget. Each calls the corresponding existing call-group core operation. Media
epoch material is returned only for an active, authorized call group, with its
epoch and roster. The private Go media pump owns separate key rings per call and
clears these secrets when that call stops.

Prepare-send persists an operation-to-outbox association and the exact encrypted
request before returning. Repeating the same operation/input returns those bytes;
conflicting reuse fails. No crash or uncertain upload can silently re-encrypt it.
Upload body is the existing `[epoch,private_message,class]`; send-response body
is the existing `[sequence,franking_tag32,receive_timestamp]`. The franking
commitment remains inside the existing MLS construction, not an extra caller-
supplied field. Neither wire-2 upload-class enforcement nor franking is bypassed.
Receipt confirmation verifies operation/community/group/hash before changing the
outbox or timeline. A new ciphertext after a conclusively refused upload needs an
explicit resolved-outcome transition; absence of a response is not that proof.

State areas are 0 settings,1 queues,2 schedules,3 occurrences,4 moderation,
5 processed operations,6 structural cursors,7 role-grant sources,8 send operations.
Keys are nonempty bstr of at most128 bytes; values are deterministic CBOR arrays
of at most262144 bytes. State-get suboperation0 is `[area,key]` and returns
`[revision,value|null]`, missing revision0. Suboperation1 scans
`[area,after_key|null,limit]`, limit1..100, and returns `[rows,next_key|null]`;
rows are `[key,revision,value|null]`, sorted lexicographically and also limited by
encoded response size. Tombstones retain their revision. State never exposes
identity, session or MLS internal tables.

Changes in a state transaction are 1..64 unique `[area,key,expected_revision,
value|null]` entries, still under the whole frame limit. Every revision check and
write commits atomically; each revision advances by one and overflow refuses.
The encrypted transaction receipt binds the transaction id to the canonical
change bytes and original result. Repeating matching bytes returns the same
revisions; conflicting reuse fails. No partial writes survive a conflict or
storage failure. Structural cursor updates can share this transaction with the
resulting feature-state change; network acknowledgement occurs afterwards.

## Session capability and compatibility

Wire 3 adds the bot contract; wire 2 remains supported outside bot-enabled
functionality. Human signup, E2EE envelopes and media formats are unchanged.
`POST /v1/sessions/negotiate` requires an enrolled device session and accepts
`[[wire_versions], [e2ee_versions], [media_versions]]`, each list of 1..8 unique
positive uints. It chooses the highest common version from server support and
persists the selection against the authenticated bearer session. Response:
`[wire, e2ee, media]`. No common version is `400 E_VERSION`; no row changes on
failure. An authenticated gateway identify records its accepted versions against
the same bearer session before publishing ready. An accepted downgrade replaces
previous capability; device identity alone cannot lend capability to another
session. Revocation removes the binding. Resume verifies the current bearer and
reestablishes the original connection's versions before replay.

All bot routes and bot-enabled community mutation/sync operations check the
resolved session's negotiated wire >=3. Missing/older capability yields
`400 E_VERSION` with `supported=[3]`, allowing the UI to show an upgrade action.
A request header containing a version is not evidence of negotiation. Existing
wire-2 sessions can continue using unaffected communities, DMs and account routes.
The shipping client advertises [3,2], selects the highest supported version, and
retains an explicit bot-unavailable/upgrade state when selected wire is 2.
Runtime provisioning credentials are a separate scope, never a device session or
instance-admin bearer. Bot runtime claims and enrollment require the wire-3 body
contract directly; enrolled bot actions require the normal negotiated session.

For this gate, a community is bot-enabled while its current installation has no
removal timestamp and is not disabled. Pending, enrolling, joining, ready and
error installations all count. Ordinary community, channel, member, role,
permission, invite and ban metadata snapshots remain readable under their normal
authorization, so an older client can discover the community and explain its
upgrade requirement. The gate covers community structural mutations, group
registration and synchronization, message history and readable-channel message
operations (including reactions, pins, search and read state), channel attachment
operations, and community call admission/control/synchronization. DM, pairing,
account and instance operations with no community binding remain available.
Publishing one's account KeyPackages is unscoped; a group-bound KeyPackage fetch
or Welcome is checked against that group's community. Bot interaction groups
retain their existing null-community binding but require wire 3 for registration,
synchronization and delivery independently, as do bot application endpoints.

Resolve and authorize the actual resource before reporting an upgrade refusal.
Unknown or hidden resources keep their existing refusal, including reader-ACL
group access and the signed body binding on group registration. A request checks
the current committed installation state at its authorization boundary before
performing the protected operation; an operation already admitted may finish if
enablement commits concurrently. This is a compatibility gate and does not
replace the operation's current permission, membership or transaction checks.
Store failures refuse the affected operation with an availability error, rather
than treating the community as disabled.

Gateway compatibility is per resource, not per user. A wire-2 connection may
identify and receive unaffected groups, DMs and account traffic. Its ready digest,
subscriptions, group notifications, channel content and community call traffic
exclude enabled communities. Group committer eligibility applies the same gate.
Ordinary community metadata-change notifications may still prompt a metadata
refresh. Each scoped delivery checks committed state before entering the writer
queue; a frame already queued before enablement may finish. Every gateway uses
the shared authoritative state, without a stale process-local enablement cache.
Replay entries retain internal resource scope, including all groups in a ready
digest. If an entry to be replayed is now disallowed, resume is refused as
nonresumable and the client identifies again for a filtered digest; entries must
not be silently skipped within the sequence. A live connection retains its
identify-time version until it closes; HTTP uses its bearer's latest negotiated
selection. Resume revalidates the bearer and current resource eligibility before
restoring the original connection versions. Managed bot connections additionally
retain the requirement that both the bearer and original connection selected
wire 3.

## Installation and enrollment API

Auth labels E and A here mean enrolled human and instance-admin sessions. B means
a live managed bot session bound to this community's installation/account/device.
B uses the existing enrolled device-session scope (numeric 0), with additional
installation-state and route restrictions; it is not a fourth session scope.
The installation state enrolling is independent of that session scope. Such a
session may negotiate capabilities while enrolling, joining or ready, before
calling routes that require wire 3. Capability negotiation itself does not
require a previously negotiated version and cannot relax installation limits.
R means a hashed, operator-registered runtime credential with provisioning scope.
All E/A changes require existing step-up when the corresponding human operation
requires it. Installation configuration additionally checks each granted
capability's corresponding permission and role ceiling. A bit alone never grants
new authority to the runtime or bot account.

Capabilities are a uint bitmask: bit0 music,1 welcomes,2 roles,3 announcements,
4 warnings/timeouts,5 message removal,6 kick,7 ban. Unknown bits fail. Enabled
capabilities are approved constraints in addition to normal current permissions.
Default automation actions are log-only; automatic bans are unavailable.

`installation = [installation_id, community_id, state, revision, bot_user|null,
 bot_device|null, capabilities, updated_at]`; state uses the structural event enum.
A single non-removed installation exists per community; repeat enable with the
same request id and payload returns the original result. Removed installations
are never reactivated; a new enable creates a new identity and installation id.

| Method and path | Auth | Request | Response |
| --- | --- | --- | --- |
| `GET /v1/communities/{community}/bot` | E, manage_community | — | installation or 404 |
| `PUT /v1/communities/{community}/bot` | E, manage_community | `[request_id, expected_revision|null, capabilities, step_up]` | installation, 201 new / 200 existing |
| `POST /v1/communities/{community}/bot/disable` | E, manage_community | `[request_id, expected_revision]` | installation |
| `DELETE /v1/communities/{community}/bot` | E, manage_community | `[request_id, expected_revision]` | 204 |
| `GET /v1/bot-runtime/installations` | R | — | `[installations]`, at most 100; `after` is last installation id |
| `POST /v1/bot-runtime/installations/{installation}/claim` | R | `[request_id]` | `[installation, claim_id, claim_expires]` |
| `POST /v1/bot-runtime/installations/{installation}/enroll` | R, matching claim | `[request_id, claim_id, umk_pub32, ssk_pub32, sig_umk_ssk64, device]` | `[bot_user, bot_device, username]` |
| `PUT /v1/bot-runtime/installations/{installation}/credential` | B, enrolling; completed retries while joining/ready | `[request_id, expected_revision, credential_bstr]` | installation |
| `POST /v1/bot-runtime/installations/{installation}/ready` | B, joining; completed retry while ready | `[request_id, expected_revision]` | installation |

`device` is `09`'s native registration tuple, with device tier Native and signer
tier Native. Credential kind MUST be Bot, and all key ids, key signatures, device
keys and tiers must agree. The placeholder user id is zero only in the enrollment
credential because the server creates the account id; the final credential and
signed device list MUST bind the assigned account before any group admission.
Human `/v1/accounts` cannot enroll Bot credentials. Claims last ten minutes, are
bound to the runtime credential and installation, and repeat requests return the
same unexpired claim. Enrollment stores its operation result transactionally;
repeat matching requests return the same account/device, not a second identity.
For an already committed enrollment, a live runtime credential may replay the
same operation id and exact payload for that installation after claim expiry.
The stored result is bound to the original runtime credential id; authorization
and that binding are checked before replay, and an expired claim cannot authorize
a new enrollment. A revoked runtime cannot retrieve results. Operator credential
rotation replaces the token hash on the same runtime id, invalidates outstanding
claims and keeps completed operation receipts; the old token immediately fails.
Rotation therefore preserves recovery without issuing a second bot identity.
Enrollment creates no bearer token. The helper completes its local identity with
the assigned account, then obtains a session using the normal device-key challenge
and proof. This also recovers a lost enrollment response without retaining raw
bearer tokens. The credential route verifies the final Bot/Native/Native credential
against the already registered account, UMK, SSK and device key, and atomically
stores it before moving enrolling to joining. The original operation result is
retained for matching retries; conflicting reuse fails. Claim expiry or runtime
revocation never exposes existing private identity state.

A lost finalization response is retried with the same request id and payload
after the installation has entered joining or ready. In those phases the
credential route may return only a matching completed receipt; it cannot accept
a new credential operation. The ready route likewise permits a matching
completed retry after reaching ready. Current session and installation authority
is checked before receipt lookup, so disablement or revocation still refuses a
retry. These recovery paths never reopen enrollment or replace identity keys.

All bot sessions are bound to their installation, account and registered device.
An enrolling installation permits only capability negotiation, its credential
finalization and session termination. Joining permits normal signed device-list,
KeyPackage and authorized group synchronization operations. Ready additionally
permits enabled feature actions. Disabled or removed installations cannot mint or
use sessions, including through ordinary device-key renewal. Existing non-bot
session scopes and human factor requirements remain unchanged.

Ready is accepted only after the final credential, signed native device list,
KeyPackages and required group membership are verified. Revocation/disable stops
future actions, invalidates installation sessions/claims, issues ordinary MLS
removals and disconnects associated media publishers. A runtime credential has
no generic admin or moderation access. The managed moderator-factor exception
requires a validated live installation and explicit capability approval; a bare
Bot-kind account cannot bypass human factor requirements.

`step_up` is the existing short-lived human step-up token, bound to that bearer
session. A new enable or capability change consumes it after checking current
permissions. Its secret bytes are excluded from the durable operation digest and
receipt. A matching completed retry checks current authority and the original
actor binding, then returns the stored result without consuming another token or
applying another change. Disable and removal remain available through ordinary
current human authorization so emergency shutdown requires no bot availability.

## Durable events and receipts API

| Method and path | Auth | Request | Response |
| --- | --- | --- | --- |
| `GET /v1/communities/{community}/bot/events?after=N&limit=L` | B | — | `[events, next_seq, high_water, floor]` |
| `PUT /v1/communities/{community}/bot/events/ack` | B | `[through]` | 204 |
| `GET /v1/communities/{community}/bot/receipts/{operation}` | B | — | `[receipt, send_response|null]` or 404 |
| `POST /v1/groups/{group}/bot/messages` | B | `[operation_id, epoch, private_message, class]` | `[sequence, franking_tag32, receive_timestamp]` |

L defaults to 100 and is at most 250; each page also stays below 1 MiB. Sequence
values admitted to SQL are at most signed-int64 max; overflow refuses, never wraps.
Events and their community sequence increments commit with the structural change.
Gateway opcode54 remains a wakeup; recovery always polls this stream. `after` is
exclusive. A cursor below the retained floor returns `410 E_PRUNED` with the floor
and high-water. Reconcile current membership/configuration, report the gap and
avoid inventing historical welcomes. Ack is monotone and cannot exceed the
published high-water; consumer commits progress locally before acknowledging.

Send admission applies normal group/channel ACLs and MLS epoch checks. Lookup is
scoped to the authenticated installation, group and operation. Store the accepted
message, ciphertext hash, receipt and original send response atomically. Accepted
receipt lookups retain that response even after message-content retention; pending
receipts have a null response. A replay with identical bytes
returns the original result even after epoch advancement; a conflicting hash
is `409 E_INVALID_REQUEST`. The bot resolves uncertain outcomes before generating
another ciphertext. Structural events retain 30 days; accepted send receipts
retain until installation removal so a delayed retry cannot duplicate a welcome
or announcement. Disabled installations retain receipts for inspection/recovery
but cannot send. Unknown operations have no receipt.

## Role delegation and human moderation API

`moderate_members` is permission bit24; include it in known masks, role editors,
hierarchy checks and moderator-factor checks. It is community-scoped, not
channel-overwritable. Existing kick/ban/manage_messages permissions retain their
meanings. Owners and administrators are exempt from automatic moderation.

| Method and path | Auth | Request | Response |
| --- | --- | --- | --- |
| `PUT /v1/communities/{community}/bot/role-policy` | E, manage_roles | `[request_id, expected_revision, join_role|null, allowed_roles]` | `[revision]` |
| `PUT /v1/communities/{community}/bot/role-panels/{panel}` | E, manage_roles | `[request_id, expected_revision, channel_id, message_id, entries]` | `[revision]` |
| `DELETE /v1/communities/{community}/bot/role-panels/{panel}` | E, manage_roles | `[request_id, expected_revision]` | 204 |
| `PUT /v1/communities/{community}/bot/role-panels/{panel}/selection` | E, own member | `[request_id, expected_revision, selected_roles]` | `[revision, own_roles]` |
| `POST /v1/communities/{community}/bot/role-grants` | B | `[operation_id, member_id, source_kind, source_id, role_id, selected]` | 204 |
| `PUT /v1/communities/{community}/members/{member}/timeout` | E or capability-approved B | `[request_id, expires]` | `[request_id, expires]` |
| `DELETE /v1/communities/{community}/members/{member}/timeout` | E, moderate_members | `[request_id]` | 204 |
| `GET /v1/communities/{community}/members/{member}/timeout` | E, own member or moderate_members | — | `[expires|null]` |
| `POST /v1/communities/{community}/moderation/actions` | E or capability-approved B | `[request_id, action, target_user|null, expires|null]` | `[action_id]` |
| `POST /v1/groups/{group}/moderation/removals` | E or capability-approved B | `[proof_bstr, signature64]` | `[action_id, removal_revision]` |
| `GET /v1/communities/{community}/moderation/actions?after=N&limit=L` | E, view_audit_log or B | — | `[structural_actions, next_seq]` |
| `GET /v1/groups/{group}/moderation/removals?after=N&limit=L` | E or B, group access | — | `[removal_rows, next_revision]` |

Role lists have at most 100 unique ids and entries are `[role_id, emoji|null]`,
emoji at most32 UTF8 bytes. Configuring human must satisfy normal rank and
permission ceilings; privileged roles and roles above the ceiling are refused.
Panels must name an accepted bot-authored message in that channel; spoofed panels,
deleted roles and inactive panels are inert. Human selection acts only on the
session user. Reaction grants use the authenticated reaction uploader, never the
panel author. Source_kind0 join,1 selection,2 reaction; source_id is membership
episode, selection operation or reaction message id respectively. Server verifies
membership episode/panel/event attribution before a constrained grant. Tracking
sources preserves an independent manual grant when a reaction is removed. A
manual revocation clears relevant selection sources; new selection reevaluates
current policy. The bot never receives unrestricted manage_roles.

Action uses the structural-event moderation enum. Normal current permissions,
hierarchy and step-up apply; manual UI requests use the initiating human session.
Timeout defaults ten minutes for automation, maximum28 days per request. Expiry
is evaluated at request time without a cleanup dependency. Timeout blocks text,
reactions, edits and pins before encrypted class-1 shortcuts and on readable
routes; reading, DMs, voice, MLS/sync and self-deletion remain available. Private
music interactions are allowed when DJ authorization holds.

Evidence is an encrypted bot outbox item keyed by action request id. Attach details
only after matching a successful authoritative action record; forged/failed
requests cannot create completed cases. Default encrypted evidence retention90d,
excerpt<=512 UTF8 bytes. Structural rows never carry reason/excerpt. The bot checks
fresh view_audit_log authority before serving details. Destructive actions remain
available while the bot is offline.

Removal acceptance binds the proof to the authenticated actor/device and current
authority, then atomically writes proof/signature/action/revision/tombstone before
emitting the existing deletion wakeup. `removal_row = [revision, proof_bstr,
 signature64, accepted_at]`. The recovery feed retains markers independently of
evidence retention and includes targets a client has not downloaded. Clients sync
markers before publishing recovered timelines and exclude removed content from
late originals/edits, search, pins, replies and attachment previews. Expiry gates
new acceptance only, not interpretation of already accepted proofs.

## Spotify setup boundary

Server Settings > Bot > Music owns the guided setup. Connection is installation-
wide, with one dedicated Premium account and a single active Spotify session.
Account changes require a freshly checked instance-admin session and normal
step-up; community managers see necessary readiness/busy state only. The web
client talks to authenticated Dilla APIs, never directly to a provider process.

| Method and path | Auth | Request | Response |
| --- | --- | --- | --- |
| `GET /v1/admin/bot/spotify` | A | — | `[revision, state, failure_code|null]` |
| `POST /v1/admin/bot/spotify/authorize` | A, step-up | `[request_id, expected_revision, client_id]` | `[attempt_id, authorization_url, expires]` |
| `POST /v1/admin/bot/spotify/complete` | A, initiating session | `[attempt_id, callback_url]` | `[revision, state, failure_code|null]` |
| `DELETE /v1/admin/bot/spotify/authorization/{attempt}` | A, initiating session | `[]` | 204 |
| `DELETE /v1/admin/bot/spotify` | A, step-up | `[request_id, expected_revision]` | `[revision, state, failure_code|null]` |

State0 disconnected,1 authorizing,2 connected,3 reconnect_required,4 unavailable.
client_id is a public provider application identifier, not a secret. OAuth state
and PKCE verifier are single-use, expire after ten minutes and bind the initiating
admin session and runtime installation. Auth begin/complete are conveyed to the
private provider helper; tokens never return to the browser. Callback processing
validates state, expiry, exact registered redirect and the current initiating
admin session before token exchange. An accepted callback is consumed even on
exchange failure; a new attempt is required. Changing authority, cancelling or
replacing an attempt invalidates the prior one. Do not log callback URLs/query
strings, authorization codes, verifier or tokens; no analytics/traces on callback
pages. Disconnect stops Spotify audio, releases its slot, deletes local credentials
and leaves queues paused. It does not claim remote account revocation unless that
provider action actually succeeds.

The callback mechanism MUST be supported by the OAuth client registration. A
self-hosted HTTPS callback requires its exact URI registered for client_id. The
probe's existing fixed loopback callback cannot automatically reach a remote
Dilla server. The setup adapter must resolve this before claiming shipping
onboarding; no assumed wildcard callback and no implicit new hosted relay. OAuth
callback completion above is an authenticated private API step, not a public
redirect endpoint. The UI must handle the browser return without placing secrets
in persistent client storage. Missing Spotify authorization disables Spotify
playback only; YouTube and independent bot features continue. Real account
qualification remains a required release check, not a development prerequisite.

## Vectors

`vectors/bot.json` is generated by `packages/protocol-vectors` and consumed by
Go `internal/bot/protocol`, Rust `dilla_core::bot`, and TypeScript client-core bot
codecs. Cases roundtrip canonical bytes; rejection cases include malformed types,
wrong context, expired mutations and noncanonical encodings. Pure validation is
not runtime authorization: enrollment, current permissions, account binding,
provider authentication and store atomicity have independent integration tests.
