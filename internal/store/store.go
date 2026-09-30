// Package store is dillad's one persistence contract: a hand-written repository
// over two generated query sets. Nothing above this package ever sees a *sql.DB,
// because sqlc's two DBTX interfaces do not unify (facts-storage §1.4).
package store

import (
	"context"
	"errors"

	"github.com/jonasthim/dilla/internal/id"
)

var (
	ErrNotFound  = errors.New("store: not found")
	ErrConflict  = errors.New("store: conflict")  // unique violation, optimistic-lock miss
	ErrExhausted = errors.New("store: exhausted") // invite max_uses, quota
)

// Repository is what dillad persists through. Tx runs fn in one transaction and
// the Repository fn receives IS that transaction; nesting is an error. Close
// releases both pools.
//
// The embed list grows as the schema does, one named step per task (ID1):
// task 19 step 1a adds MLS with 00002_mls.sql, task 23 step 1a adds Messages and
// Cursors with 00003_messages.sql, Plan 2 task 1 step 9 adds Communities (the
// part of Structure whose tables 00004_structure.sql ships), Plan 2 task 2 adds
// Channels (the part 00005_channels.sql ships), Plan 2 task 3 adds Overwrites (the
// part 00006_overwrites.sql ships), Plan 2 task 4 adds Bans (the part
// 00007_bans.sql ships), Plan 2 task 6 adds ChannelMembers (the part
// 00008_channel_members.sql ships), Plan 2 task 8 adds Readable with
// 00009_readable.sql, and Plan 2's later tasks add the rest of Structure, Blobs
// and OpsBackups.
type Repository interface {
	Tx(ctx context.Context, fn func(Repository) error) error
	Close() error
	Instance
	Accounts
	Devices
	Sessions
	Auth
	Invites
	Ops
	MLS         // task 19 step 1a — 00002_mls.sql
	Messages    // added HERE — ID1; its table is 00003_messages.sql, written in step 1
	Cursors     // added HERE — ID1; device_cursors ships with 00002_mls.sql, its queries here
	Communities // Plan 2 task 1 step 9 (P2-D23) — 00004_structure.sql
	Channels    // Plan 2 task 2 (P2-D23) — 00005_channels.sql
	Overwrites  // Plan 2 task 3 (P2-D23) — 00006_overwrites.sql
	Bans        // Plan 2 task 4 (P2-D23) — 00007_bans.sql
	// Plan 2 task 6 (P2-D23) — 00008_channel_members.sql
	ChannelMembers
	// Plan 2 task 8 (P2-D23) — 00009_readable.sql
	Readable
}

type Instance interface {
	GetInstance(ctx context.Context) (InstanceRow, error)
	CreateInstance(ctx context.Context, in InstanceRow) error
	BumpGeneration(ctx context.Context) (uint64, error)
	// SetGeneration is invariant 11's restore half (deviation B13). `dillad
	// restore` reads the generation out of the backup's manifest and names it,
	// rather than blind-bumping, so an operator who restores twice from the same
	// manifest lands on the same number both times. It is MONOTONE: a manifest
	// older than the instance's current generation cannot walk the number
	// backwards, because the generation is exactly what invalidates outstanding
	// resume tokens and a backwards step would revive the ones the last restore
	// killed.
	SetGeneration(ctx context.Context, generation uint64) error
	GetSetting(ctx context.Context, key string) ([]byte, error)
	// PutSetting carries its own timestamp: instance_settings.updated is
	// NOT NULL, and a repository with no clock has nothing to write there
	// (deviation ID11).
	PutSetting(ctx context.Context, key string, value []byte, updated int64) error
}

type Accounts interface {
	CreateUser(ctx context.Context, u UserRow) error
	GetUser(ctx context.Context, userID id.ID) (UserRow, error)
	GetUserByUsername(ctx context.Context, username string) (UserRow, error)
	ListUsers(ctx context.Context, after id.ID, limit int32) ([]UserRow, error)
	SetUserDisabled(ctx context.Context, userID id.ID, at *int64) error
	TombstoneUser(ctx context.Context, userID id.ID, at int64) error // keeps username (R36)
}

