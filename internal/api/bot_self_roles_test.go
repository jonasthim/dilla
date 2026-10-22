package api_test

import (
	"log/slog"
	"net/http"
	"slices"
	"testing"

	"github.com/jonasthim/dilla/internal/api"
	"github.com/jonasthim/dilla/internal/cborx"
	"github.com/jonasthim/dilla/internal/id"
	"github.com/jonasthim/dilla/internal/store"
)

func TestSelfRolePolicyAndSelectionUseCurrentAllowlistAndOnlySelfSource(t *testing.T) {
	e, cid, ownerTok := channelEnv(t)
	api.NewRoles(e.Repo, e.Clk, "dilla.example", slog.New(slog.DiscardHandler)).Register(e.Mux)
	role := createRole(t, e, cid, ownerTok, "pickable", 2, api.PermViewChannel)
	member, memberTok := e.NewUser("picker")
	joinCommunity(t, e, cid, memberTok)

	policyPath := "/v1/communities/" + cid.String() + "/self-roles/policy"
	if status, body := e.Do(http.MethodPut, policyPath, ownerTok, []any{id.New(), []any{role}}); status != http.StatusOK {
		t.Fatalf("configure policy = %d (%x), want 200", status, body)
	}
	selectPath := "/v1/communities/" + cid.String() + "/self-roles/" + role.String()
	if err := e.Repo.PutMemberRole(t.Context(), cid, member, role); err != nil {
		t.Fatal(err)
	}
	if status, body := e.Do(http.MethodPut, selectPath, memberTok, []any{id.New(), uint64(0)}); status != http.StatusNoContent {
		t.Fatalf("disable absent self grant = %d (%x), want idempotent 204", status, body)
	}
	if status, body := e.Do(http.MethodGet, "/v1/communities/"+cid.String()+"/self-roles", memberTok, nil); status != http.StatusOK {
		t.Fatalf("list self roles = %d (%x), want 200", status, body)
	} else {
		var rows [][]any
		if err := cborx.Unmarshal(body, &rows); err != nil {
			t.Fatalf("decode self-role list: %v", err)
		}
		if len(rows) != 1 || rows[0][3] != uint64(0) {
			t.Fatalf("manual grant reported as self-selected: %#v", rows)
		}
	}
	if status, body := e.Do(http.MethodPut, selectPath, memberTok, []any{id.New(), uint64(1)}); status != http.StatusNoContent {
		t.Fatalf("self-select = %d (%x), want 204", status, body)
	}
	if status, body := e.Do(http.MethodPut, selectPath, memberTok, []any{id.New(), uint64(0)}); status != http.StatusNoContent {
		t.Fatalf("self-remove = %d (%x), want 204", status, body)
	}
	if status, body := e.Do(http.MethodPut, selectPath, memberTok, []any{id.New(), uint64(0)}); status != http.StatusNoContent {
		t.Fatalf("repeated self-remove = %d (%x), want idempotent 204", status, body)
	}
	held, err := e.Repo.ListMemberRoles(t.Context(), cid, member)
	if err != nil || len(held) != 1 || held[0] != role {
		t.Fatalf("manual grant after self removal = %v, %v", held, err)
	}
	if err := e.Repo.DeleteMemberRole(t.Context(), cid, member, role); err != nil {
		t.Fatal(err)
	}
	if status, body := e.Do(http.MethodPut, policyPath, ownerTok, []any{id.New(), []any{}}); status != http.StatusOK {
		t.Fatalf("disable policy = %d (%x), want 200", status, body)
	}
	if status, body := e.Do(http.MethodPut, selectPath, memberTok, []any{id.New(), uint64(1)}); status != http.StatusForbidden {
		t.Fatalf("selection after policy removal = %d (%x), want 403", status, body)
	}
	if _, err := e.Repo.GetMember(t.Context(), cid, member); err != nil {
		t.Fatal(err)
	}
}

