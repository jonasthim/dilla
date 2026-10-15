package dilladtest

import (
	"context"
	"encoding/hex"
	"testing"

	"github.com/jonasthim/dilla/internal/id"
)

// satisfyFactor clears a seeded account's owed second factor (web3.6 S1) through the repository,
// for a test about something else. A seeded human owes one exactly as a real sign-up does, and
// neither the control listener nor SeedRequest offers a way round that: this test-file helper is
// the only one.
func satisfyFactor(t *testing.T, h *Host, user string) {
	t.Helper()
	uid, err := id.Parse(user)
	if err != nil {
		t.Fatalf("seeded user id %q: %v", user, err)
	}
	if err := h.Server().Repo().SetFactorOwed(context.Background(), uid, false); err != nil {
		t.Fatalf("SetFactorOwed(%s, false): %v", uid, err)
	}
}

// seedOne writes the owed flag as POST /v1/accounts does: a seeded human owes a second factor, a
// seeded bot does not (only human accounts sign in with one).
func TestASeededHumanOwesASecondFactorAndABotDoesNot(t *testing.T) {
	h := sfuHost(t, false)
	ctx := t.Context()
	zero := func(n int) string { return hex.EncodeToString(make([]byte, n)) }
	req := func(name string, bot bool) SeedRequest {
		return SeedRequest{Username: name, Display: name, Bot: bot, UMKPub: zero(32), SSKPub: zero(32),
			SigUMKSSK: zero(64), Devices: []Device{{DeviceID: id.New().String(), DSKPub: zero(32), Credential: "01"}}}
	}
	out, err := SeedUsers(ctx, h.Server(), []SeedRequest{req("human", false), req("bot", true)})
	if err != nil {
		t.Fatalf("SeedUsers: %v", err)
	}
	for i, want := range []bool{true, false} {
		uid, err := id.Parse(out[i].UserID)
		if err != nil {
			t.Fatalf("user id: %v", err)
		}
		u, err := h.Server().Repo().GetUser(ctx, uid)
		if err != nil {
			t.Fatalf("GetUser: %v", err)
		}
		if u.FactorOwed != want {
			t.Errorf("seeded %s: factor_owed = %v, want %v", u.Username, u.FactorOwed, want)
		}
	}
}