type Devices interface {
	CreateDevice(ctx context.Context, d DeviceRow) error
	GetDevice(ctx context.Context, deviceID id.ID) (DeviceRow, error)
	ListDevicesByUser(ctx context.Context, userID id.ID) ([]DeviceRow, error)
	TouchDevice(ctx context.Context, deviceID id.ID, lastSeen int64) error
	RevokeDevice(ctx context.Context, deviceID id.ID, at int64) error
	PutDeviceList(ctx context.Context, l DeviceListRow) error
	GetDeviceList(ctx context.Context, userID id.ID) (DeviceListRow, error)
}

type Sessions interface {
	CreateSession(ctx context.Context, s SessionRow) error
	GetSessionByHash(ctx context.Context, tokenHash []byte, now int64) (SessionRow, error)
	TouchSession(ctx context.Context, tokenHash []byte, idleExpires int64) error
	DeleteSession(ctx context.Context, tokenHash []byte) error
	DeleteSessionsByDevice(ctx context.Context, deviceID id.ID) (int64, error)
	DeleteSessionsByUser(ctx context.Context, userID id.ID) (int64, error)
	CountSessionsByDevice(ctx context.Context, deviceID id.ID) (int64, error)
	DeleteOldestSessionForDevice(ctx context.Context, deviceID id.ID) error
	PruneSessions(ctx context.Context, now int64) (int64, error)
}

type Auth interface {
	PutPasswordCredential(ctx context.Context, userID id.ID, phc string, updated int64) error
	GetPasswordCredential(ctx context.Context, userID id.ID) (string, error)
	PutTOTP(ctx context.Context, t TOTPRow) error
	GetTOTP(ctx context.Context, userID id.ID) (TOTPRow, error)
	ConsumeTOTPCounter(ctx context.Context, userID id.ID, counter int64) error
	PutRecoveryCodes(ctx context.Context, userID id.ID, hashes [][]byte, created int64) error
	ConsumeRecoveryCode(ctx context.Context, userID id.ID, hash []byte, at int64) error
	CountRecoveryCodes(ctx context.Context, userID id.ID) (int64, error)
	// PutWebauthnUser is INSERT ... ON CONFLICT (rp_id, user_id) DO NOTHING: a
	// handle is minted once and never rotated, because the authenticator keeps
	// the handle it saw at registration and a rotation makes discoverable login
	// impossible for that account. GetWebauthnUserHandle is the read that makes
	// minting idempotent (deviation ID11).
	PutWebauthnUser(ctx context.Context, userID id.ID, rpID string, handle []byte, created int64) error
	GetWebauthnUserHandle(ctx context.Context, rpID string, userID id.ID) ([]byte, error)
	GetWebauthnUserByHandle(ctx context.Context, rpID string, handle []byte) (id.ID, error)
	PutWebauthnCredential(ctx context.Context, c WebauthnCredentialRow) error
	ListWebauthnCredentials(ctx context.Context, userID id.ID, rpID string) ([]WebauthnCredentialRow, error)
	GetWebauthnCredential(ctx context.Context, credID []byte) (WebauthnCredentialRow, error)
	UpdateWebauthnCredential(ctx context.Context, credID []byte, signCount int64, flags []byte, lastUsed int64) error
	PutCeremony(ctx context.Context, c CeremonyRow) error
	TakeCeremony(ctx context.Context, ceremonyID id.ID, now int64) (CeremonyRow, error) // single use
	PruneCeremonies(ctx context.Context, now int64) (int64, error)
	PutOIDCIdentity(ctx context.Context, issuer, subject string, userID id.ID, created int64) error
	GetOIDCIdentity(ctx context.Context, issuer, subject string) (id.ID, error)
	RecordLoginAttempt(ctx context.Context, a LoginAttemptRow) error
	CountLoginFailures(ctx context.Context, userID id.ID, since int64) (int64, error)
	ClearLoginFailures(ctx context.Context, userID id.ID) error
}

type Invites interface {
	CreateInvite(ctx context.Context, i InviteRow) error
	GetInviteByHash(ctx context.Context, codeHash []byte) (InviteRow, error)
	// RedeemInvite: one UPDATE guarded by used_count < max_uses AND revoked_at IS NULL
	// AND expires_at > now; ErrExhausted unless RowsAffected == 1.
	RedeemInvite(ctx context.Context, codeHash []byte, now int64) (InviteRow, error)
	RevokeInvite(ctx context.Context, inviteID id.ID, at int64) error
	ListInvites(ctx context.Context, communityID *id.ID) ([]InviteRow, error)
}

