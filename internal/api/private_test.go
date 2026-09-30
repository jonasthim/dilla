package api_test

import (
	"bytes"
	"fmt"
	"log/slog"
	"net/http"
	"slices"
	"testing"

	"github.com/jonasthim/dilla/internal/api"
	"github.com/jonasthim/dilla/internal/id"
	"github.com/jonasthim/dilla/internal/store"
)

// seedCommunityOfSize creates n members, each with one device holding one
// KeyPackage, all holding the named role.
func seedCommunityOfSize(t *testing.T, e *env, cid id.ID, ownerTok string, role id.ID, n int) []id.ID {
	t.Helper()
	users := make([]id.ID, 0, n)
	for i := range n {
		u, tok := e.NewUser(fmt.Sprintf("m%04d", i))
		joinCommunity(t, e, cid, tok)
		grant(t, e, cid, ownerTok, u, role, http.StatusNoContent)
		for _, dev := range seedDevices(t, e, u, 1) {
			seedKeyPackage(t, e, dev)
		}
		users = append(users, u)
	}
	return users
}

// devicesOf is every device of user, in the order ListDevicesByUser returns them.
func devicesOf(t *testing.T, e *env, user id.ID) []id.ID {
	t.Helper()
	rows, err := e.Repo.ListDevicesByUser(t.Context(), user)
	if err != nil {
		t.Fatalf("ListDevicesByUser: %v", err)
	}
	out := make([]id.ID, 0, len(rows))
	for _, r := range rows {
		out = append(out, r.ID)
	}
	return out
}

func TestAPrivateChannelInA1000MemberCommunityBatchesAt256(t *testing.T) {
	e, cid, ownerTok := channelEnv(t)
	api.NewRoles(e.Repo, e.Clk, "dilla.example", slog.New(slog.DiscardHandler)).Register(e.Mux)
	dsvc := &recordingDS{}

	role := createRole(t, e, cid, ownerTok, "insiders", 10, api.PermViewChannel|api.PermSendMessages)
	seedCommunityOfSize(t, e, cid, ownerTok, role, 1000)

	ch, _, _ := newChannel(t, e, cid, ownerTok, 0, 0, 0, "secret")
	if status, _ := e.Do(http.MethodPut,
		"/v1/channels/"+ch.String()+"/overwrites/0/"+role.String(), ownerTok,
		[]any{uint64(api.PermViewChannel), uint64(0)}); status != http.StatusNoContent {
		t.Fatal("PUT role overwrite failed")
	}
	group := seedTextGroup(t, e, ch, cid)

	if err := api.MaterialiseChannelMembers(t.Context(), e.Repo, dsvc,
		mustChannel(t, e, ch), e.Clk.Now().Unix()); err != nil {
		t.Fatalf("MaterialiseChannelMembers: %v", err)
	}

	members, err := e.Repo.ListChannelMembers(t.Context(), ch)
	if err != nil {
		t.Fatalf("ListChannelMembers: %v", err)
	}
	if len(members) != 1001 { // 1000 plus the owner
		t.Fatalf("channel_members = %d, want 1001", len(members))
	}
	// 1000, not 1001: channel_members holds the owner too, but channelEnv's owner
	// device published no KeyPackage, and SyncGroupMembers skips any device with
	// CountKeyPackages == 0 because the delivery service would refuse the Add and
	// the election round would be wasted. The assertion below states that rule
	// rather than hiding it behind an off-by-one.
	if len(dsvc.Adds) != 1000 {
		t.Fatalf("Adds = %d, want 1000", len(dsvc.Adds))
	}
	ownerDevices := devicesOf(t, e, ownerOf(t, e, cid))
	for _, a := range dsvc.Adds {
		if a.Group != group {
			t.Fatalf("Add on %s, want %s", a.Group, group)
		}
		if slices.Contains(ownerDevices, a.Device) {
			t.Fatal("the owner's device was proposed although it published no KeyPackage")
		}
	}
	if dsvc.Commits != 4 {
		t.Fatalf("commit requests = %d; 1000 devices at 256 per commit is 4", dsvc.Commits)
	}
}

