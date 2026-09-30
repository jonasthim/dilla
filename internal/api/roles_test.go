package api_test

import (
	"context"
	"log/slog"
	"net/http"
	"slices"
	"testing"

	"github.com/jonasthim/dilla/internal/api"
	"github.com/jonasthim/dilla/internal/id"
	"github.com/jonasthim/dilla/internal/store"
)

func TestARoleCannotBeGrantedAboveTheGrantersHighest(t *testing.T) {
	e, cid, ownerTok := channelEnv(t)
	api.NewRoles(e.Repo, e.Clk, "dilla.example", slog.New(slog.DiscardHandler)).Register(e.Mux)

	// The owner makes a "staff" role at position 10 that may manage roles, and
	// an "admin" role at position 50 that may not be handed out by staff.
	staff := createRole(t, e, cid, ownerTok, "staff", 10, api.PermViewChannel|api.PermManageRoles)
	high := createRole(t, e, cid, ownerTok, "high", 50, api.PermManageMessages)

	member, memberTok := e.NewUser("staffer")
	joinCommunity(t, e, cid, memberTok)
	grant(t, e, cid, ownerTok, member, staff, http.StatusNoContent)

	// The staffer may grant a role below their own highest…
	low := createRole(t, e, cid, ownerTok, "low", 5, api.PermAddReactions)
	victim, victimTok := e.NewUser("victim")
	joinCommunity(t, e, cid, victimTok)
	grant(t, e, cid, memberTok, victim, low, http.StatusNoContent)

	// …but not one at or above it.
	grant(t, e, cid, memberTok, victim, high, http.StatusForbidden)
	grant(t, e, cid, memberTok, victim, staff, http.StatusForbidden)
}

func TestOverwriteRoutesRoundTrip(t *testing.T) {
	e, cid, ownerTok := channelEnv(t)
	api.NewRoles(e.Repo, e.Clk, "dilla.example", slog.New(slog.DiscardHandler)).Register(e.Mux)
	ch, _, _ := newChannel(t, e, cid, ownerTok, 0, 1, 0, "general")
	member, memberTok := e.NewUser("member")
	joinCommunity(t, e, cid, memberTok)

	path := "/v1/channels/" + ch.String() + "/overwrites/1/" + member.String()
	if status, _ := e.Do(http.MethodPut, path, ownerTok,
		[]any{uint64(0), uint64(api.PermSendMessages)}); status != http.StatusNoContent {
		t.Fatal("PUT overwrite failed")
	}
	ow, err := e.Repo.ListOverwrites(t.Context(), ch)
	if err != nil {
		t.Fatalf("ListOverwrites: %v", err)
	}
	if len(ow) != 1 || ow[0].TargetKind != 1 || ow[0].TargetID != member ||
		ow[0].Deny != uint64(api.PermSendMessages) {
		t.Fatalf("overwrite = %+v", ow)
	}

	got, err := api.NewResolver(e.Repo).Resolve(t.Context(), member, mustChannel(t, e, ch))
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	if got.Has(api.PermSendMessages) {
		t.Fatal("the deny overwrite did not take effect")
	}

	if status, _ := e.Do(http.MethodDelete, path, ownerTok, nil); status != http.StatusNoContent {
		t.Fatal("DELETE overwrite failed")
	}
	if ow, _ := e.Repo.ListOverwrites(t.Context(), ch); len(ow) != 0 {
		t.Fatalf("overwrite survived the delete: %+v", ow)
	}
}