// MLS is the delivery service's own table set (004_mls.sql), implemented from
// task 19 onward. Declared here by deviation ID1: the method names are fixed
// once, so no later task invents one.
type MLS interface {
	CreateGroup(ctx context.Context, g GroupRow) error
	GetGroup(ctx context.Context, groupID id.ID) (GroupRow, error)
	ListOpenGroups(ctx context.Context, after id.ID, limit int32) ([]GroupRow, error)
	// ListGroupsForRetention is the same paged walk WITHOUT the `closed_at IS NULL`
	// filter. Invariant 10 caps application ciphertext at thirty days for every
	// group, and a group invariant 11 closed is still ciphertext on the disk: a
	// sweep over open groups alone would leave a closed group's blobs unswept by
	// both halves of retention forever, which inverts the invariant into "kept
	// indefinitely" at the moment a group stops being useful. Deviation ID1 fixes
	// the method set once, so it is declared here rather than invented per caller.
	ListGroupsForRetention(ctx context.Context, after id.ID, limit int32) ([]GroupRow, error)
	CloseGroup(ctx context.Context, groupID id.ID, at int64) error
	// The three statements invariant 11 runs, added by deviation B13. Plan 2
	// records the first two as P2-D19 for the same work, so they are declared
	// ONCE, here, rather than twice with two spellings.
	//
	// MarkAllGroupsEpochUnknown is `dillad restore`'s "every group becomes
	// epoch-unknown", with the heal deadline the window gives it, as ONE
	// statement over every open group: a paged loop that stopped at a fixed
	// batch would leave every group past the batch serving state the restored
	// database no longer matches.
	MarkAllGroupsEpochUnknown(ctx context.Context, healDeadline int64) error
	// ClearEpochUnknown is an adopted heal. It clears the deadline with the
	// flag: a healed group that kept its deadline would look overdue to the
	// next sweep that read the pair.
	ClearEpochUnknown(ctx context.Context, groupID id.ID) error
	// EndAllVoiceSessions is invariant 11's "Live calls end." On a Plan-1
	// database a live call IS its call group -- R9 puts the call id in the
	// companion column and `voice_sessions` is Plan 2's table -- so this closes
	// every open call group. Plan 2 task 1 widens the same method rather than
	// declaring a second one.
	EndAllVoiceSessions(ctx context.Context, at int64) error
	NextSeq(ctx context.Context, groupID id.ID) (uint64, error) // one space, both streams
	PutGroupState(ctx context.Context, groupID id.ID, epoch uint64, state, groupInfo, treeHash []byte) error
	AppendHandshake(ctx context.Context, h HandshakeRow) error
	ListHandshakes(ctx context.Context, groupID id.ID, fromSeq uint64, limit int32) ([]HandshakeRow, error)
	OldestHandshakeSeq(ctx context.Context, groupID id.ID) (uint64, error)
	// GetCommitAtEpoch is the ONE handshake that carried a group into `epoch`:
	// the lowest-seq row of kind 1 (commit) or 2 (external_commit) at that
	// epoch, over `mls_handshakes_by_epoch`. Deviation B13 adds it because
	// `E_COMMIT_CONFLICT` must name the winning commit, and paging the log from
	// seq 0 misses it on any group with more than one page of live handshakes —
	// which would put a null where protocol/02 declares a `bstr` and break the
	// conflict-recovery loop invariant 3 exists for. ErrNotFound means the
	// epoch's handshake has been pruned, not that the epoch never happened.
	GetCommitAtEpoch(ctx context.Context, groupID id.ID, epoch uint64) (HandshakeRow, error)
	// PruneHandshakes deletes every handshake created before `before` and raises each affected
	// group's HandshakesPruned to the highest seq it lost, in one transaction.
	PruneHandshakes(ctx context.Context, before int64) (int64, error)
	PutProposal(ctx context.Context, p ProposalRow) error
	ListProposals(ctx context.Context, groupID id.ID, epoch uint64, includeVoid bool) ([]ProposalRow, error)
	VoidProposal(ctx context.Context, groupID id.ID, ref []byte, at int64) error
	DeleteProposals(ctx context.Context, groupID id.ID, refs [][]byte) error
	ReissueProposal(ctx context.Context, oldRef []byte, p ProposalRow) error // keeps action_id
	ReplaceMembers(ctx context.Context, groupID id.ID, epoch uint64, m []MemberRow) error
	ListMembers(ctx context.Context, groupID id.ID) ([]MemberRow, error)
	GroupsForDevice(ctx context.Context, deviceID id.ID) ([]id.ID, error)
	// GroupsForTarget is Plan 2's P2-D3: the OPEN groups of one kind bound to one
	// target (a channel's text and call groups), oldest first, over
	// mls_groups_by_target. A membership change finds the groups to issue its
	// Adds and Removes in here, rather than scanning ListOpenGroups, which is
	// O(instance) per change.
	GroupsForTarget(ctx context.Context, targetID id.ID, kind uint8) ([]GroupRow, error)
	PutKeyPackages(ctx context.Context, deviceID id.ID, kps []KeyPackageRow) error
	TakeKeyPackage(ctx context.Context, deviceID id.ID, now int64) (KeyPackageRow, error)
	CountKeyPackages(ctx context.Context, deviceID id.ID, now int64) (int64, error)
	PurgeKeyPackages(ctx context.Context, keepLastResort bool) (int64, error)
	PutWelcomePayload(ctx context.Context, w WelcomePayloadRow) error
	PutEpochTree(ctx context.Context, t EpochTreeRow) error
	PutWelcomes(ctx context.Context, w []WelcomeRow) error
	ListWelcomes(ctx context.Context, deviceID id.ID, afterID int64, limit int32) ([]WelcomeFull, error)
	DeleteWelcome(ctx context.Context, deviceID id.ID, welcomeID int64, at int64) error
	PruneWelcomes(ctx context.Context, before int64) (int64, error)
	PutForkReport(ctx context.Context, f ForkReportRow) error
	CountForkReporters(ctx context.Context, groupID id.ID, seq uint64) (int64, error)
	QuarantineDevice(ctx context.Context, deviceID id.ID, at int64, reason string) error
	// The pending-join queue (deviation B13 names the pair, B22 / ruling 43 defers it, Plan 1
	// follow-up card 8 hands it to Plan 2 task 7): the tail of a join storm beyond the 256 Adds
	// one commit may carry, durable so a restart between two slices loses no device.
	//
	// QueuePendingJoins queues devices for groupID at `at`. A device already queued keeps its row
	// and its place. ListPendingJoins READS the oldest `limit` devices, ties broken by device id,
	// and removes nothing: a drain deletes a device's row with DeletePendingJoins only once the
	// device is resolved (its Add stored, or judged ineligible), so a process that dies in the
	// middle of a slice leaves every unresolved device queued. (B13 named a take-and-delete pair;
	// Plan 2 task 7 fix round 1 split it, because a take commits the delete before the Adds exist.)
	// CountPendingJoins is the queue's length, and ListPendingJoinGroups pages the groups holding
	// a queue by group id after `after`, one row per group, for the sweeper that re-drives a
	// stalled storm.
	QueuePendingJoins(ctx context.Context, groupID id.ID, devices []id.ID, at int64) error
	ListPendingJoins(ctx context.Context, groupID id.ID, limit int32) ([]id.ID, error)
	DeletePendingJoins(ctx context.Context, groupID id.ID, devices []id.ID) error
	CountPendingJoins(ctx context.Context, groupID id.ID) (int64, error)
	ListPendingJoinGroups(ctx context.Context, after id.ID, limit int32) ([]id.ID, error)
}