func TestRemovingSelfRolePolicyRevokesOnlySelfGrants(t *testing.T) {
	e, cid, ownerTok := channelEnv(t)
	api.NewRoles(e.Repo, e.Clk, "dilla.example", slog.New(slog.DiscardHandler)).Register(e.Mux)
	role := createRole(t, e, cid, ownerTok, "temporary", 2, api.PermViewChannel)
	member, memberTok := e.NewUser("temporary-picker")
	joinCommunity(t, e, cid, memberTok)
	manualMember, manualTok := e.NewUser("manual-and-self-picker")
	joinCommunity(t, e, cid, manualTok)
	reactionMember, reactionTok := e.NewUser("reaction-and-self-picker")
	joinCommunity(t, e, cid, reactionTok)
	policyPath := "/v1/communities/" + cid.String() + "/self-roles/policy"
	selectionPath := "/v1/communities/" + cid.String() + "/self-roles/" + role.String()
	if status, body := e.Do(http.MethodPut, policyPath, ownerTok, []any{id.New(), []any{role}}); status != http.StatusOK {
		t.Fatalf("configure policy = %d (%x)", status, body)
	}
	for _, token := range []string{memberTok, manualTok, reactionTok} {
		if status, body := e.Do(http.MethodPut, selectionPath, token, []any{id.New(), uint64(1)}); status != http.StatusNoContent {
			t.Fatalf("select = %d (%x)", status, body)
		}
	}
	if err := e.Repo.PutMemberRole(t.Context(), cid, manualMember, role); err != nil {
		t.Fatal(err)
	}
	if err := e.Repo.AddMemberRoleGrant(t.Context(), cid, reactionMember, role, "reaction"); err != nil {
		t.Fatal(err)
	}
	if status, body := e.Do(http.MethodPut, policyPath, ownerTok, []any{id.New(), []any{}}); status != http.StatusOK {
		t.Fatalf("remove policy = %d (%x)", status, body)
	}
	if held, err := e.Repo.ListMemberRoles(t.Context(), cid, member); err != nil || len(held) != 0 {
		t.Fatalf("self-only grant after policy removal = %v, %v", held, err)
	}
	if held, err := e.Repo.ListMemberRoles(t.Context(), cid, manualMember); err != nil || len(held) != 1 || held[0] != role {
		t.Fatalf("manual grant after policy removal = %v, %v", held, err)
	}
	if held, err := e.Repo.ListMemberRoles(t.Context(), cid, reactionMember); err != nil || len(held) != 1 || held[0] != role {
		t.Fatalf("reaction grant after policy removal = %v, %v", held, err)
	}
	for _, user := range []id.ID{member, manualMember, reactionMember} {
		if selected, err := e.Repo.HasMemberRoleGrant(t.Context(), cid, user, role, "self"); err != nil || selected {
			t.Fatalf("self source after policy removal = %v, %v", selected, err)
		}
	}
}

func TestSelfRolePolicyRejectsEveryPermissionOutsideSafeCeiling(t *testing.T) {
	e, cid, ownerTok := channelEnv(t)
	api.NewRoles(e.Repo, e.Clk, "dilla.example", slog.New(slog.DiscardHandler)).Register(e.Mux)
	allowed := api.PermViewChannel | api.PermSendMessages | api.PermAttachFiles | api.PermAddReactions |
		api.PermReadHistory | api.PermConnect | api.PermSpeak | api.PermVideo | api.PermScreenShare
	for bit := api.Bits(1); bit <= api.PermAll; bit <<= 1 {
		if api.PermAll&bit == 0 || allowed&bit != 0 {
			continue
		}
		role := store.RoleRow{ID: id.New(), CommunityID: cid, Name: "unsafe", Position: 5, Allow: uint64(bit), Created: e.Clk.Now().Unix()}
		if err := e.Repo.PutRole(t.Context(), role); err != nil {
			t.Fatal(err)
		}
		path := "/v1/communities/" + cid.String() + "/self-roles/policy"
		status, body := e.Do(http.MethodPut, path, ownerTok, []any{id.New(), []any{role.ID}})
		if status != http.StatusForbidden {
			t.Fatalf("policy with permission bit %#x = %d (%x), want 403", bit, status, body)
		}
	}
	role := store.RoleRow{ID: id.New(), CommunityID: cid, Name: "unsafe-deny", Position: 5, Deny: uint64(api.PermManageNicknames), Created: e.Clk.Now().Unix()}
	if err := e.Repo.PutRole(t.Context(), role); err != nil {
		t.Fatal(err)
	}
	status, body := e.Do(http.MethodPut, "/v1/communities/"+cid.String()+"/self-roles/policy", ownerTok, []any{id.New(), []any{role.ID}})
	if status != http.StatusForbidden {
		t.Fatalf("policy with privileged deny = %d (%x), want 403", status, body)
	}
}

