package api_test

import (
	"log/slog"
	"net/http"
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