// Messages is 005_messages.sql, implemented from task 23 onward.
type Messages interface {
	PutAppMessage(ctx context.Context, m AppMessageRow) error
	ListAppMessages(ctx context.Context, groupID id.ID, fromSeq uint64, limit int32) ([]AppMessageRow, error)
	GetAppMessage(ctx context.Context, groupID id.ID, seq uint64) (AppMessageRow, error)
	TombstoneAppMessage(ctx context.Context, groupID id.ID, seq uint64, at int64) error
	// PruneAppMessages applies invariant 10's TWO independent deletion triggers (R28/D14) in one
	// statement: delivery retention (`cursorFloor`, the lowest seq every ELIGIBLE device has
	// passed -- 0 meaning no eligible cursor exists and so no deletion -- or `deliveryFloor`,
	// now - MessageRetention) and archival retention (`expires` against `now`, where NULL means
	// retained indefinitely). Deviation D14: three parameters, not two, and `now` is not the
	// delivery floor. In the same transaction it raises the group's PrunedBelow to the highest
	// seq the DELIVERY triggers delete, so the high-water is exact for delivery retention. An
	// archival deletion never moves it (Plan 2 task 8's retention ruling): `expires` is not
	// monotone in seq, so a mark raised to an expired seq could stand above surviving messages
	// and turn a servable catch-up into E_PRUNED.
	PruneAppMessages(ctx context.Context, groupID id.ID, cursorFloor uint64, deliveryFloor, now int64) (int64, error)
	// RaisePrunedBelow raises the group's MONOTONE message high-water (`mls_groups.pruned_below`)
	// to `below`; a lower value is ignored. PruneAppMessages calls it itself with the exact seq it
	// deletes; it stays on the interface for a caller that must record a deletion it made some
	// other way.
	RaisePrunedBelow(ctx context.Context, groupID id.ID, below uint64) error
}

