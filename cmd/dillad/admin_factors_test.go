package main

import (
	"errors"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/jonasthim/dilla/internal/auth"
	"github.com/jonasthim/dilla/internal/id"
	"github.com/jonasthim/dilla/internal/store"
)

// seedEveryFactor gives the user the three things reset-factors removes: a confirmed TOTP secret,
// backup codes and a passkey.
func (h *cliHarness) seedEveryFactor(t *testing.T, uid id.ID) {
	t.Helper()
	ctx := t.Context()
	h.SeedFactor(t, uid)
	if err := h.Repo(t).PutRecoveryCodes(ctx, uid, [][]byte{make([]byte, 32)}, h.Now()); err != nil {
		t.Fatalf("PutRecoveryCodes: %v", err)
	}
	handle := make([]byte, 64)
	copy(handle, uid[:])
	if err := h.Repo(t).PutWebauthnUser(ctx, uid, "dilla.test", handle, h.Now()); err != nil {
		t.Fatalf("PutWebauthnUser: %v", err)
	}
	if err := h.Repo(t).PutWebauthnCredential(ctx, store.WebauthnCredentialRow{
		CredID: append([]byte("cred-"), uid[:]...), RPID: "dilla.test", UserID: uid, PublicKey: []byte{1}, Flags: []byte{0},
		Name: "key", Created: h.Now(),
	}); err != nil {
		t.Fatalf("PutWebauthnCredential: %v", err)
	}
}

func TestResetFactorsRemovesTheFactorsAndKeepsTheSessions(t *testing.T) {
	h := newCLIHarness(t)
	alice := h.SeedUser(t, "alice")
	bob := h.SeedUser(t, "bob")
	h.seedEveryFactor(t, alice)
	h.seedEveryFactor(t, bob)
	tok := h.SeedSession(t, alice)

	code, out := h.Run(t, "admin", "user", "reset-factors", "--username=alice", "--yes", "--config="+h.ConfigPath)
	if code != 0 || !strings.Contains(out, "alice") {
		t.Fatalf("reset-factors = %d: %s", code, out)
	}
	repo := h.Repo(t)
	if _, err := repo.GetTOTP(t.Context(), alice); !errors.Is(err, store.ErrNotFound) {
		t.Errorf("alice's TOTP survived: %v", err)
	}
	if n, _ := repo.CountRecoveryCodes(t.Context(), alice); n != 0 {
		t.Errorf("%d backup codes survived", n)
	}
	if creds, _ := repo.ListWebauthnCredentials(t.Context(), alice, "dilla.test"); len(creds) != 0 {
		t.Errorf("%d passkeys survived", len(creds))
	}
	if u, _ := repo.GetUser(t.Context(), alice); !u.FactorOwed {
		t.Error("factor_owed was not set")
	}
	if _, err := repo.GetSessionByHash(t.Context(), auth.TokenHash(tok), h.Now()); err != nil {
		t.Errorf("the session did not survive (D5): %v", err)
	}
	audit, err := repo.ListAudit(t.Context(), 0, 100)
	if err != nil {
		t.Fatalf("ListAudit: %v", err)
	}
	if !slices.ContainsFunc(audit, func(a store.AuditRow) bool {
		return a.Action == "user.factors_reset" && a.Target == alice.String()
	}) {
		t.Errorf("no user.factors_reset audit row: %+v", audit)
	}
	// Control: bob, not named, keeps everything.
	if _, err := repo.GetTOTP(t.Context(), bob); err != nil {
		t.Errorf("bob's TOTP was removed: %v", err)
	}
	if u, _ := repo.GetUser(t.Context(), bob); u.FactorOwed {
		t.Error("bob's factor_owed was set")
	}
}

func TestResetFactorsNeedsYesAndAnAccount(t *testing.T) {
	h := newCLIHarness(t)
	alice := h.SeedUser(t, "alice")
	h.seedEveryFactor(t, alice)
	for _, args := range [][]string{
		{"--username=alice"},
		{"--yes"},
		{"--id=" + alice.String(), "--username=alice", "--yes"},
	} {
		code, _, stderr := h.Run3(t, append([]string{"admin", "user", "reset-factors"}, append(args, "--config="+h.ConfigPath)...)...)
		if code != 2 {
			t.Errorf("%v: exit %d, want 2: %s", args, code, stderr)
		}
	}
	if code, _ := h.Run(t, "admin", "user", "reset-factors", "--username=nobody", "--yes", "--config="+h.ConfigPath); code == 0 {
		t.Error("an unknown username was reset")
	}
	if _, err := h.Repo(t).GetTOTP(t.Context(), alice); err != nil {
		t.Errorf("a refused reset removed the TOTP: %v", err)
	}
}

// The CLI is another process and holds no gateway: the serving process's liveness tick finds the
// session row's account owing a factor and closes the socket 4003, so the client's reconnect meets
// E_FACTOR_REQUIRED. Control: the same tick before the reset closes nothing.
func TestResetFactorsClosesALiveSocketAtTheNextHeartbeat(t *testing.T) {
	h := newCLIHarness(t)
	uid := h.SeedUser(t, "alice")
	h.SeedFactor(t, uid)
	h.SeedSession(t, uid)
	conn := h.OpenGatewayConn(t, uid)

	h.clk.Advance(h.HeartbeatInterval() + time.Second)
	if code, err := conn.WaitClosed(t, 300*time.Millisecond); err == nil {
		t.Fatalf("a connection with a factor was closed %d by the heartbeat", code)
	}

	if code, _ := h.Run(t, "admin", "user", "reset-factors", "--id="+uid.String(), "--yes", "--config="+h.ConfigPath); code != 0 {
		t.Fatal("reset-factors failed")
	}
	h.clk.Advance(h.HeartbeatInterval() + time.Second)
	code, err := conn.WaitClosed(t, 10*time.Second)
	if err != nil {
		t.Fatalf("the socket was still open a heartbeat after the reset: %v", err)
	}
	if code != 4003 {
		t.Fatalf("close code = %d, want 4003", code)
	}
}
