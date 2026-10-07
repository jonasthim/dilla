package store_test

import (
	"reflect"
	"slices"
	"testing"

	"github.com/jonasthim/dilla/internal/store"
)

// interfaces.md §4.1 fixes the thirteen sub-interfaces of store.Repository and
// every method name on them, and the plan's deviation ID1 requires all thirteen
// to be DECLARED here in task 3 even though Repository only embeds the seven
// whose tables part 1a ships: "the declarations are unchanged, so no later task
// renames a method; only the one embed list grows". A declaration is the only
// thing that makes that promise enforceable, so this test is §4.1 written out as
// an assertion — a later task that misspells `ListMembersOfCommunity` or quietly
// drops `PurgeKeyPackages` fails here rather than in a merge conflict between
// two plans.
//
// The lists are the method NAMES only; the signatures are enforced by the
// compiler through the interface declarations themselves, and by the
// `var _ store.Repository` assertions in each adapter.
func TestSubInterfacesMatchTheContract(t *testing.T) {
	cases := []struct {
		name    string
		typ     reflect.Type
		methods []string
	}{
		{"Instance", reflect.TypeOf((*store.Instance)(nil)).Elem(), []string{
			"BumpGeneration", "CreateInstance", "GetInstance", "GetSetting", "PutSetting",
			// SetGeneration is §4.1 plus one (deviation ID1, task 27): invariant 11's
			// `dillad restore` names the generation it read out of the backup's
			// manifest, and a blind `BumpGeneration` would silently disregard it.
			"SetGeneration",
		}},
		{"Accounts", reflect.TypeOf((*store.Accounts)(nil)).Elem(), []string{
			"CreateUser", "GetUser", "GetUserByUsername", "ListUsers", "SetUserDisabled",
			"TombstoneUser",
		}},
		{"Devices", reflect.TypeOf((*store.Devices)(nil)).Elem(), []string{
			"CreateDevice", "GetDevice", "GetDeviceList", "ListDevicesByUser", "PutDeviceList",
			"RevokeDevice", "TouchDevice",
			// dilla-web-2a task 5 (L-SQL-21): the device-list history read (L-HTTP-56) and the
			// per-user device cap and enrolment rate (L-HTTP-54, Q04).
			"CountLiveDevicesByUser", "ListDeviceCreationsSince", "ListDeviceListsAfter",
			"LockUserForDeviceRegistration", "CountLiveUnlistedDevicesByUser", "ListLiveDeviceCreationsSince",
		}},
		{"Sessions", reflect.TypeOf((*store.Sessions)(nil)).Elem(), []string{
			"CountSessionsByDevice", "CreateSession", "DeleteOldestSessionForDevice",
			"DeleteSession", "DeleteSessionsByDevice", "DeleteSessionsByUser",
			"GetSessionByHash", "PruneSessions", "TouchSession",
		}},
		{"Auth", reflect.TypeOf((*store.Auth)(nil)).Elem(), []string{
			"ClearLoginFailures", "ConsumeRecoveryCode", "ConsumeTOTPCounter",
			"CountLoginFailures", "CountRecoveryCodes", "GetOIDCIdentity",
			"GetPasswordCredential", "GetTOTP", "GetWebauthnCredential",
			"GetWebauthnUserByHandle", "GetWebauthnUserHandle", "ListWebauthnCredentials",
			"PruneCeremonies", "PutCeremony", "PutOIDCIdentity", "PutPasswordCredential",
			"PutRecoveryCodes", "PutTOTP", "PutWebauthnCredential", "PutWebauthnUser",
			"RecordLoginAttempt", "TakeCeremony", "UpdateWebauthnCredential",
		}},
		{"Invites", reflect.TypeOf((*store.Invites)(nil)).Elem(), []string{
			"CreateInvite", "GetInviteByHash", "ListInvites", "RedeemInvite", "RevokeInvite",
		}},
		{"MLS", reflect.TypeOf((*store.MLS)(nil)).Elem(), []string{
			"AppendHandshake",
			// ClearEpochUnknown, EndAllVoiceSessions and MarkAllGroupsEpochUnknown are
			// §4.1 plus three (deviation ID1 with B13, task 27): invariant 11's restore
			// and heal. Plan 2 records the marking and the call-ending as P2-D19 for the
			// same work, so both plans name ONE method set rather than two.
			"ClearEpochUnknown",
			"CloseGroup", "CountForkReporters", "CountKeyPackages",
			"CreateGroup", "DeleteProposals", "DeleteWelcome", "EndAllVoiceSessions",
			"GetCommitAtEpoch", "GetGroup",
			"GroupsForDevice",
			// GroupsForTarget is Plan 2's P2-D3 (task 4): the open groups bound to one
			// channel, so a membership change finds the groups to issue Removes in
			// without scanning every open group of the instance.
			"GroupsForTarget",
			"MarkAllGroupsEpochUnknown",
			// ListGroupsForRetention is §4.1 plus one (deviation ID1, task 26 fix round 1):
			// invariant 10's sweep must reach CLOSED groups too, and `ListOpenGroups` --
			// the walk §4.1 names -- filters exactly those out, so a closed group's
			// ciphertext would never be swept by either half of retention again.
			"ListGroupsForRetention",
			"ListHandshakes", "ListMembers", "ListOpenGroups", "ListProposals", "ListWelcomes",
			"NextSeq", "OldestHandshakeSeq", "PruneHandshakes", "PruneWelcomes",
			"PurgeKeyPackages", "PutEpochTree", "PutForkReport", "PutGroupState",
			"PutKeyPackages", "PutProposal", "PutWelcomePayload", "PutWelcomes",
			"QuarantineDevice", "ReissueProposal", "ReplaceMembers", "TakeKeyPackage",
			"VoidProposal",
			// ListBarredMembers is the reconcile sweeper's backstop for the Removes quarantined and
			// revoked devices are owed (DS server-half re-review, R-2): one query per group.
			"ListBarredMembers",
			// DeleteKeyPackage is the hardening-C follow-up's: ProposeAdd deletes a directory
			// package that is not bound to its device (one stored before uploads were bound)
			// instead of proposing it, and a last-resort package has no other way out.
			"DeleteKeyPackage",
			// The pending-join queue: deviation B13 names QueuePendingJoins/TakePendingJoins,
			// and Plan 2 task 7 (Plan 1 follow-up card 8) lands them with the length its tests
			// and the debug state read and the paged walk the sweeper re-drives a stalled
			// storm from. Its fix round 1 splits the take into a read and a delete, so a
			// device leaves the queue only once the drain has resolved it.
			"CountPendingJoins", "DeletePendingJoins", "ListPendingJoinGroups",
			"ListPendingJoins", "QueuePendingJoins",
		}},
		{"Messages", reflect.TypeOf((*store.Messages)(nil)).Elem(), []string{
			"GetAppMessage", "ListAppMessages", "PruneAppMessages", "PutAppMessage",
			// RaisePrunedBelow is §4.1 plus one (deviation ID1, task 26 fix round 2):
			// `PruneAppMessages` deletes at a cursor floor that nothing can reconstruct
			// afterwards -- a device has no `device_cursors` row until its first cursor
			// write, and an idle one re-enters `MinCursor` at the low seq it left off at --
			// so the floor is recorded on the group as it is used. Without it the catch-up
			// predicate answers "nothing is gone" about rows deleted minutes earlier.
			"RaisePrunedBelow",
			"TombstoneAppMessage",
		}},
		{"Cursors", reflect.TypeOf((*store.Cursors)(nil)).Elem(), []string{
			"GetCursor", "MinCursor", "PutCursor",
		}},
		{"Structure", reflect.TypeOf((*store.Structure)(nil)).Elem(), []string{
			"CreateChannel", "CreateCommunity", "DeleteBan", "DeleteChannel",
			"DeleteChannelMember", "DeleteMember", "DeleteMemberRole", "EndVoiceSession",
			"GetBan", "GetChannel", "GetCommunity", "ListChannelMembers", "ListChannels",
			"ListMemberRoles", "ListMembersOfCommunity", "ListOverwrites", "ListRoles",
			"PutBan", "PutChannelMember", "PutMember", "PutMemberRole", "PutOverwrite",
			"PutRole", "PutVoiceSession", "UpdateChannel", "UpdateCommunityPolicy",
			// §4.1 plus four, all reached through the embedded Communities: GetMember,
			// UpdateCommunityMeta and SoftDeleteCommunity are Plan 2's P2-D7, GetRole
			// is P2-D9 (task 3's, written in task 1 for the role-grant route).
			"GetMember", "GetRole", "SoftDeleteCommunity", "UpdateCommunityMeta",
			// §4.1 plus two more, reached through the embedded Channels: P2-D8's
			// one-statement community tombstone and per-channel sequencer.
			"DeleteChannelsOfCommunity", "NextChannelSeq",
			// §4.1 plus P2-D9's two deletes (task 3), reached through the embedded
			// Communities (DeleteRole) and Overwrites (DeleteOverwrite).
			"DeleteOverwrite", "DeleteRole",
			// Fix wave I2, reached through the embedded Overwrites.
			"DeleteUserOverwrites",
			// §4.1 plus P2-D10's listing (task 4), reached through the embedded Bans.
			"ListBans",
			// Task 4 fix round 1, reached through the embedded Communities: the
			// community row lock that serialises a join's ban check with a ban.
			"LockCommunity",
			// §4.1 plus P2-D11's listing (task 6), reached through the embedded
			// ChannelMembers: GET /v1/dms.
			"ListChannelsForUser",
			// Plan 2 task 14: `dillad admin community list`, reached through the
			// embedded Communities.
			"ListCommunities",
			// dilla-web-1 task 8 (L-SQL-02): GET /v1/communities, reached through the embedded
			// Communities.
			"ListCommunitiesForUser",
			// §4.1 plus P2-D22's GetVoiceSession and the live-call listing POST
			// /v1/channels/{id}/calls joins through (task 16), reached through the
			// embedded VoiceSessions.
			"GetVoiceSession", "ListLiveVoiceSessions",
			// Fix wave C3, reached through the embedded ChannelMembers: a kick, ban or
			// leave drops the user's rows for the community's channels.
			"DeleteCommunityChannelMembers",
		}},
		// VoiceSessions is the slice of Structure Plan 2 task 16's table supports.
		{"VoiceSessions", reflect.TypeOf((*store.VoiceSessions)(nil)).Elem(), []string{
			"EndVoiceSession", "GetVoiceSession", "ListLiveVoiceSessions", "PutVoiceSession",
		}},
		// ChannelMembers is the slice of Structure Plan 2 task 6's table supports.
		{"ChannelMembers", reflect.TypeOf((*store.ChannelMembers)(nil)).Elem(), []string{
			"DeleteChannelMember", "DeleteCommunityChannelMembers", "ListChannelMembers",
			"ListChannelsForUser", "PutChannelMember",
		}},
		// Bans is the slice of Structure Plan 2 task 4's table supports.
		{"Bans", reflect.TypeOf((*store.Bans)(nil)).Elem(), []string{
			"DeleteBan", "GetBan", "ListBans", "PutBan",
		}},
		// Overwrites is the slice of Structure Plan 2 task 3's table supports.
		{"Overwrites", reflect.TypeOf((*store.Overwrites)(nil)).Elem(), []string{
			"DeleteOverwrite", "DeleteUserOverwrites", "ListOverwrites", "PutOverwrite",
		}},
		// Channels is the slice of Structure Plan 2 task 2's table supports.
		{"Channels", reflect.TypeOf((*store.Channels)(nil)).Elem(), []string{
			"CreateChannel", "DeleteChannel", "DeleteChannelsOfCommunity", "GetChannel",
			"ListChannels", "NextChannelSeq", "UpdateChannel",
		}},
		// Communities is the slice of Structure Plan 2 task 1's tables support; it
		// is what Repository embeds until the rest of Structure exists (P2-D23).
		{"Communities", reflect.TypeOf((*store.Communities)(nil)).Elem(), []string{
			"CreateCommunity", "DeleteMember", "DeleteMemberRole", "DeleteRole", "GetCommunity",
			"GetMember", "GetRole", "ListCommunities", "ListCommunitiesForUser", "ListMemberRoles",
			"ListMembersOfCommunity",
			"ListRoles", "LockCommunity", "PutMember", "PutMemberRole", "PutRole", "SoftDeleteCommunity",
			"UpdateCommunityMeta", "UpdateCommunityPolicy",
		}},
		{"ReadableSearch", reflect.TypeOf((*store.ReadableSearch)(nil)).Elem(), []string{
			"SearchReadable",
		}},
		// Readable embeds ReadableSearch, so SearchReadable is in its method set.
		{"Readable", reflect.TypeOf((*store.Readable)(nil)).Elem(), []string{
			"DeleteReadableMessage", "EditReadableMessage", "GetReadState",
			"ListReadableMessages", "PutReadState", "PutReadableMessage", "SearchReadable",
			// §4.1 plus two (Plan 2 task 8, recorded beside P2-D13): the slowmode
			// gate's read and the message.plain fan-out audience (P2-D14).
			"LastReadableMessageAt", "ListReadableAudience",
		}},
		{"Blobs", reflect.TypeOf((*store.Blobs)(nil)).Elem(), []string{
			"CountBlobRefs", "DeleteBlob", "DeleteBlobRef", "GetBlob", "GetBlobTombstone",
			"ListCollectableBlobs", "MarkBlobUnreferenced", "PutBlob", "PutBlobRef",
			"PutBlobTombstone", "UserBlobBytes", "UserReferencesBlob",
			// Fix wave C7: blobs.store_max_bytes.
			"InstanceBlobBytes",
			// Plan 2 task 10: P2-D16's ClearBlobUnreferenced, and P2-D17's
			// GetBlobRef, which the GET's "404 without a reference here" rule needs.
			"ClearBlobUnreferenced", "GetBlobRef",
			// Plan 2 task 11: P2-D18's DeleteAllBlobRefs for the admin purge, and
			// the three reads the sweeper's reference-expiry phase needs (the
			// community retention policy, R28, and deleted channels).
			"DeleteAllBlobRefs", "ListBlobRetentionPolicies", "ListExpiredBlobRefs",
			"ListBlobRefsOfDeletedChannels",
			// Plan 2 task 12: the backup walks every blob row in blob_id order.
			"ListBlobs",
			// dilla-web-2b task 4 (L-SQL-31): pending references, their confirm and the pending sweep.
			"ConfirmBlobRef", "ListPendingBlobRefs", "PutPendingBlobRef",
		}},
		{"Ops", reflect.TypeOf((*store.Ops)(nil)).Elem(), []string{
			"Audit", "GetReport", "ListAudit", "PutReport", "SchemaVersion",
			"UpdateReportStatus",
			// Plan 2 task 17: the report queue.
			"ListReports",
		}},
		// OpsBackups is §4.1's backup half of Ops, split out by deviation ID2
		// because `backups` is 008_blobs.sql's table.
		{"OpsBackups", reflect.TypeOf((*store.OpsBackups)(nil)).Elem(), []string{
			"ListBackups", "PutBackup",
			// dilla-web-2a task 5 (L-SQL-21): the write-once root object (F3, Q27), the single-row
			// read of the backup routes and the reference check the state replacement marks by.
			"BackupRefersToBlob", "GetBackup", "InsertBackup",
			// Branch review BACKUPS-RECOVERY-05: the per-blob lock that keeps backup objects and
			// attachments disjoint under concurrency.
			"LockBlob",
		}},
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := make([]string, 0, c.typ.NumMethod())
			for i := range c.typ.NumMethod() {
				got = append(got, c.typ.Method(i).Name)
			}
			want := slices.Clone(c.methods)
			slices.Sort(want)
			if !slices.Equal(got, want) {
				t.Fatalf("%s methods:\n got %v\nwant %v", c.name, got, want)
			}
		})
	}
}

