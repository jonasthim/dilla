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
// Cursors with 00003_messages.sql, Plan 2 task 1 step 9 adds Structure, and
// Plan 2's tasks 8 and 10 add Readable, Blobs and OpsBackups.
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
	MLS      // task 19 step 1a — 00002_mls.sql
	Messages // added HERE — ID1; its table is 00003_messages.sql, written in step 1
	Cursors  // added HERE — ID1; device_cursors ships with 00002_mls.sql, its queries here
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
	PruneHandshakes(ctx context.Context, before int64) (int64, error)
	PutProposal(ctx context.Context, p ProposalRow) error
	ListProposals(ctx context.Context, groupID id.ID, epoch uint64, includeVoid bool) ([]ProposalRow, error)
	VoidProposal(ctx context.Context, groupID id.ID, ref []byte, at int64) error
	DeleteProposals(ctx context.Context, groupID id.ID, refs [][]byte) error
	ReissueProposal(ctx context.Context, oldRef []byte, p ProposalRow) error // keeps action_id
	ReplaceMembers(ctx context.Context, groupID id.ID, epoch uint64, m []MemberRow) error
	ListMembers(ctx context.Context, groupID id.ID) ([]MemberRow, error)
	GroupsForDevice(ctx context.Context, deviceID id.ID) ([]id.ID, error)
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
	// delivery floor.
	PruneAppMessages(ctx context.Context, groupID id.ID, cursorFloor uint64, deliveryFloor, now int64) (int64, error)
	// RaisePrunedBelow records the cursor floor `PruneAppMessages` was just called with, as a
	// MONOTONE high-water on the group (`mls_groups.pruned_below`): the highest seq at or below
	// which application ciphertext may already be gone. A lower value is ignored.
	//
	// The catch-up predicate needs the floor that was IN FORCE WHEN THE ROWS WENT, and that is not
	// `MinCursor` read again later: a device has no `device_cursors` row until its first cursor
	// write, so a member quiet during the sweep is absent from the aggregate and pulls it back
	// down the moment it speaks -- and a returning 90-day-idle device does the same. Recomputing
	// would answer "nothing is gone" about messages deleted minutes earlier.
	RaisePrunedBelow(ctx context.Context, groupID id.ID, below uint64) error
}

// Cursors is `device_cursors`, implemented from task 23 onward.
type Cursors interface {
	PutCursor(ctx context.Context, deviceID, groupID id.ID, lastSeq, lastEpoch uint64, at int64) error
	GetCursor(ctx context.Context, deviceID, groupID id.ID) (CursorRow, error)
	MinCursor(ctx context.Context, groupID id.ID, activeSince int64) (uint64, error) // eligible devices only
}

// Structure is 006_structure.sql, implemented from Plan 2 task 1 onward.
type Structure interface {
	CreateCommunity(ctx context.Context, c CommunityRow) error
	GetCommunity(ctx context.Context, communityID id.ID) (CommunityRow, error)
	UpdateCommunityPolicy(ctx context.Context, communityID id.ID, policy []byte, version int64) error
	PutMember(ctx context.Context, m MemberOfCommunityRow) error
	DeleteMember(ctx context.Context, communityID, userID id.ID) error
	ListMembersOfCommunity(ctx context.Context, communityID, after id.ID, limit int32) ([]MemberOfCommunityRow, error)
	CreateChannel(ctx context.Context, c ChannelRow) error
	GetChannel(ctx context.Context, channelID id.ID) (ChannelRow, error)
	ListChannels(ctx context.Context, communityID id.ID) ([]ChannelRow, error)
	UpdateChannel(ctx context.Context, c ChannelRow) error
	DeleteChannel(ctx context.Context, channelID id.ID, at int64) error
	PutRole(ctx context.Context, r RoleRow) error
	ListRoles(ctx context.Context, communityID id.ID) ([]RoleRow, error)
	PutMemberRole(ctx context.Context, communityID, userID, roleID id.ID) error
	DeleteMemberRole(ctx context.Context, communityID, userID, roleID id.ID) error
	// ListMemberRoles is Plan 2's P2-D7b: GET /v1/communities/{id}/members must
	// list each member's roles and the permission resolver needs the set a user
	// holds, which deriving from ListRoles would make a full scan per member.
	ListMemberRoles(ctx context.Context, communityID, userID id.ID) ([]id.ID, error)
	PutOverwrite(ctx context.Context, o OverwriteRow) error
	ListOverwrites(ctx context.Context, channelID id.ID) ([]OverwriteRow, error)
	PutChannelMember(ctx context.Context, channelID, userID id.ID, at int64) error
	DeleteChannelMember(ctx context.Context, channelID, userID id.ID) error
	ListChannelMembers(ctx context.Context, channelID id.ID) ([]id.ID, error)
	PutBan(ctx context.Context, b BanRow) error
	GetBan(ctx context.Context, communityID, userID id.ID) (BanRow, error)
	DeleteBan(ctx context.Context, communityID, userID id.ID) error
	PutVoiceSession(ctx context.Context, v VoiceSessionRow) error
	EndVoiceSession(ctx context.Context, callID id.ID, at int64) error
}

// Readable is 007_readable.sql, implemented from Plan 2 task 8 onward.
type Readable interface {
	PutReadableMessage(ctx context.Context, m ReadableMessageRow) (int64, error)
	ListReadableMessages(ctx context.Context, channelID id.ID, fromSeq uint64, limit int32) ([]ReadableMessageRow, error)
	EditReadableMessage(ctx context.Context, channelID id.ID, seq uint64, envelope []byte, at int64) error
	DeleteReadableMessage(ctx context.Context, channelID id.ID, seq uint64, at int64) error
	PutReadState(ctx context.Context, userID, channelID id.ID, lastReadSeq uint64) error
	GetReadState(ctx context.Context, userID, channelID id.ID) (uint64, error)
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
// 2's tasks 1, 8 and 10 (Structure, Readable, Blobs with OpsBackups).
// contract_test.go holds §4.1 as an assertion so a rename is a test failure.
