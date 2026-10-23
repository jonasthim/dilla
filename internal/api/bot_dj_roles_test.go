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

func TestDJRolePolicyRequiresBothPermissionsAndRoleHierarchy(t *testing.T) {
	e, cid, ownerToken := channelEnv(t)
	api.NewRoles(e.Repo, e.Clk, "dilla.example", slog.New(slog.DiscardHandler)).Register(e.Mux)
	owner := e.sess[ownerToken].UserID
	installation := createReadyDJBot(t, e, cid, owner)
	path := "/v1/communities/" + cid.String() + "/music/dj-roles"
	allowed := store.RoleRow{ID: id.New(), CommunityID: cid, Name: "dj", Position: 4, Created: e.Clk.Now().Unix()}
	tooHigh := store.RoleRow{ID: id.New(), CommunityID: cid, Name: "above-dj-manager", Position: 11, Created: e.Clk.Now().Unix()}
	for _, role := range []store.RoleRow{allowed, tooHigh} {
		if err := e.Repo.PutRole(t.Context(), role); err != nil {
			t.Fatal(err)
		}
	}
	if status, body := e.Do(http.MethodPut, path, ownerToken, []any{id.New(), installation.ID, []any{allowed.ID}}); status != http.StatusOK {
		t.Fatalf("owner configure DJ policy = %d (%x), want 200", status, body)
	}
	if status, body := e.Do(http.MethodGet, path, ownerToken, nil); status != http.StatusOK {
		t.Fatalf("get DJ policy = %d (%x), want 200", status, body)
	} else {
		var value struct {
			_              struct{} `cbor:",toarray"`
			Roles          []id.ID
			InstallationID id.ID
		}
		if err := cborx.Unmarshal(body, &value); err != nil {
			t.Fatal(err)
		}
		if len(value.Roles) != 1 || value.Roles[0] != allowed.ID || value.InstallationID != installation.ID {
			t.Fatalf("DJ policy response = %#v", value)
		}
	}

	manager, managerToken := e.NewUser("dj-manager")
	if err := e.Repo.PutMember(t.Context(), store.MemberOfCommunityRow{CommunityID: cid, UserID: manager, Joined: e.Clk.Now().Unix()}); err != nil {
		t.Fatal(err)
	}
	managerRole := store.RoleRow{ID: id.New(), CommunityID: cid, Name: "dj-manager", Position: 10, Allow: uint64(api.PermManageCommunity | api.PermManageRoles), Created: e.Clk.Now().Unix()}
	if err := e.Repo.PutRole(t.Context(), managerRole); err != nil {
		t.Fatal(err)
	}
	if err := e.Repo.PutMemberRole(t.Context(), cid, manager, managerRole.ID); err != nil {
		t.Fatal(err)
	}
	if status, body := e.Do(http.MethodPut, path, managerToken, []any{id.New(), installation.ID, []any{tooHigh.ID}}); status != http.StatusForbidden {
		t.Fatalf("above-hierarchy DJ policy = %d (%x), want 403", status, body)
	}

	communityManager, communityToken := e.NewUser("community-manager")
	if err := e.Repo.PutMember(t.Context(), store.MemberOfCommunityRow{CommunityID: cid, UserID: communityManager, Joined: e.Clk.Now().Unix()}); err != nil {
		t.Fatal(err)
	}
	communityRole := store.RoleRow{ID: id.New(), CommunityID: cid, Name: "community-manager", Position: 15, Allow: uint64(api.PermManageCommunity), Created: e.Clk.Now().Unix()}
	if err := e.Repo.PutRole(t.Context(), communityRole); err != nil {
		t.Fatal(err)
	}
	if err := e.Repo.PutMemberRole(t.Context(), cid, communityManager, communityRole.ID); err != nil {
		t.Fatal(err)
	}
	if status, body := e.Do(http.MethodPut, path, communityToken, []any{id.New(), installation.ID, []any{allowed.ID}}); status != http.StatusForbidden {
		t.Fatalf("manage_community without manage_roles = %d (%x), want 403", status, body)
	}

	roleManager, roleToken := e.NewUser("role-manager")
	if err := e.Repo.PutMember(t.Context(), store.MemberOfCommunityRow{CommunityID: cid, UserID: roleManager, Joined: e.Clk.Now().Unix()}); err != nil {
		t.Fatal(err)
	}
	roleOnly := store.RoleRow{ID: id.New(), CommunityID: cid, Name: "role-manager", Position: 20, Allow: uint64(api.PermManageRoles), Created: e.Clk.Now().Unix()}
	if err := e.Repo.PutRole(t.Context(), roleOnly); err != nil {
		t.Fatal(err)
	}
	if err := e.Repo.PutMemberRole(t.Context(), cid, roleManager, roleOnly.ID); err != nil {
		t.Fatal(err)
	}
	if status, body := e.Do(http.MethodGet, path, roleToken, nil); status != http.StatusForbidden {
		t.Fatalf("manage_roles without manage_community = %d (%x), want 403", status, body)
	}

	removedAt := e.Clk.Now().Unix()
	old, err := e.Repo.GetBotInstallation(t.Context(), installation.ID)
	if err != nil {
		t.Fatal(err)
	}
	old.State = store.BotInstallationDisabled
	old.Revision++
	old.RemovedAt = &removedAt
	old.Updated = removedAt
	if err := e.Repo.Tx(t.Context(), func(tx store.Repository) error {
		return tx.UpdateBotInstallation(t.Context(), old.ID, old.Revision-1, old)
	}); err != nil {
		t.Fatal(err)
	}
	replacement := createReadyDJBot(t, e, cid, owner)
	if status, body := e.Do(http.MethodGet, path, ownerToken, nil); status != http.StatusOK {
		t.Fatalf("get replacement DJ policy = %d (%x), want 200", status, body)
	} else {
		var value struct {
			_              struct{} `cbor:",toarray"`
			Roles          []id.ID
			InstallationID id.ID
		}
		if err := cborx.Unmarshal(body, &value); err != nil {
			t.Fatal(err)
		}
		if len(value.Roles) != 0 || value.InstallationID != replacement.ID {
			t.Fatalf("replacement inherited DJ policy: %#v", value)
		}
	}
	if status, body := e.Do(http.MethodPut, path, ownerToken, []any{id.New(), installation.ID, []any{allowed.ID}}); status != http.StatusConflict {
		t.Fatalf("stale installation DJ policy write = %d (%x), want 409", status, body)
	}
}

