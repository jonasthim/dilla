package api_test

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"net/http"
	"testing"

	"github.com/jonasthim/dilla/internal/auth"
	"github.com/jonasthim/dilla/internal/cborx"
	"github.com/jonasthim/dilla/internal/id"
	"github.com/jonasthim/dilla/internal/store"
)

func TestBotSessionDJPolicyReadIsBoundToReadyMusicInstallation(t *testing.T) {
	h, deps := newTestAPI(t)
	ctx := context.Background()
	now := deps.Clock.Now().Unix()
	owner, _, _ := seedAPIDevice(t, deps)
	community, bot, device, runtime, installation := id.New(), id.New(), id.New(), id.New(), id.New()
	verified := now
	if err := deps.Repo.CreateCommunity(ctx, store.CommunityRow{ID: community, Owner: owner.ID, Name: "runtime-dj-policy", PolicyJSON: []byte(`{}`), PolicyVersion: 1, Created: now}); err != nil {
		t.Fatal(err)
	}
	if err := deps.Repo.CreateUser(ctx, store.UserRow{ID: bot, Username: "bot" + bot.String()[:8], Display: "Bot", Kind: 1, UMKPub: make([]byte, 32), SSKPub: make([]byte, 32), SigUMKSSK: make([]byte, 64), Created: now}); err != nil {
		t.Fatal(err)
	}
	botPub, botPrivate, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	if err := deps.Repo.CreateDevice(ctx, store.DeviceRow{ID: device, UserID: bot, DSKPub: botPub, CredentialBlob: []byte{1}, VerifiedAt: &verified, Created: now}); err != nil {
		t.Fatal(err)
	}
	if err := deps.Repo.PutMember(ctx, store.MemberOfCommunityRow{CommunityID: community, UserID: bot, Joined: now}); err != nil {
		t.Fatal(err)
	}
	if err := deps.Repo.CreateBotRuntime(ctx, store.BotRuntimeRow{ID: runtime, TokenHash: make([]byte, 32), Created: now, Rotated: now}); err != nil {
		t.Fatal(err)
	}
	if err := deps.Repo.CreateBotInstallation(ctx, store.BotInstallationRow{ID: installation, CommunityID: community, RuntimeID: &runtime, UserID: &bot, DeviceID: &device, State: store.BotInstallationReady, Revision: 1, Capabilities: 1, ApprovedBy: owner.ID, ApprovedAt: now, CredentialVerifiedAt: &verified, Created: now, Updated: now}); err != nil {
		t.Fatal(err)
	}
	role := id.New()
	if err := deps.Repo.PutRole(ctx, store.RoleRow{ID: role, CommunityID: community, Name: "DJ", Position: 1, Created: now}); err != nil {
		t.Fatal(err)
	}
	if err := deps.Repo.Tx(ctx, func(tx store.Repository) error {
		return tx.(store.Structure).SetDJRolePolicy(ctx, installation, owner.ID, []id.ID{role}, now)
	}); err != nil {
		t.Fatal(err)
	}
	nonce, _, err := deps.Sessions.Challenge(ctx, device)
	if err != nil {
		t.Fatal(err)
	}
	botSession, err := deps.Sessions.Establish(ctx, auth.EstablishRequest{DeviceID: device, Nonce: nonce, Purpose: auth.PurposeSession, Sig: ed25519.Sign(botPrivate, auth.SessionPreimage(deps.Sessions.InstanceID(), device, nonce, auth.PurposeSession))})
	if err != nil {
		t.Fatal(err)
	}
	token := botSession.Token
	if err := deps.Sessions.RecordCapabilities(ctx, auth.TokenHash(token), 3, 1, 1); err != nil {
		t.Fatal(err)
	}
	path := "/v1/bot-runtime/installations/" + installation.String() + "/music/dj-roles"
	resp := getAuth(h, path, token)
	if resp.Code != http.StatusOK {
		t.Fatalf("DJ policy read = %d (%x), want 200", resp.Code, resp.Body.Bytes())
	}
	if resp.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("DJ policy Cache-Control = %q, want no-store", resp.Header().Get("Cache-Control"))
	}
	var tuple []any
	if err := cborx.Unmarshal(resp.Body.Bytes(), &tuple); err != nil {
		t.Fatal(err)
	}
	if len(tuple) != 4 {
		t.Fatalf("DJ policy tuple length = %d, want 4", len(tuple))
	}
	communityBytes, communityOK := tuple[0].([]byte)
	installationBytes, installationOK := tuple[1].([]byte)
	if !communityOK || !bytes.Equal(communityBytes, community[:]) || !installationOK || !bytes.Equal(installationBytes, installation[:]) || tuple[2] != uint64(1) {
		t.Fatalf("DJ policy tuple = %#v", tuple)
	}
	roles, ok := tuple[3].([]any)
	roleBytes, roleOK := []byte(nil), false
	if ok && len(roles) == 1 {
		roleBytes, roleOK = roles[0].([]byte)
	}
	if !ok || len(roles) != 1 || !roleOK || !bytes.Equal(roleBytes, role[:]) {
		t.Fatalf("DJ policy roles = %#v", tuple[3])
	}
	firstBody := append([]byte(nil), resp.Body.Bytes()...)
	updatedRole := id.New()
	if err := deps.Repo.PutRole(ctx, store.RoleRow{ID: updatedRole, CommunityID: community, Name: "Updated DJ", Position: 2, Created: now + 1}); err != nil {
		t.Fatal(err)
	}
	if err := deps.Repo.Tx(ctx, func(tx store.Repository) error {
		return tx.(store.Structure).SetDJRolePolicy(ctx, installation, owner.ID, []id.ID{updatedRole}, now+1)
	}); err != nil {
		t.Fatal(err)
	}
	updated := getAuth(h, path, token)
	if updated.Code != http.StatusOK || bytes.Equal(updated.Body.Bytes(), firstBody) {
		t.Fatalf("second DJ policy read = %d (%x), want fresh policy response", updated.Code, updated.Body.Bytes())
	}
	_, _, humanToken := seedAPISession(t, deps)
	if human := getAuth(h, path, humanToken); human.Code != http.StatusForbidden {
		t.Fatalf("human session DJ policy read = %d, want 403", human.Code)
	}
	if runtimeCredential := getAuth(h, path, "runtime-secret"); runtimeCredential.Code != http.StatusUnauthorized {
		t.Fatalf("runtime credential DJ policy read = %d, want 401", runtimeCredential.Code)
	}
	foreign := getAuth(h, "/v1/bot-runtime/installations/"+id.New().String()+"/music/dj-roles", token)
	if foreign.Code != http.StatusForbidden {
		t.Fatalf("cross-installation DJ policy read = %d (%x), want 403", foreign.Code, foreign.Body.Bytes())
	}

	updateInstallation := func(change func(*store.BotInstallationRow)) error {
		return deps.Repo.Tx(ctx, func(tx store.Repository) error {
			current, err := tx.GetBotInstallation(ctx, installation)
			if err != nil {
				return err
			}
			change(&current)
			current.Revision++
			current.Updated = now + 1
			return tx.UpdateBotInstallation(ctx, installation, current.Revision-1, current)
		})
	}
	if err := updateInstallation(func(current *store.BotInstallationRow) { current.Capabilities = 0 }); err != nil {
		t.Fatal(err)
	}
	if revoked := getAuth(h, path, token); revoked.Code != http.StatusForbidden {
		t.Fatalf("DJ policy read after Music capability revocation = %d (%x), want 403", revoked.Code, revoked.Body.Bytes())
	}
	if err := updateInstallation(func(current *store.BotInstallationRow) { current.Capabilities = 1 }); err != nil {
		t.Fatal(err)
	}
	if err := updateInstallation(func(current *store.BotInstallationRow) { current.State = store.BotInstallationDisabled }); err != nil {
		t.Fatal(err)
	}
	if stale := getAuth(h, path, token); stale.Code == http.StatusOK {
		t.Fatalf("stale Bot session after installation disable = %d (%x), want refusal", stale.Code, stale.Body.Bytes())
	}
}