func TestARoleGrantThatOpensTheChannelTo300MoreBatchesTheSameWay(t *testing.T) {
	e, cid, ownerTok := channelEnv(t)
	api.NewRoles(e.Repo, e.Clk, "dilla.example", slog.New(slog.DiscardHandler)).Register(e.Mux)
	dsvc := &recordingDS{}
	role := createRole(t, e, cid, ownerTok, "insiders", 10, api.PermViewChannel)
	ch, _, _ := newChannel(t, e, cid, ownerTok, 0, 0, 0, "secret")
	if status, _ := e.Do(http.MethodPut,
		"/v1/channels/"+ch.String()+"/overwrites/0/"+role.String(), ownerTok,
		[]any{uint64(api.PermViewChannel), uint64(0)}); status != http.StatusNoContent {
		t.Fatal("PUT role overwrite failed")
	}
	seedTextGroup(t, e, ch, cid)
	if err := api.MaterialiseChannelMembers(t.Context(), e.Repo, dsvc, mustChannel(t, e, ch), e.Clk.Now().Unix()); err != nil {
		t.Fatalf("first materialise: %v", err)
	}
	dsvc.Reset()

	seedCommunityOfSize(t, e, cid, ownerTok, role, 300)
	if err := api.MaterialiseChannelMembers(t.Context(), e.Repo, dsvc, mustChannel(t, e, ch), e.Clk.Now().Unix()); err != nil {
		t.Fatalf("second materialise: %v", err)
	}
	if len(dsvc.Adds) != 300 {
		t.Fatalf("Adds = %d, want 300", len(dsvc.Adds))
	}
	if dsvc.Commits != 2 {
		t.Fatalf("commit requests = %d, want 2", dsvc.Commits)
	}
}

func TestAMemberRemovedMidBatchIsDroppedFromTheRest(t *testing.T) {
	e, cid, ownerTok := channelEnv(t)
	api.NewRoles(e.Repo, e.Clk, "dilla.example", slog.New(slog.DiscardHandler)).Register(e.Mux)
	role := createRole(t, e, cid, ownerTok, "insiders", 10, api.PermViewChannel)
	users := seedCommunityOfSize(t, e, cid, ownerTok, role, 300)
	ch, _, _ := newChannel(t, e, cid, ownerTok, 0, 0, 0, "secret")
	if status, _ := e.Do(http.MethodPut,
		"/v1/channels/"+ch.String()+"/overwrites/0/"+role.String(), ownerTok,
		[]any{uint64(api.PermViewChannel), uint64(0)}); status != http.StatusNoContent {
		t.Fatal("PUT role overwrite failed")
	}
	seedTextGroup(t, e, ch, cid)

	// The victim must be in the LAST batch, or the test is a coin flip: batch
	// membership follows ListChannelMembers order, which is user_id order over 16
	// random bytes, so users[len(users)-1] (creation order) lands in the first 256
	// of 300 about 85% of the time and is already added before OnCommit fires.
	// The member whose user_id sorts last is in the final batch by construction.
	victim := slices.MaxFunc(users, func(a, b id.ID) int { return bytes.Compare(a[:], b[:]) })
	first := slices.MinFunc(users, func(a, b id.ID) int { return bytes.Compare(a[:], b[:]) })
	dsvc := &recordingDS{Repo: e.Repo, OnCommit: func() {
		_ = e.Repo.DeleteMemberRole(t.Context(), cid, victim, role)
		_ = e.Repo.DeleteChannelMember(t.Context(), ch, victim)
	}}
	if err := api.MaterialiseChannelMembers(t.Context(), e.Repo, dsvc, mustChannel(t, e, ch), e.Clk.Now().Unix()); err != nil {
		t.Fatalf("MaterialiseChannelMembers: %v", err)
	}
	victimDevices := devicesOf(t, e, victim)
	for _, a := range dsvc.Adds {
		if slices.Contains(victimDevices, a.Device) {
			t.Fatal("a user removed during the first batch was still added by a later one")
		}
	}
	// And the positive half: the first batch really did run, so the assertion
	// above is about eligibility and not about nothing having happened.
	firstDevices := devicesOf(t, e, first)
	var sawFirst bool
	for _, a := range dsvc.Adds {
		if slices.Contains(firstDevices, a.Device) {
			sawFirst = true
		}
	}
	if !sawFirst {
		t.Fatal("no device from the first batch was added; the test proved nothing")
	}
}

// privateChannel is a channel @everyone cannot see and the returned role can: the shape of a
// private channel, with its text group seeded.
func privateChannel(t *testing.T, e *env, cid id.ID, ownerTok string) (ch, role, group id.ID) {
	t.Helper()
	role = createRole(t, e, cid, ownerTok, "insiders", 10, api.PermViewChannel)
	ch, _, _ = newChannel(t, e, cid, ownerTok, 0, 0, 0, "secret")
	roles, err := e.Repo.ListRoles(t.Context(), cid)
	if err != nil {
		t.Fatalf("ListRoles: %v", err)
	}
	var everyone id.ID
	for _, r := range roles {
		if r.Position == 0 {
			everyone = r.ID
		}
	}
	for target, bits := range map[id.ID][2]uint64{
		everyone: {0, uint64(api.PermViewChannel)},
		role:     {uint64(api.PermViewChannel), 0},
	} {
		if status, body := e.Do(http.MethodPut,
			"/v1/channels/"+ch.String()+"/overwrites/0/"+target.String(), ownerTok,
			[]any{bits[0], bits[1]}); status != http.StatusNoContent {
			t.Fatalf("PUT overwrite = %d (%x)", status, body)
		}
	}
	return ch, role, seedTextGroup(t, e, ch, cid)
}