// Cursors is `device_cursors`, implemented from task 23 onward.
type Cursors interface {
	PutCursor(ctx context.Context, deviceID, groupID id.ID, lastSeq, lastEpoch uint64, at int64) error
	GetCursor(ctx context.Context, deviceID, groupID id.ID) (CursorRow, error)
	MinCursor(ctx context.Context, groupID id.ID, activeSince int64) (uint64, error) // eligible devices only
}

// Structure is 006_structure.sql and its successors, implemented from Plan 2
// task 1 onward. §4.1 declares it as one interface, but its tables land across
// six tasks (communities, members and roles in task 1; channels in 2;
// overwrites in 3; bans in 4; channel members in 6; voice sessions in 16), and
// ID1 forbids both stub methods and an embed whose methods do not exist yet. So
// the part task 1 ships is its own interface, Communities, which Structure
// embeds and Repository embeds on its own. Structure's method set is §4.1's
// plus the plan's additions; a later task that ships the rest of it either
// embeds its own slice the same way or, once every method exists, swaps
// Communities for Structure in Repository's embed list. Task 2's slice is
// Channels, task 3's Overwrites, task 4's Bans, task 6's ChannelMembers.
type Structure interface {
	Communities
	Channels
	Overwrites
	Bans
	ChannelMembers
	PutVoiceSession(ctx context.Context, v VoiceSessionRow) error
	EndVoiceSession(ctx context.Context, callID id.ID, at int64) error
}

// ChannelMembers is the part of Structure whose table is
// 00008_channel_members.sql (Plan 2 task 6): §4.1's three channel-member methods
// plus P2-D11's listing. For a DM or group DM the rows are the participant list;
// for a community channel they are what the permission resolver derives.
type ChannelMembers interface {
	// PutChannelMember is idempotent: a second call for the same pair keeps the
	// first row and its added time.
	PutChannelMember(ctx context.Context, channelID, userID id.ID, at int64) error
	// DeleteChannelMember answers ErrNotFound when the user was not a member.
	DeleteChannelMember(ctx context.Context, channelID, userID id.ID) error
	// ListChannelMembers is the channel's members ordered by user id, so the
	// order is the same on both engines.
	ListChannelMembers(ctx context.Context, channelID id.ID) ([]id.ID, error)
	// ListChannelsForUser is P2-D11: GET /v1/dms. The live DMs and group DMs the
	// user is a participant of, newest first, ties broken by channel id. A
	// community channel is never listed, whatever channel_members says.
	ListChannelsForUser(ctx context.Context, userID id.ID) ([]ChannelRow, error)
}

