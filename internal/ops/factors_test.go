package ops_test

import (
	"context"
	"slices"
	"testing"

	"github.com/jonasthim/dilla/internal/id"
	"github.com/jonasthim/dilla/internal/ops"
	"github.com/jonasthim/dilla/internal/store"
)

// seedFactorUser is a person holding a confirmed TOTP, a passkey and backup codes, owing nothing,
// with two devices that each hold a session.
func seedFactorUser(t *testing.T, h *opsHarness) (uid id.ID, devices []id.ID) {
	t.Helper()
	ctx := t.Context()
	now := h.Clock.Now().Unix()
	uid = id.New()
	if err := h.Repo.CreateUser(ctx, store.UserRow{
		ID: uid, Username: "factored", Display: "factored",
		UMKPub: make([]byte, 32), SSKPub: make([]byte, 32), SigUMKSSK: make([]byte, 64), Created: now,
	}); err != nil {
		t.Fatalf("CreateUser: %v", err)
	}
	for range 2 {
		d := id.New()
		devices = append(devices, d)
		if err := h.Repo.CreateDevice(ctx, store.DeviceRow{
			ID: d, UserID: uid, DSKPub: make([]byte, 32), CredentialBlob: []byte{1}, LastSeen: now, Created: now,
		}); err != nil {
			t.Fatalf("CreateDevice: %v", err)
		}
		if err := h.Repo.CreateSession(ctx, store.SessionRow{
			TokenHash: []byte(d.String()), DeviceID: d, UserID: uid, Scope: 1, Created: now, Expires: now + 3600, IdleExpires: now + 3600,
		}); err != nil {
			t.Fatalf("CreateSession: %v", err)
		}
	}
	confirmed := now
	if err := h.Repo.PutTOTP(ctx, store.TOTPRow{UserID: uid, Secret: make([]byte, 20), Digits: 6, Period: 30,
		Algorithm: "SHA1", ConfirmedAt: &confirmed, Created: now}); err != nil {
		t.Fatalf("PutTOTP: %v", err)
	}
	if err := h.Repo.PutRecoveryCodes(ctx, uid, [][]byte{make([]byte, 32), append(make([]byte, 31), 1)}, now); err != nil {
		t.Fatalf("PutRecoveryCodes: %v", err)
	}
	if err := h.Repo.PutWebauthnUser(ctx, uid, "dilla.test", make([]byte, 64), now); err != nil {
		t.Fatalf("PutWebauthnUser: %v", err)
	}
	if err := h.Repo.PutWebauthnCredential(ctx, store.WebauthnCredentialRow{
		CredID: []byte("cred-1"), RPID: "dilla.test", UserID: uid, PublicKey: []byte{1}, Flags: []byte{0}, Name: "key", Created: now,
	}); err != nil {
		t.Fatalf("PutWebauthnCredential: %v", err)
	}
	return uid, devices
}

func assertNoFactors(t *testing.T, h *opsHarness, uid id.ID) {
	t.Helper()
	ctx := t.Context()
	if _, err := h.Repo.GetTOTP(ctx, uid); err == nil {
		t.Error("a TOTP row survived the reset")
	}
	if n, _ := h.Repo.CountRecoveryCodes(ctx, uid); n != 0 {
		t.Errorf("%d backup codes survived the reset", n)
	}
	if creds, _ := h.Repo.ListWebauthnCredentials(ctx, uid, "dilla.test"); len(creds) != 0 {
		t.Errorf("%d passkeys survived the reset", len(creds))
	}
	u, err := h.Repo.GetUser(ctx, uid)
	if err != nil || !u.FactorOwed {
		t.Errorf("factor_owed = %v (%v), want true", u.FactorOwed, err)
	}
}

func TestResetFactorsRemovesEveryFactorAndKeepsTheSessions(t *testing.T) {
	h := newOpsHarness(t)
	uid, devices := seedFactorUser(t, h)
	var closed []id.ID
	now := h.Clock.Now().Unix()
	if err := ops.ResetFactors(t.Context(), h.Repo, func(d id.ID) { closed = append(closed, d) }, uid, now); err != nil {
		t.Fatalf("ResetFactors: %v", err)
	}
	assertNoFactors(t, h, uid)
	for _, d := range devices {
		if n, err := h.Repo.CountSessionsByDevice(t.Context(), d); err != nil || n != 1 {
			t.Errorf("device %s keeps %d sessions (%v), want 1: the reset must not sign anyone out", d, n, err)
		}
		if n := countOf(closed, d); n != 1 {
			t.Errorf("the closer ran %d times for device %s, want 1", n, d)
		}
	}
	audit, err := h.Repo.ListAudit(t.Context(), 0, 100)
	if err != nil {
		t.Fatalf("ListAudit: %v", err)
	}
	if !slices.ContainsFunc(audit, func(a store.AuditRow) bool {
		return a.Action == "user.factors_reset" && a.Target == uid.String() && a.At == now
	}) {
		t.Errorf("no user.factors_reset audit row: %+v", audit)
	}
}

func countOf(ids []id.ID, want id.ID) int {
	n := 0
	for _, d := range ids {
		if d == want {
			n++
		}
	}
	return n
}

func TestResetFactorsForAnUnknownUserChangesNothing(t *testing.T) {
	h := newOpsHarness(t)
	called := false
	if err := ops.ResetFactors(t.Context(), h.Repo, func(id.ID) { called = true }, id.New(), 1); err == nil {
		t.Fatal("an unknown user was reset")
	}
	if called {
		t.Error("the closer ran for a user that does not exist")
	}
}

// hookedRepo runs hook just before the reset's transaction opens, the shape of roles_test.go's
// in-tx hook: the state changes between the caller's read and the transaction.
type hookedRepo struct {
	store.Repository
	hook func(ctx context.Context)
}

func (r hookedRepo) Tx(ctx context.Context, fn func(store.Repository) error) error {
	if r.hook != nil {
		r.hook(ctx)
	}
	return r.Repository.Tx(ctx, fn)
}

func TestAFactorConfirmedJustBeforeTheResetIsRemovedToo(t *testing.T) {
	for _, tc := range []struct {
		name string
		hook bool
	}{{"control: nothing happens in between", false}, {"a passkey lands before the transaction", true}} {
		t.Run(tc.name, func(t *testing.T) {
			h := newOpsHarness(t)
			uid, _ := seedFactorUser(t, h)
			repo := hookedRepo{Repository: h.Repo}
			if tc.hook {
				repo.hook = func(ctx context.Context) {
					if err := h.Repo.PutWebauthnCredential(ctx, store.WebauthnCredentialRow{
						CredID: []byte("cred-late"), RPID: "dilla.test", UserID: uid, PublicKey: []byte{1}, Flags: []byte{0}, Name: "late",
						Created: h.Clock.Now().Unix(),
					}); err != nil {
						t.Errorf("hook: %v", err)
					}
					if err := h.Repo.SetFactorOwed(ctx, uid, false); err != nil {
						t.Errorf("hook: %v", err)
					}
				}
			}
			if err := ops.ResetFactors(t.Context(), repo, nil, uid, h.Clock.Now().Unix()); err != nil {
				t.Fatalf("ResetFactors: %v", err)
			}
			assertNoFactors(t, h, uid)
		})
	}
}