// A grant that opens a private channel to one member materialises the row and proposes the
// member's devices for the channel's text group; the revoke drops the row and proposes the
// Remove of the leaf the member came to hold.
func TestAGrantProposesTheGranteesDevicesAndARevokeRemovesThem(t *testing.T) {
	e, cid, ownerTok := channelEnv(t)
	dsvc := &recordingDS{}
	api.NewRoles(e.Repo, e.Clk, "dilla.example", slog.New(slog.DiscardHandler)).WithDS(dsvc).Register(e.Mux)
	ch, role, group := privateChannel(t, e, cid, ownerTok)

	member, memberTok := e.NewUser("insider")
	joinCommunity(t, e, cid, memberTok)
	device := seedDevices(t, e, member, 1)[0]
	seedKeyPackage(t, e, device)
	if members, _ := e.Repo.ListChannelMembers(t.Context(), ch); slices.Contains(members, member) {
		t.Fatal("a member @everyone's deny hides the channel from is in channel_members")
	}
	dsvc.Reset()

	grant(t, e, cid, ownerTok, member, role, http.StatusNoContent)
	if members, _ := e.Repo.ListChannelMembers(t.Context(), ch); !slices.Contains(members, member) {
		t.Fatal("the grant did not materialise channel_members")
	}
	if len(dsvc.Adds) != 1 || dsvc.Adds[0].Group != group || dsvc.Adds[0].Device != device {
		t.Fatalf("Adds = %+v, want the grantee's one device with a KeyPackage in %s", dsvc.Adds, group)
	}

	// The commit the Add asked for lands: the member holds a leaf.
	seedMemberDevice(t, e, group, member, device, 1)
	dsvc.Reset()
	if status, _ := e.Do(http.MethodDelete,
		"/v1/communities/"+cid.String()+"/members/"+member.String()+"/roles/"+role.String(),
		ownerTok, nil); status != http.StatusNoContent {
		t.Fatal("DELETE role grant failed")
	}
	if members, _ := e.Repo.ListChannelMembers(t.Context(), ch); slices.Contains(members, member) {
		t.Fatal("channel_members still lists a user whose role was revoked")
	}
	removes := dsvc.removes()
	if len(removes) != 1 || removes[0].Group != group || removes[0].Leaf != 1 {
		t.Fatalf("Removes = %+v, want leaf 1 of %s", removes, group)
	}
}

// A grant that changes nothing about who may see a channel does not re-derive it: the role
// routes call EligibleUsers, which is O(members), once per channel whose verdict for the user
// actually moved.
func TestAGrantThatChangesNoVerdictProposesNothing(t *testing.T) {
	e, cid, ownerTok := channelEnv(t)
	dsvc := &recordingDS{}
	api.NewRoles(e.Repo, e.Clk, "dilla.example", slog.New(slog.DiscardHandler)).WithDS(dsvc).Register(e.Mux)
	_, role, _ := privateChannel(t, e, cid, ownerTok)
	other := createRole(t, e, cid, ownerTok, "colour", 5, api.PermAddReactions)

	// An insider whose Add the recording double never turns into a leaf: any re-derivation of the
	// channel would propose that device again, so an empty record below means none ran.
	insider, insiderTok := e.NewUser("insider")
	joinCommunity(t, e, cid, insiderTok)
	seedKeyPackage(t, e, seedDevices(t, e, insider, 1)[0])
	grant(t, e, cid, ownerTok, insider, role, http.StatusNoContent)
	if len(dsvc.Adds) == 0 {
		t.Fatal("the insider's grant proposed nothing; the assertion below would be vacuous")
	}

	member, memberTok := e.NewUser("bystander")
	joinCommunity(t, e, cid, memberTok)
	seedKeyPackage(t, e, seedDevices(t, e, member, 1)[0])
	dsvc.Reset()
	grant(t, e, cid, ownerTok, member, other, http.StatusNoContent)
	if len(dsvc.Adds) != 0 || len(dsvc.removes()) != 0 {
		t.Fatalf("a grant that opens nothing issued Adds %+v and Removes %+v", dsvc.Adds, dsvc.removes())
	}
}