// ID1's other half: Repository embeds only the seven sub-interfaces whose tables
// part 1a ships, plus the ones later tasks add. Each later task that satisfies
// one of the remaining interfaces owes an
// explicit numbered step that edits this embed list — task 19 (MLS), task 23
// (Messages, Cursors), Plan 2 task 1 (Communities, Structure's first slice), Plan 2 task 8 (Readable) and
// Plan 2 task 10 (Blobs, OpsBackups) — so this test moves with them, and a
// premature embed (which would stop both adapters compiling) is caught here.
func TestRepositoryEmbedsOnlyThe1aSubInterfaces(t *testing.T) {
	repo := reflect.TypeOf((*store.Repository)(nil)).Elem()
	got := make([]string, 0, repo.NumMethod())
	for i := range repo.NumMethod() {
		got = append(got, repo.Method(i).Name)
	}

	want := []string{"Close", "Tx"}
	for _, embedded := range []reflect.Type{
		reflect.TypeOf((*store.Instance)(nil)).Elem(),
		reflect.TypeOf((*store.Accounts)(nil)).Elem(),
		reflect.TypeOf((*store.Devices)(nil)).Elem(),
		reflect.TypeOf((*store.Sessions)(nil)).Elem(),
		reflect.TypeOf((*store.Auth)(nil)).Elem(),
		reflect.TypeOf((*store.Invites)(nil)).Elem(),
		reflect.TypeOf((*store.Ops)(nil)).Elem(),
		// Task 19 step 1a: MLS joins the embed list with 00002_mls.sql.
		reflect.TypeOf((*store.MLS)(nil)).Elem(),
		// Task 23 step 1a: Messages joins with 00003_messages.sql, and Cursors
		// with the queries that satisfy it — ID1's rule is that the embed lands
		// with the methods, not with the DDL, and `device_cursors` shipped in
		// 00002_mls.sql a task earlier.
		reflect.TypeOf((*store.Messages)(nil)).Elem(),
		reflect.TypeOf((*store.Cursors)(nil)).Elem(),
		// Plan 2 task 1 step 9: Communities joins with 00004_structure.sql. It is
		// the slice of Structure whose tables exist; the rest of Structure (channels,
		// overwrites, bans, channel members, voice sessions) lands with its tables.
		reflect.TypeOf((*store.Communities)(nil)).Elem(),
		// Plan 2 task 2: Channels joins with 00005_channels.sql.
		reflect.TypeOf((*store.Channels)(nil)).Elem(),
		// Plan 2 task 3: Overwrites joins with 00006_overwrites.sql.
		reflect.TypeOf((*store.Overwrites)(nil)).Elem(),
		// Plan 2 task 4: Bans joins with 00007_bans.sql.
		reflect.TypeOf((*store.Bans)(nil)).Elem(),
		// Plan 2 task 6: ChannelMembers joins with 00008_channel_members.sql.
		reflect.TypeOf((*store.ChannelMembers)(nil)).Elem(),
		// Plan 2 task 8: Readable joins with 00009_readable.sql.
		reflect.TypeOf((*store.Readable)(nil)).Elem(),
		// Plan 2 task 10: Blobs and OpsBackups join with 00010_blobs.sql (P2-D5).
		reflect.TypeOf((*store.Blobs)(nil)).Elem(),
		reflect.TypeOf((*store.OpsBackups)(nil)).Elem(),
		// Plan 2 task 16: VoiceSessions joins with 00011_voice.sql (P2-D22).
		reflect.TypeOf((*store.VoiceSessions)(nil)).Elem(),
	} {
		for i := range embedded.NumMethod() {
			want = append(want, embedded.Method(i).Name)
		}
	}
	slices.Sort(want)
	if !slices.Equal(got, want) {
		t.Fatalf("Repository methods:\n got %v\nwant %v", got, want)
	}
}