// The two escalation paths a position bound alone does not close: a staffer who
// may manage roles must not be able to MINT authority they do not hold, nor to
// hand it to the whole community by parking a role at position 0.
func TestAStafferCannotMintARoleCarryingBitsTheyDoNotHold(t *testing.T) {
	e, cid, ownerTok := channelEnv(t)
	api.NewRoles(e.Repo, e.Clk, "dilla.example", slog.New(slog.DiscardHandler)).Register(e.Mux)
	staff := createRole(t, e, cid, ownerTok, "staff", 10,
		api.PermViewChannel|api.PermSendMessages|api.PermManageRoles)
	member, memberTok := e.NewUser("staffer")
	joinCommunity(t, e, cid, memberTok)
	grant(t, e, cid, ownerTok, member, staff, http.StatusNoContent)

	// Below their own highest role, so the position bound passes — but the bits
	// are not theirs.
	status, body := e.Do(http.MethodPost, "/v1/communities/"+cid.String()+"/roles", memberTok,
		[]any{"sneaky", uint64(0), uint64(5), uint64(api.PermAdministrator), uint64(0), uint64(0), uint64(0)})
	if status != http.StatusForbidden {
		t.Fatalf("minting an administrator role = %d, want 403 (%x)", status, body)
	}
	if code := e.ErrCode(body); code != "E_FORBIDDEN" {
		t.Fatalf("code = %s", code)
	}
	// The same request for bits the staffer does hold succeeds.
	if status, body := e.Do(http.MethodPost, "/v1/communities/"+cid.String()+"/roles", memberTok,
		[]any{"fine", uint64(0), uint64(5), uint64(api.PermSendMessages), uint64(0), uint64(0), uint64(0)}); status != http.StatusCreated {
		t.Fatalf("minting a role within their own bits = %d (%x)", status, body)
	}
	// And a PATCH cannot smuggle the bit in afterwards.
	low := createRole(t, e, cid, ownerTok, "low", 5, api.PermAddReactions)
	if status, _ := e.Do(http.MethodPatch, "/v1/roles/"+low.String(), memberTok,
		[]any{nil, nil, nil, uint64(api.PermAdministrator), nil, nil, nil}); status != http.StatusForbidden {
		t.Fatalf("patching in an administrator bit = %d, want 403", status)
	}
}

func TestNoRoleCanBeMovedToPositionZero(t *testing.T) {
	e, cid, ownerTok := channelEnv(t)
	api.NewRoles(e.Repo, e.Clk, "dilla.example", slog.New(slog.DiscardHandler)).Register(e.Mux)
	role := createRole(t, e, cid, ownerTok, "staff", 10, api.PermViewChannel|api.PermManageRoles)

	// Position 0 is @everyone's and is implicitly held by every member, so a role
	// parked there would hand its bits to the whole community. Even the owner is
	// refused, because there is no legitimate reason to have two.
	status, body := e.Do(http.MethodPatch, "/v1/roles/"+role.String(), ownerTok,
		[]any{nil, nil, uint64(0), nil, nil, nil, nil})
	if status != http.StatusBadRequest {
		t.Fatalf("PATCH position=0 = %d, want 400 (%x)", status, body)
	}
	if code := e.ErrCode(body); code != "E_INVALID_REQUEST" {
		t.Fatalf("code = %s", code)
	}
	if status, _ := e.Do(http.MethodPost, "/v1/communities/"+cid.String()+"/roles", ownerTok,
		[]any{"also no", uint64(0), uint64(0), uint64(0), uint64(0), uint64(0), uint64(0)}); status != http.StatusBadRequest {
		t.Fatalf("POST position=0 = %d, want 400", status)
	}
	// The @everyone role itself may still be edited — just not moved.
	roles, err := e.Repo.ListRoles(t.Context(), cid)
	if err != nil {
		t.Fatalf("ListRoles: %v", err)
	}
	everyone := roles[0]
	if everyone.Position != 0 {
		t.Fatalf("roles[0] is not @everyone: %+v", everyone)
	}
	if status, _ := e.Do(http.MethodPatch, "/v1/roles/"+everyone.ID.String(), ownerTok,
		[]any{nil, nil, nil, uint64(api.PermViewChannel), nil, nil, nil}); status != http.StatusNoContent {
		t.Fatal("the owner could not edit @everyone's permissions")
	}
	if status, _ := e.Do(http.MethodPatch, "/v1/roles/"+everyone.ID.String(), ownerTok,
		[]any{nil, nil, uint64(7), nil, nil, nil, nil}); status != http.StatusBadRequest {
		t.Fatal("@everyone was moved off position 0")
	}
}