// Registering a channel's text group is "creating a private channel" (protocol/01 § Joining):
// every eligible device but the creator's live leaf is proposed, in batches.
func TestRegisteringAChannelGroupPopulatesIt(t *testing.T) {
	e, cid, ownerTok := channelEnv(t)
	api.NewRoles(e.Repo, e.Clk, "dilla.example", slog.New(slog.DiscardHandler)).Register(e.Mux)
	role := createRole(t, e, cid, ownerTok, "insiders", 10, api.PermViewChannel)
	users := seedCommunityOfSize(t, e, cid, ownerTok, role, 3)
	ch, _, _ := newChannel(t, e, cid, ownerTok, 0, 0, 0, "secret")
	group := seedTextGroup(t, e, ch, cid)

	dsvc := &recordingDS{}
	if err := api.SyncRegisteredGroup(t.Context(), e.Repo, dsvc, group, e.Clk.Now().Unix()); err != nil {
		t.Fatalf("SyncRegisteredGroup: %v", err)
	}
	var want []id.ID
	for _, u := range users {
		for _, d := range devicesOf(t, e, u) {
			if n, err := e.Repo.CountKeyPackages(t.Context(), d, e.Clk.Now().Unix()); err != nil {
				t.Fatalf("CountKeyPackages: %v", err)
			} else if n > 0 {
				want = append(want, d) // the one seedCommunityOfSize gave a KeyPackage
			}
		}
	}
	var got []id.ID
	for _, a := range dsvc.Adds {
		got = append(got, a.Device)
	}
	slices.SortFunc(want, func(a, b id.ID) int { return bytes.Compare(a[:], b[:]) })
	slices.SortFunc(got, func(a, b id.ID) int { return bytes.Compare(a[:], b[:]) })
	if !slices.Equal(got, want) {
		t.Fatalf("Adds = %v, want %v", got, want)
	}
	if dsvc.Commits != 1 {
		t.Fatalf("commit requests = %d, want 1", dsvc.Commits)
	}

	// A group bound to no channel (a pairing group, an interaction group) is left alone.
	stray := seedGroupOfKind(t, e, id.New(), cid, 2)
	dsvc.Reset()
	if err := api.SyncRegisteredGroup(t.Context(), e.Repo, dsvc, stray, e.Clk.Now().Unix()); err != nil {
		t.Fatalf("SyncRegisteredGroup(pairing group): %v", err)
	}
	if len(dsvc.Adds) != 0 {
		t.Fatalf("a group bound to no channel was populated: %+v", dsvc.Adds)
	}
}

// A PATCH that changes visibility re-derives channel_members.
func TestAVisibilityChangeRematerialisesTheChannel(t *testing.T) {
	e, cid, ownerTok := channelEnv(t)
	member, memberTok := e.NewUser("member")
	joinCommunity(t, e, cid, memberTok)
	ch, _, _ := newChannel(t, e, cid, ownerTok, 0, 1, 2, "lobby") // readable, discoverable
	if members, _ := e.Repo.ListChannelMembers(t.Context(), ch); !slices.Contains(members, member) {
		t.Fatalf("a new channel's members were not materialised: %v", members)
	}

	// Taken from the member behind the handler's back, so only the PATCH can notice.
	if err := e.Repo.PutOverwrite(t.Context(), store.OverwriteRow{
		ChannelID: ch, TargetKind: 1, TargetID: member, Deny: uint64(api.PermViewChannel),
	}); err != nil {
		t.Fatalf("PutOverwrite: %v", err)
	}
	if status, body := e.Do(http.MethodPatch, "/v1/channels/"+ch.String(), ownerTok,
		[]any{nil, nil, nil, uint64(api.VisPrivate), nil, nil, nil}); status != http.StatusNoContent {
		t.Fatalf("PATCH visibility = %d (%x)", status, body)
	}
	if members, _ := e.Repo.ListChannelMembers(t.Context(), ch); slices.Contains(members, member) {
		t.Fatal("the visibility change did not re-derive channel_members")
	}
}

// seedMemberDevice adds one mls_members row: user's given device at leaf in group.
func seedMemberDevice(t *testing.T, e *env, group, user, device id.ID, leaf uint32) {
	t.Helper()
	members, err := e.Repo.ListMembers(t.Context(), group)
	if err != nil {
		t.Fatalf("ListMembers: %v", err)
	}
	members = append(members, store.MemberRow{
		GroupID: group, LeafIndex: leaf, UserID: user, DeviceID: device,
		SignatureKey: make([]byte, 32),
	})
	if err := e.Repo.ReplaceMembers(t.Context(), group, 0, members); err != nil {
		t.Fatalf("ReplaceMembers: %v", err)
	}
}