// Communities is the part of Structure whose tables are 00004_structure.sql:
// communities, members, roles and member_roles (Plan 2 task 1).
type Communities interface {
	CreateCommunity(ctx context.Context, c CommunityRow) error
	// GetCommunity answers ErrNotFound for a soft-deleted community too.
	GetCommunity(ctx context.Context, communityID id.ID) (CommunityRow, error)
	// UpdateCommunityPolicy writes the policy under version, which must be
	// greater than the stored one. The version is monotone, so a writer that
	// lost a race to the same successor gets ErrConflict rather than landing a
	// second policy under a number clients already hold. ErrNotFound is an
	// unknown or deleted community.
	UpdateCommunityPolicy(ctx context.Context, communityID id.ID, policy []byte, version int64) error
	// UpdateCommunityMeta and SoftDeleteCommunity are P2-D7: §4.3 declares
	// name, min_account_age_seconds, require_mod_2fa and deleted_at mutable and
	// §4.1 had no way to write them.
	UpdateCommunityMeta(ctx context.Context, communityID id.ID, name string, minAge uint64, requireMod2FA uint8) error
	SoftDeleteCommunity(ctx context.Context, communityID id.ID, at int64) error
	// LockCommunity is Plan 2 task 4 fix round 1: it holds the community row
	// until the transaction ends, so a join's ban check and member insert and a
	// ban's ban write and member delete serialise rather than interleave (a ban
	// landing between the check and the insert would leave a banned member).
	// Postgres takes SELECT ... FOR NO KEY UPDATE; a SQLite write transaction is
	// exclusive already. It is refused outside a Tx, where the lock would end
	// with the statement, and answers ErrNotFound for an unknown or deleted
	// community.
	LockCommunity(ctx context.Context, communityID id.ID) error
	// PutMember is an upsert: a second call rewrites the nick and nothing else.
	PutMember(ctx context.Context, m MemberOfCommunityRow) error
	// GetMember is P2-D7, every membership gate's read: ErrNotFound for a
	// non-member.
	GetMember(ctx context.Context, communityID, userID id.ID) (MemberOfCommunityRow, error)
	// DeleteMember drops the member's role grants with the row (member_roles
	// cascades), so a re-join does not resurrect them.
	DeleteMember(ctx context.Context, communityID, userID id.ID) error
	ListMembersOfCommunity(ctx context.Context, communityID, after id.ID, limit int32) ([]MemberOfCommunityRow, error)
	PutRole(ctx context.Context, r RoleRow) error
	// GetRole is P2-D9, written in task 1 because the role-grant route needs it.
	GetRole(ctx context.Context, roleID id.ID) (RoleRow, error)
	ListRoles(ctx context.Context, communityID id.ID) ([]RoleRow, error)
	// DeleteRole is P2-D9: DELETE /v1/roles/{id}. The role's grants go with it
	// (member_roles cascades). ErrNotFound is an unknown role or one of another
	// community.
	DeleteRole(ctx context.Context, communityID, roleID id.ID) error
	PutMemberRole(ctx context.Context, communityID, userID, roleID id.ID) error
	DeleteMemberRole(ctx context.Context, communityID, userID, roleID id.ID) error
	// ListMemberRoles is Plan 2's P2-D7b: GET /v1/communities/{id}/members must
	// list each member's roles and the permission resolver needs the set a user
	// holds, which deriving from ListRoles would make a full scan per member.
	ListMemberRoles(ctx context.Context, communityID, userID id.ID) ([]id.ID, error)
}

// Channels is the part of Structure whose table is 00005_channels.sql (Plan 2
// task 2): §4.1's five channel methods plus P2-D8's two.
type Channels interface {
	CreateChannel(ctx context.Context, c ChannelRow) error
	// GetChannel answers ErrNotFound for a deleted channel too.
	GetChannel(ctx context.Context, channelID id.ID) (ChannelRow, error)
	// ListChannels is the community's live channels ordered by position, ties
	// broken by id, so the order is the same on both engines and every call.
	ListChannels(ctx context.Context, communityID id.ID) ([]ChannelRow, error)
	// UpdateChannel writes mode, visibility, parent, name, topic, position,
	// settings, host policy version and slow mode. Kind, community, seq and
	// created are immutable here. ErrNotFound is an unknown or deleted channel.
	UpdateChannel(ctx context.Context, c ChannelRow) error
	// DeleteChannel tombstones the channel; a second call is ErrNotFound.
	DeleteChannel(ctx context.Context, channelID id.ID, at int64) error
	// DeleteChannelsOfCommunity (P2-D8) tombstones every live channel of the
	// community in one statement and returns how many it tombstoned.
	DeleteChannelsOfCommunity(ctx context.Context, communityID id.ID, at int64) (int64, error)
	// NextChannelSeq (P2-D8) is the per-channel sequencer: it raises
	// channels.seq by one and returns the new value. ErrNotFound is an unknown or
	// deleted channel.
	NextChannelSeq(ctx context.Context, channelID id.ID) (uint64, error)
}