func TestRolePanelRegistrationRejectsHumanAuthoredLookalikeMessage(t *testing.T) {
	e, cid, ownerTok := channelEnv(t)
	roles := api.NewRoles(e.Repo, e.Clk, "dilla.example", slog.New(slog.DiscardHandler))
	roles.Register(e.Mux)
	role := createRole(t, e, cid, ownerTok, "panel-role", 2, api.PermViewChannel)
	if status, body := e.Do(http.MethodPut, "/v1/communities/"+cid.String()+"/self-roles/policy", ownerTok, []any{id.New(), []any{role}}); status != http.StatusOK {
		t.Fatalf("configure self-role policy = %d (%x)", status, body)
	}
	channel, _, status := newChannel(t, e, cid, ownerTok, 0, 1, 0, "role-panel")
	if status != http.StatusCreated {
		t.Fatalf("create channel = %d", status)
	}
	now := e.Clk.Now().Unix()
	owner := e.sess[ownerTok].UserID
	botID, deviceID, installationID := id.New(), id.New(), id.New()
	if err := e.Repo.CreateUser(t.Context(), store.UserRow{ID: botID, Username: "role-panel-bot", Display: "Role Panel Bot", Kind: 1, UMKPub: make([]byte, 32), SSKPub: make([]byte, 32), SigUMKSSK: make([]byte, 64), Created: now}); err != nil {
		t.Fatal(err)
	}
	if err := e.Repo.PutMember(t.Context(), store.MemberOfCommunityRow{CommunityID: cid, UserID: botID, Joined: now}); err != nil {
		t.Fatal(err)
	}
	verified := now
	if err := e.Repo.CreateDevice(t.Context(), store.DeviceRow{ID: deviceID, UserID: botID, DSKPub: append([]byte{1}, make([]byte, 31)...), CredentialBlob: []byte{1}, VerifiedAt: &verified, Created: now, LastSeen: now}); err != nil {
		t.Fatal(err)
	}
	if err := e.Repo.CreateBotInstallation(t.Context(), store.BotInstallationRow{ID: installationID, CommunityID: cid, UserID: &botID, DeviceID: &deviceID, State: store.BotInstallationReady, Revision: 1, ApprovedBy: owner, ApprovedAt: now, CredentialVerifiedAt: &verified, Created: now, Updated: now}); err != nil {
		t.Fatal(err)
	}
	author := e.sess[ownerTok].UserID
	if _, err := e.Repo.PutReadableMessage(t.Context(), store.ReadableMessageRow{ChannelID: channel, ChannelHex: channel.String(), Seq: 7, Sender: author, Envelope: []byte{1}, Body: "Role menu", FrankingTag: make([]byte, 32), Created: e.Clk.Now().Unix()}); err != nil {
		t.Fatal(err)
	}
	path := "/v1/communities/" + cid.String() + "/role-panels"
	status, body := e.Do(http.MethodPut, path, ownerTok, []any{id.ID{}, channel, uint64(7), []any{[]any{"✅", role}}})
	if status != http.StatusBadRequest {
		t.Fatalf("register with zero operation id = %d (%x), want 400", status, body)
	}
	status, body = e.Do(http.MethodPut, path, ownerTok, []any{id.New(), channel, uint64(7), []any{[]any{"✅", role}}})
	if status != http.StatusForbidden {
		t.Fatalf("register human-authored lookalike = %d (%x), want 403", status, body)
	}
	if _, err := e.Repo.PutReadableMessage(t.Context(), store.ReadableMessageRow{ChannelID: channel, ChannelHex: channel.String(), Seq: 8, Sender: botID, UploaderDevice: id.New(), Envelope: []byte{1}, Body: "Lookalike", FrankingTag: make([]byte, 32), Created: e.Clk.Now().Unix()}); err != nil {
		t.Fatal(err)
	}
	status, body = e.Do(http.MethodPut, path, ownerTok, []any{id.New(), channel, uint64(8), []any{[]any{"✅", role}}})
	if status != http.StatusForbidden {
		t.Fatalf("register message attributed to a lookalike uploader = %d (%x), want 403", status, body)
	}
	if _, err := e.Repo.PutReadableMessage(t.Context(), store.ReadableMessageRow{ChannelID: channel, ChannelHex: channel.String(), Seq: 9, Sender: botID, UploaderDevice: deviceID, Envelope: []byte{1}, Body: "Real bot panel", FrankingTag: make([]byte, 32), Created: e.Clk.Now().Unix()}); err != nil {
		t.Fatal(err)
	}
	status, body = e.Do(http.MethodPut, path, ownerTok, []any{id.New(), channel, uint64(9), []any{[]any{"✅", role}}})
	if status != http.StatusOK {
		t.Fatalf("register installation-authored panel = %d (%x), want 200", status, body)
	}
	registered, err := e.Repo.GetRolePanel(t.Context(), channel, 9)
	if err != nil || registered.AuthorID != botID || registered.InstallationID != installationID {
		t.Fatalf("registered panel identity = %+v, %v", registered, err)
	}
	if err := e.Repo.AddReactionRoleGrant(t.Context(), store.ReactionRoleGrant{CommunityID: cid, UserID: owner, RoleID: role, ChannelID: channel, MessageSeq: 9, Reaction: "✅"}); err != nil {
		t.Fatal(err)
	}
	ownerSession := e.sess[ownerTok]
	ownerSession.WireVersion, ownerSession.E2EEVersion, ownerSession.MediaVersion = 3, 1, 1
	e.sess[ownerTok] = ownerSession
	if held, err := e.Repo.ListMemberRoles(t.Context(), cid, owner); err != nil || !slices.Contains(held, role) {
		t.Fatalf("role before channel deletion = %v, %v; want present", held, err)
	}
	if status, body := e.Do(http.MethodDelete, "/v1/channels/"+channel.String(), ownerTok, nil); status != http.StatusNoContent {
		t.Fatalf("delete role panel channel = %d (%x), want 204", status, body)
	}
	if held, err := e.Repo.ListMemberRoles(t.Context(), cid, owner); err != nil || slices.Contains(held, role) {
		t.Fatalf("role after channel deletion = %v, %v; want absent", held, err)
	}
	status, body = e.Do(http.MethodPut, path, ownerTok, []any{id.New(), channel, uint64(9), []any{[]any{"✅", role}}})
	if status != http.StatusNotFound {
		t.Fatalf("register panel in deleted channel = %d (%x), want 404", status, body)
	}
}