func TestRemovingARoleThatOpenedAPrivateChannelSchedulesRemoves(t *testing.T) {
	e, cid, ownerTok := channelEnv(t)
	api.NewRoles(e.Repo, e.Clk, "dilla.example", slog.New(slog.DiscardHandler)).Register(e.Mux)
	ch, _, _ := newChannel(t, e, cid, ownerTok, 0, 0 /* e2ee */, 0 /* private */, "secret")
	role := createRole(t, e, cid, ownerTok, "insiders", 10, api.PermViewChannel|api.PermSendMessages)
	if status, _ := e.Do(http.MethodPut,
		"/v1/channels/"+ch.String()+"/overwrites/0/"+role.String(), ownerTok,
		[]any{uint64(api.PermViewChannel), uint64(0)}); status != http.StatusNoContent {
		t.Fatal("PUT role overwrite failed")
	}
	// The channel is private: @everyone, which every new community grants
	// PermViewChannel, is denied it here, so the role is what opens it.
	roles, err := e.Repo.ListRoles(t.Context(), cid)
	if err != nil || len(roles) == 0 || roles[0].Position != 0 {
		t.Fatalf("ListRoles = %+v, %v; want @everyone first", roles, err)
	}
	if status, _ := e.Do(http.MethodPut,
		"/v1/channels/"+ch.String()+"/overwrites/0/"+roles[0].ID.String(), ownerTok,
		[]any{uint64(0), uint64(api.PermViewChannel)}); status != http.StatusNoContent {
		t.Fatal("PUT @everyone overwrite failed")
	}
	member, memberTok := e.NewUser("insider")
	joinCommunity(t, e, cid, memberTok)
	grant(t, e, cid, ownerTok, member, role, http.StatusNoContent)

	members, err := listChannelMembers(t, e, ch)
	if err != nil {
		t.Fatalf("ListChannelMembers: %v", err)
	}
	if !slices.Contains(members, member) {
		t.Fatal("the grant did not materialise channel_members")
	}

	// Revoking the role drops the materialised eligibility, which is what task 7
	// turns into delivery-service Removes.
	if status, _ := e.Do(http.MethodDelete,
		"/v1/communities/"+cid.String()+"/members/"+member.String()+"/roles/"+role.String(),
		ownerTok, nil); status != http.StatusNoContent {
		t.Fatal("DELETE role grant failed")
	}
	members, _ = listChannelMembers(t, e, ch)
	if slices.Contains(members, member) {
		t.Fatal("channel_members still lists a user whose role was revoked")
	}
}

// I1 (fix wave), protocol/09 § Roles "No new authority": a role's channel overwrites are
// authority too. A manage_roles holder may not grant (or revoke) a lower role whose overwrite in
// some channel carries a bit the holder does not have THERE, or they could open a private channel
// they cannot see to themself: bits 0 community-wide, 0x8ff3 in the channel after a self-grant.
func TestARoleGrantCannotHandOutChannelAccessTheGranterLacks(t *testing.T) {
	e, cid, ownerTok := channelEnv(t)
	api.NewRoles(e.Repo, e.Clk, "dilla.example", slog.New(slog.DiscardHandler)).Register(e.Mux)
	private, _, _ := newChannel(t, e, cid, ownerTok, 0, 0 /* e2ee */, 0 /* private */, "secret")
	roles, err := e.Repo.ListRoles(t.Context(), cid)
	if err != nil || len(roles) == 0 || roles[0].Position != 0 {
		t.Fatalf("ListRoles = %+v, %v; want @everyone first", roles, err)
	}
	if status, _ := e.Do(http.MethodPut,
		"/v1/channels/"+private.String()+"/overwrites/0/"+roles[0].ID.String(), ownerTok,
		[]any{uint64(0), uint64(api.PermViewChannel)}); status != http.StatusNoContent {
		t.Fatal("PUT @everyone deny failed")
	}
	// "insiders" carries nothing community-wide; its overwrite is what opens the channel.
	insiders := createRole(t, e, cid, ownerTok, "insiders", 5, 0)
	if status, _ := e.Do(http.MethodPut,
		"/v1/channels/"+private.String()+"/overwrites/0/"+insiders.String(), ownerTok,
		[]any{uint64(api.PermViewChannel | api.PermSendMessages), uint64(0)}); status != http.StatusNoContent {
		t.Fatal("PUT insiders overwrite failed")
	}
	// A role whose overwrite touches only a channel the staffer sees, with bits they hold there.
	open, _, _ := newChannel(t, e, cid, ownerTok, 0, 0, 0, "open")
	helpers := createRole(t, e, cid, ownerTok, "helpers", 4, 0)
	if status, _ := e.Do(http.MethodPut,
		"/v1/channels/"+open.String()+"/overwrites/0/"+helpers.String(), ownerTok,
		[]any{uint64(api.PermSendMessages), uint64(0)}); status != http.StatusNoContent {
		t.Fatal("PUT helpers overwrite failed")
	}

	staff := createRole(t, e, cid, ownerTok, "staff", 10, api.PermViewChannel|api.PermSendMessages|api.PermManageRoles)
	staffer, stafferTok := e.NewUser("staffer")
	joinCommunity(t, e, cid, stafferTok)
	grant(t, e, cid, ownerTok, staffer, staff, http.StatusNoContent)
	if bits, _ := api.NewResolver(e.Repo).Resolve(t.Context(), staffer, mustChannel(t, e, private)); bits.Has(api.PermViewChannel) {
		t.Fatal("the staffer already sees the private channel; the test proves nothing")
	}

	grant(t, e, cid, stafferTok, staffer, insiders, http.StatusForbidden)
	if bits, _ := api.NewResolver(e.Repo).Resolve(t.Context(), staffer, mustChannel(t, e, private)); bits.Has(api.PermViewChannel) {
		t.Fatal("the refused self-grant opened the private channel anyway")
	}
	// The revoke is the same authority: a staffer who could not grant it may not take it away.
	victim, victimTok := e.NewUser("victim")
	joinCommunity(t, e, cid, victimTok)
	grant(t, e, cid, ownerTok, victim, insiders, http.StatusNoContent)
	path := "/v1/communities/" + cid.String() + "/members/" + victim.String() + "/roles/" + insiders.String()
	if status, _ := e.Do(http.MethodDelete, path, stafferTok, nil); status != http.StatusForbidden {
		t.Fatalf("a staffer revoking a role that opens a channel they cannot see = %d, want 403", status)
	}
	// The positive control.
	grant(t, e, cid, stafferTok, victim, helpers, http.StatusNoContent)
}