// The Row types the six deferred interfaces name must exist, or the interfaces
// cannot be declared at all — that is the contradiction fix round 2 resolves in
// favour of §4.1 and ID1. Each is asserted to be a struct here so a later task
// that ships the table finds a shape to fill rather than a name to invent.
func TestDeferredRowTypesAreDeclared(t *testing.T) {
	rows := map[string]any{
		"GroupRow":             store.GroupRow{},
		"HandshakeRow":         store.HandshakeRow{},
		"ProposalRow":          store.ProposalRow{},
		"MemberRow":            store.MemberRow{},
		"KeyPackageRow":        store.KeyPackageRow{},
		"WelcomePayloadRow":    store.WelcomePayloadRow{},
		"EpochTreeRow":         store.EpochTreeRow{},
		"WelcomeRow":           store.WelcomeRow{},
		"WelcomeFull":          store.WelcomeFull{},
		"ForkReportRow":        store.ForkReportRow{},
		"AppMessageRow":        store.AppMessageRow{},
		"CursorRow":            store.CursorRow{},
		"CommunityRow":         store.CommunityRow{},
		"MemberOfCommunityRow": store.MemberOfCommunityRow{},
		"ChannelRow":           store.ChannelRow{},
		"RoleRow":              store.RoleRow{},
		"OverwriteRow":         store.OverwriteRow{},
		"BanRow":               store.BanRow{},
		"VoiceSessionRow":      store.VoiceSessionRow{},
		"ReadableMessageRow":   store.ReadableMessageRow{},
		"BlobRow":              store.BlobRow{},
		"BlobRefRow":           store.BlobRefRow{},
		"BlobRetentionRow":     store.BlobRetentionRow{},
		"BackupRow":            store.BackupRow{},
		"ReadableSearchQuery":  store.ReadableSearchQuery{},
		"ReadableSearchHit":    store.ReadableSearchHit{},
		"ParsedQuery":          store.ParsedQuery{},
		"Term":                 store.Term{},
	}
	for name, v := range rows {
		if k := reflect.TypeOf(v).Kind(); k != reflect.Struct {
			t.Errorf("%s is a %s, want a struct", name, k)
		}
	}
	// WelcomeFull is the join `ListWelcomes` returns: the welcome row plus the
	// payload it points at, which lives in a second table (D4's three-table
	// split). Nothing else in §4.1 names both halves, so the embedding is what
	// keeps the two in step.
	full := reflect.TypeOf(store.WelcomeFull{})
	if _, ok := full.FieldByName("WelcomeRow"); !ok {
		t.Error("WelcomeFull does not embed WelcomeRow")
	}
	if _, ok := full.FieldByName("Blob"); !ok {
		t.Error("WelcomeFull carries no Blob")
	}
}
