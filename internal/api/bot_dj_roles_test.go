package api_test

import (
	"context"
	"log/slog"
	"net/http"
	"testing"
	"time"

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

func TestDJRolePolicySurvivesDisableButWaitsForSameInstallationToBeReady(t *testing.T) {
	e, cid, token := channelEnv(t)
	owner := e.sess[token].UserID
	stepUps := api.NewStepUps(e.Clk, time.Minute)
	deps := api.Deps{Repo: e.Repo, Clock: e.Clk, StepUps: stepUps, Log: slog.New(slog.DiscardHandler)}
	e.Mux.HandleFunc("PUT /v1/communities/{community}/bot", deps.ConfigureBotInstallation)
	e.Mux.HandleFunc("POST /v1/communities/{community}/bot/disable", deps.DisableBotInstallation)
	api.NewRoles(e.Repo, e.Clk, "dilla.example", slog.New(slog.DiscardHandler)).Register(e.Mux)
	session := e.sess[token]
	session.WireVersion = 3
	session.TokenHash = []byte(token)
	e.sess[token] = session
	h := e.Srv.Config.Handler
	ctx := context.Background()
	{
		encode := func(value any) []byte {
			t.Helper()
			body, err := cborx.Marshal(value)
			if err != nil {
				t.Fatal(err)
			}
			return body
		}
		now := e.Clk.Now().Unix()
		botID, deviceID := id.New(), id.New()
		if err := e.Repo.CreateUser(ctx, store.UserRow{ID: botID, Username: "dj-cycle-" + botID.String()[:8], Kind: 1, UMKPub: append(botID[:], make([]byte, 16)...), SSKPub: append(deviceID[:], make([]byte, 16)...), SigUMKSSK: make([]byte, 64), Created: now}); err != nil {
			t.Fatal(err)
		}
		device := store.DeviceRow{ID: deviceID, UserID: botID, DSKPub: append(deviceID[:], make([]byte, 16)...), CredentialBlob: []byte{1}, Created: now, LastSeen: now}
		if err := e.Repo.CreateDevice(ctx, device); err != nil {
			t.Fatal(err)
		}
		if err := e.Repo.PutMember(ctx, store.MemberOfCommunityRow{CommunityID: cid, UserID: botID, Joined: now}); err != nil {
			t.Fatal(err)
		}
		verified := now
		installation := store.BotInstallationRow{ID: id.New(), CommunityID: cid, UserID: &botID, DeviceID: &deviceID,
			State: store.BotInstallationReady, Revision: 1, ApprovedBy: owner, ApprovedAt: now,
			CredentialVerifiedAt: &verified, Created: now, Updated: now}
		if err := e.Repo.CreateBotInstallation(ctx, installation); err != nil {
			t.Fatal(err)
		}
		role := store.RoleRow{ID: id.New(), CommunityID: cid, Name: "dj-cycle-role", Position: 1, Created: now}
		if err := e.Repo.PutRole(ctx, role); err != nil {
			t.Fatal(err)
		}
		policyPath := "/v1/communities/" + cid.String() + "/music/dj-roles"
		if rec := putCBORAuth(h, policyPath, encode([]any{id.New(), installation.ID, []any{role.ID}}), token); rec.Code != http.StatusOK {
			t.Fatalf("configure DJ roles = %d (%x)", rec.Code, rec.Body.Bytes())
		}

		botPath := "/v1/communities/" + cid.String() + "/bot"
		if rec := postCBORAuth(h, botPath+"/disable", encode([]any{id.New(), installation.Revision}), token); rec.Code != http.StatusOK {
			t.Fatalf("disable installation = %d (%x)", rec.Code, rec.Body.Bytes())
		}
		disabled, err := e.Repo.GetBotInstallation(ctx, installation.ID)
		if err != nil || disabled.State != store.BotInstallationDisabled || disabled.RemovedAt != nil {
			t.Fatalf("soft-disabled installation = %+v, %v", disabled, err)
		}
		if rec := getAuth(h, policyPath, token); rec.Code != http.StatusNotFound {
			t.Fatalf("GET while disabled = %d, want 404", rec.Code)
		}
		if rec := putCBORAuth(h, policyPath, encode([]any{id.New(), installation.ID, []any{}}), token); rec.Code != http.StatusNotFound {
			t.Fatalf("PUT while disabled = %d, want 404", rec.Code)
		}
		saved, err := e.Repo.ListDJRolePolicy(ctx, installation.ID)
		if err != nil || len(saved) != 1 || saved[0].RoleID != role.ID {
			t.Fatalf("policy after disabled PUT = %+v, %v; want saved approval unchanged", saved, err)
		}

		step, _ := deps.StepUps.Issue(owner, session.TokenHash)
		expectedRevision := disabled.Revision
		enable := []any{id.New(), expectedRevision, uint64(0), step}
		if rec := putCBORAuth(h, botPath, encode(enable), token); rec.Code != http.StatusOK {
			t.Fatalf("explicit re-enable = %d (%x)", rec.Code, rec.Body.Bytes())
		}
		joining, err := e.Repo.GetBotInstallation(ctx, installation.ID)
		if err != nil || joining.ID != installation.ID || joining.State != store.BotInstallationJoining {
			t.Fatalf("re-enabled installation = %+v, %v; want same ID joining", joining, err)
		}
		if rec := getAuth(h, policyPath, token); rec.Code != http.StatusNotFound {
			t.Fatalf("GET before ready = %d, want 404", rec.Code)
		}
		if rec := putCBORAuth(h, policyPath, encode([]any{id.New(), installation.ID, []any{}}), token); rec.Code != http.StatusNotFound {
			t.Fatalf("PUT before ready = %d, want 404", rec.Code)
		}
		saved, err = e.Repo.ListDJRolePolicy(ctx, installation.ID)
		if err != nil || len(saved) != 1 || saved[0].RoleID != role.ID {
			t.Fatalf("policy after pre-ready PUT = %+v, %v; want saved approval unchanged", saved, err)
		}

		joining.State = store.BotInstallationReady
		joining.Revision++
		joining.Updated = e.Clk.Now().Unix()
		if err := e.Repo.Tx(ctx, func(tx store.Repository) error {
			return tx.UpdateBotInstallation(ctx, joining.ID, joining.Revision-1, joining)
		}); err != nil {
			t.Fatal(err)
		}
		if rec := getAuth(h, policyPath, token); rec.Code != http.StatusOK {
			t.Fatalf("GET after same installation is ready = %d (%x), want saved policy", rec.Code, rec.Body.Bytes())
		} else {
			var value struct {
				_              struct{} `cbor:",toarray"`
				Roles          []id.ID
				InstallationID id.ID
			}
			if err := cborx.Unmarshal(rec.Body.Bytes(), &value); err != nil {
				t.Fatal(err)
			}
			if len(value.Roles) != 1 || value.Roles[0] != role.ID || value.InstallationID != installation.ID {
				t.Fatalf("saved DJ policy after re-enable = %#v", value)
			}
		}
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