// I2 (fix wave): a user overwrite is written for a member and ends with the membership. After a
// kick or a leave, rejoining must not find the private channel the overwrite opened; and an
// overwrite that outlived its member (written before this fix) can still be deleted.
func TestAUserOverwriteEndsWithTheMembership(t *testing.T) {
	for _, how := range []string{"kick", "leave"} {
		t.Run(how, func(t *testing.T) {
			e, cid, ownerTok := channelEnv(t)
			api.NewRoles(e.Repo, e.Clk, "dilla.example", slog.New(slog.DiscardHandler)).Register(e.Mux)
			private, _, _ := newChannel(t, e, cid, ownerTok, 0, 0, 0, "secret")
			roles, _ := e.Repo.ListRoles(t.Context(), cid)
			if status, _ := e.Do(http.MethodPut,
				"/v1/channels/"+private.String()+"/overwrites/0/"+roles[0].ID.String(), ownerTok,
				[]any{uint64(0), uint64(api.PermViewChannel)}); status != http.StatusNoContent {
				t.Fatal("PUT @everyone deny failed")
			}
			user, userTok := e.NewUser("insider")
			joinCommunity(t, e, cid, userTok)
			owPath := "/v1/channels/" + private.String() + "/overwrites/1/" + user.String()
			if status, _ := e.Do(http.MethodPut, owPath, ownerTok,
				[]any{uint64(api.PermViewChannel), uint64(0)}); status != http.StatusNoContent {
				t.Fatal("PUT user overwrite failed")
			}
			if status, _ := e.Do(http.MethodGet, "/v1/channels/"+private.String(), userTok, nil); status != http.StatusOK {
				t.Fatalf("the insider's GET of the private channel = %d, want 200", status)
			}

			switch how {
			case "kick":
				if status, _ := e.Do(http.MethodDelete, "/v1/communities/"+cid.String()+"/members/"+user.String(), ownerTok, nil); status != http.StatusNoContent {
					t.Fatal("kick failed")
				}
			case "leave":
				if status, _ := e.Do(http.MethodPost, "/v1/communities/"+cid.String()+"/leave", userTok, []any{}); status != http.StatusNoContent {
					t.Fatal("leave failed")
				}
			}
			if ow, _ := e.Repo.ListOverwrites(t.Context(), private); len(ow) != 1 {
				t.Fatalf("after the %s the channel's overwrites are %+v, want only @everyone's", how, ow)
			}
			joinCommunity(t, e, cid, userTok)
			if status, _ := e.Do(http.MethodGet, "/v1/channels/"+private.String(), userTok, nil); status != http.StatusNotFound {
				t.Fatalf("after the %s and a rejoin the private channel = %d, want 404", how, status)
			}
		})
	}

	// A stale overwrite from before the fix: its target is not a member, and the owner may still
	// delete it (the target's rank is taken as 0). A PUT for a non-member stays 404.
	e, cid, ownerTok := channelEnv(t)
	api.NewRoles(e.Repo, e.Clk, "dilla.example", slog.New(slog.DiscardHandler)).Register(e.Mux)
	private, _, _ := newChannel(t, e, cid, ownerTok, 0, 0, 0, "secret")
	gone := id.New()
	if err := e.Repo.PutOverwrite(t.Context(), store.OverwriteRow{
		ChannelID: private, TargetKind: 1, TargetID: gone, Allow: uint64(api.PermViewChannel),
	}); err != nil {
		t.Fatalf("PutOverwrite: %v", err)
	}
	owPath := "/v1/channels/" + private.String() + "/overwrites/1/" + gone.String()
	if status, _ := e.Do(http.MethodPut, owPath, ownerTok, []any{uint64(0), uint64(0)}); status != http.StatusNotFound {
		t.Fatalf("PUT for a non-member = %d, want 404", status)
	}
	if status, body := e.Do(http.MethodDelete, owPath, ownerTok, nil); status != http.StatusNoContent {
		t.Fatalf("DELETE of a stale user overwrite = %d %s, want 204", status, e.ErrCode(body))
	}
}