// Overwrites is the part of Structure whose table is 00006_overwrites.sql (Plan
// 2 task 3): §4.1's two overwrite methods plus P2-D9's delete.
type Overwrites interface {
	// PutOverwrite is an upsert on (channel, target kind, target): a second
	// call replaces allow and deny.
	PutOverwrite(ctx context.Context, o OverwriteRow) error
	// ListOverwrites is the channel's overwrites ordered by (target_kind,
	// target_id), so the order is the same on both engines.
	ListOverwrites(ctx context.Context, channelID id.ID) ([]OverwriteRow, error)
	// DeleteOverwrite is P2-D9: DELETE /v1/channels/{id}/overwrites/{kind}/{target_id}.
	// ErrNotFound when there was no such overwrite.
	DeleteOverwrite(ctx context.Context, channelID id.ID, targetKind uint8, targetID id.ID) error
}

// Bans is the part of Structure whose table is 00007_bans.sql (Plan 2 task 4):
// §4.1's three ban methods plus P2-D10's listing.
type Bans interface {
	// PutBan is an upsert on (community, user): a second ban of the same user
	// replaces the reason, the moderator, the time and the expiry.
	PutBan(ctx context.Context, b BanRow) error
	// GetBan answers ErrNotFound when there is no row. A row whose Expires has
	// passed is still returned: whether it gates is the caller's decision.
	GetBan(ctx context.Context, communityID, userID id.ID) (BanRow, error)
	// ListBans is P2-D10: GET /v1/communities/{id}/bans. Newest first, ties
	// broken by user id, lapsed bans included.
	ListBans(ctx context.Context, communityID id.ID) ([]BanRow, error)
	// DeleteBan lifts a ban. ErrNotFound when there was none.
	DeleteBan(ctx context.Context, communityID, userID id.ID) error
}

// Readable is 007_readable.sql (migration 00009_readable.sql), implemented by
// Plan 2 task 8.
type Readable interface {
	// PutReadableMessage appends one message and returns its rowid. A second row
	// at the same (channel, seq) is ErrConflict.
	PutReadableMessage(ctx context.Context, m ReadableMessageRow) (int64, error)
	// ListReadableMessages is the channel's messages from fromSeq upward, at most
	// limit, deleted ones included (with an empty envelope and body).
	ListReadableMessages(ctx context.Context, channelID id.ID, fromSeq uint64, limit int32) ([]ReadableMessageRow, error)
	// EditReadableMessage is P2-D13: body is a parameter of its own, because
	// the indexed column cannot be filled from the envelope without the store
	// parsing envelopes, which is internal/api's job. ErrNotFound for an unknown
	// or deleted message.
	EditReadableMessage(ctx context.Context, channelID id.ID, seq uint64, envelope []byte, body string, at int64) error
	// DeleteReadableMessage empties the envelope and the body (so the row leaves
	// the index) and keeps the franking tuple. ErrNotFound for an unknown or an
	// already deleted message.
	DeleteReadableMessage(ctx context.Context, channelID id.ID, seq uint64, at int64) error
	// PutReadState is monotone: a lower lastReadSeq than the stored one is
	// ignored, so a stale tab cannot un-read a channel.
	PutReadState(ctx context.Context, userID, channelID id.ID, lastReadSeq uint64) error
	// GetReadState answers ErrNotFound when the user has never read the channel.
	GetReadState(ctx context.Context, userID, channelID id.ID) (uint64, error)
	// LastReadableMessageAt is the slowmode gate's read, added by Plan 2 task 8
	// beside P2-D13: the created time of userID's latest message in the channel,
	// deleted ones included (a delete must not reset the gate), or ErrNotFound.
	LastReadableMessageAt(ctx context.Context, channelID, userID id.ID) (int64, error)
	// ListReadableAudience is who a readable channel's message.plain frames
	// reach, added by Plan 2 task 8 (P2-D14's fan-out): the channel's
	// materialised channel_members that are still members of its community,
	// ordered by user id.
	ListReadableAudience(ctx context.Context, channelID id.ID) ([]id.ID, error)
	ReadableSearch
}