func createReadyDJBot(t *testing.T, e *env, community, owner id.ID) store.BotInstallationRow {
	t.Helper()
	now := e.Clk.Now().Unix()
	botID, deviceID := id.New(), id.New()
	if err := e.Repo.CreateUser(t.Context(), store.UserRow{ID: botID, Username: "dj-policy-" + botID.String()[:8], Display: "DJ Policy Bot", Kind: 1, UMKPub: append(botID[:], make([]byte, 16)...), SSKPub: append(deviceID[:], make([]byte, 16)...), SigUMKSSK: make([]byte, 64), Created: now}); err != nil {
		t.Fatal(err)
	}
	if err := e.Repo.PutMember(t.Context(), store.MemberOfCommunityRow{CommunityID: community, UserID: botID, Joined: now}); err != nil {
		t.Fatal(err)
	}
	verified := now
	if err := e.Repo.CreateDevice(t.Context(), store.DeviceRow{ID: deviceID, UserID: botID, DSKPub: append(deviceID[:], make([]byte, 16)...), CredentialBlob: []byte{1}, VerifiedAt: &verified, Created: now, LastSeen: now}); err != nil {
		t.Fatal(err)
	}
	installation := store.BotInstallationRow{ID: id.New(), CommunityID: community, UserID: &botID, DeviceID: &deviceID, State: store.BotInstallationReady, Revision: 1, ApprovedBy: owner, ApprovedAt: now, CredentialVerifiedAt: &verified, Created: now, Updated: now}
	if err := e.Repo.CreateBotInstallation(t.Context(), installation); err != nil {
		t.Fatal(err)
	}
	return installation
}