// createRole posts one role to /v1/communities/{id}/roles as tok and returns its
// id. Its body is [name, color, position, allow, deny, hoist, mentionable].
func createRole(t *testing.T, e *env, cid id.ID, tok, name string, position uint64, allow api.Bits) id.ID {
	t.Helper()
	status, body := e.Do(http.MethodPost, "/v1/communities/"+cid.String()+"/roles", tok,
		[]any{name, uint64(0), position, uint64(allow), uint64(0), uint64(0), uint64(0)})
	if status != http.StatusCreated {
		t.Fatalf("create role %q = %d (%x)", name, status, body)
	}
	var out []id.ID
	mustUnmarshal(t, body, &out)
	if len(out) != 1 {
		t.Fatalf("create role response = %v, want [role_id]", out)
	}
	return out[0]
}

// joinCommunity joins cid as tok.
func joinCommunity(t *testing.T, e *env, cid id.ID, tok string) {
	t.Helper()
	if status, body := e.Do(http.MethodPost, "/v1/communities/"+cid.String()+"/join", tok, []any{nil}); status != http.StatusOK {
		t.Fatalf("join = %d (%x)", status, body)
	}
}

// grant PUTs role to user in cid as tok and asserts the status.
func grant(t *testing.T, e *env, cid id.ID, tok string, user, role id.ID, want int) {
	t.Helper()
	path := "/v1/communities/" + cid.String() + "/members/" + user.String() + "/roles/" + role.String()
	if status, body := e.Do(http.MethodPut, path, tok, nil); status != want {
		t.Fatalf("grant %s to %s = %d, want %d (%x)", role, user, status, want, body)
	}
}

// mustChannel reads one live channel row.
func mustChannel(t *testing.T, e *env, ch id.ID) store.ChannelRow {
	t.Helper()
	row, err := e.Repo.GetChannel(t.Context(), ch)
	if err != nil {
		t.Fatalf("GetChannel: %v", err)
	}
	return row
}

// listChannelMembers reads channel_members through the store (task 6's table,
// which task 7's materialiser writes for a community channel).
func listChannelMembers(t *testing.T, e *env, ch id.ID) ([]id.ID, error) {
	t.Helper()
	lister, ok := e.Repo.(interface {
		ListChannelMembers(ctx context.Context, channelID id.ID) ([]id.ID, error)
	})
	if !ok {
		t.Fatal("store.Repository has no ListChannelMembers yet (task 7)")
	}
	return lister.ListChannelMembers(t.Context(), ch)
}