// ReadableSearch is hand-written database/sql per engine: sqlc can generate
// neither side, for opposite reasons (gap-69 claims 18 and 19).
type ReadableSearch interface {
	SearchReadable(ctx context.Context, q ReadableSearchQuery) ([]ReadableSearchHit, error)
}

// ReadableSearchQuery is one search. ChannelIDs is pre-filtered by the
// permission resolver and is never empty.
type ReadableSearchQuery struct {
	ChannelIDs []id.ID
	Query      ParsedQuery
	Limit      int32
	BeforeSeq  uint64
}

// ReadableSearchHit is one result row, snippet and score included, so the two
// engines' ts_headline and FTS5 snippet answers reach the API identically.
type ReadableSearchHit struct {
	ChannelID id.ID
	Seq       uint64
	Sender    id.ID
	Snippet   string
	Score     float32
	Created   int64
}

// Blobs is 008_blobs.sql, implemented from Plan 2 task 10 onward.
type Blobs interface {
	PutBlob(ctx context.Context, b BlobRow) error
	GetBlob(ctx context.Context, blobID []byte) (BlobRow, error)
	PutBlobRef(ctx context.Context, blobID []byte, channelID, uploaderDevice id.ID, mime string, created int64) error
	DeleteBlobRef(ctx context.Context, blobID []byte, channelID id.ID) error
	CountBlobRefs(ctx context.Context, blobID []byte) (int64, error)
	MarkBlobUnreferenced(ctx context.Context, blobID []byte, at int64) error
	ListCollectableBlobs(ctx context.Context, before int64, limit int32) ([]BlobRow, error)
	DeleteBlob(ctx context.Context, blobID []byte) error
	PutBlobTombstone(ctx context.Context, blobID []byte, reason string, by id.ID, at int64) error
	GetBlobTombstone(ctx context.Context, blobID []byte) (bool, error)
	UserBlobBytes(ctx context.Context, userID id.ID) (int64, error)
}

type Ops interface {
	PutReport(ctx context.Context, r ReportRow) error
	GetReport(ctx context.Context, reportID id.ID) (ReportRow, error)
	UpdateReportStatus(ctx context.Context, reportID id.ID, status int32, result string) error
	Audit(ctx context.Context, a AuditRow) error
	ListAudit(ctx context.Context, since int64, limit int32) ([]AuditRow, error)
	SchemaVersion(ctx context.Context) (int64, error)
}

// OpsBackups is §4.1's backup half of Ops. Its table is 008_blobs.sql, so
// Plan 2 task 10 implements it and adds it to Repository (deviation ID2).
type OpsBackups interface {
	PutBackup(ctx context.Context, b BackupRow) error
	ListBackups(ctx context.Context, userID id.ID, kind int32) ([]BackupRow, error)
}

// All thirteen sub-interfaces of §4.1 are declared above, as deviation ID1
// requires, and `Repository` embeds only the seven whose tables part 1a ships.
// Fix round 2 resolved the contradiction that left the last six undeclared: the
// same task must declare their Row types, because a Go interface method cannot
// name a type that does not exist. Those types are in rows.go, mirrored from
// §4.3, and `ParsedQuery`/`Term` — §6.7's engine-neutral parse, which
// `ReadableSearchQuery` names — are declared there too, without the parser
// functions Plan 2 task 8 brings. Each later task that satisfies one of the six
// edits only the embed list: task 19 (MLS), task 23 (Messages, Cursors) and Plan
// 2's tasks 1, 8 and 10 (Structure, Readable, Blobs with OpsBackups). Plan 2
// task 1 embeds Communities, the slice of Structure its tables support; see
// Structure's comment for why Structure itself cannot be embedded yet.
// contract_test.go holds §4.1 as an assertion so a rename is a test failure.
