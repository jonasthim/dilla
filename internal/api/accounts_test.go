package api_test

import (
	"bytes"
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/jonasthim/dilla/internal/auth"
	"github.com/jonasthim/dilla/internal/cborx"
	"github.com/jonasthim/dilla/internal/id"
	"github.com/jonasthim/dilla/internal/store"
)

func TestCreateAccountRedeemsTheInviteAndReservesTheUsername(t *testing.T) {
	h, deps := newTestAPI(t)
	code := seedInvite(t, deps, 1)

	body, _ := cborx.Marshal([]any{
		code, "Jonas", "Jonas Thim",
		make([]byte, 32), make([]byte, 32), make([]byte, 64), "correct horse battery staple",
		[]any{id.New(), make([]byte, 32), uint64(0), uint64(0), []byte{1}},
	})
	res := post(t, h, "/v1/accounts", body)
	if res.Code != http.StatusOK {
		t.Fatalf("status = %d, body %x", res.Code, res.Body.Bytes())
	}
	var out []any
	if err := cborx.Unmarshal(res.Body.Bytes(), &out); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(out) != 4 {
		t.Fatalf("response has %d elements, want 4", len(out))
	}
	u, err := deps.Repo.GetUserByUsername(context.Background(), "jonas")
	if err != nil {
		t.Fatalf("the username was not normalised to %q: %v", "jonas", err)
	}
	if u.Display != "Jonas Thim" {
		t.Fatalf("display = %q", u.Display)
	}
	// A second account on a spent one-use invite is refused, and with the
	// invite's own code, not a generic 400.
	res = post(t, h, "/v1/accounts", body)
	if res.Code != http.StatusGone {
		t.Fatalf("second registration status = %d, want 410 E_INVITE_INVALID", res.Code)
	}
}

func TestSixtyFourConcurrentRedemptionsYieldOneAccount(t *testing.T) {
	h, deps := newTestAPI(t)
	code := seedInvite(t, deps, 1)
	var wg sync.WaitGroup
	codes := make(chan int, 64)
	for i := 0; i < 64; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			body, _ := cborx.Marshal([]any{
				code, "user" + id.New().String()[:8], "User",
				make([]byte, 32), make([]byte, 32), make([]byte, 64), nil,
				[]any{id.New(), make([]byte, 32), uint64(0), uint64(0), []byte{1}},
			})
			codes <- post(t, h, "/v1/accounts", body).Code
		}(i)
	}
	wg.Wait()
	close(codes)
	ok := 0
	for c := range codes {
		if c == http.StatusOK {
			ok++
		}
	}
	if ok != 1 {
		t.Fatalf("%d registrations succeeded on a max_uses = 1 invite, want 1", ok)
	}
}

func TestADeletedAccountKeepsItsUsernameReserved(t *testing.T) {
	h, deps := newTestAPI(t)
	ctx := context.Background()
	u := store.UserRow{ID: id.New(), Username: "jonas", Display: "Jonas",
		UMKPub: make([]byte, 32), SSKPub: make([]byte, 32), SigUMKSSK: make([]byte, 64), Created: 1}
	if err := deps.Repo.CreateUser(ctx, u); err != nil {
		t.Fatalf("CreateUser: %v", err)
	}
	if err := deps.Repo.TombstoneUser(ctx, u.ID, 2); err != nil {
		t.Fatalf("TombstoneUser: %v", err)
	}
	code := seedInvite(t, deps, 1)
	body, _ := cborx.Marshal([]any{
		code, "Jonas", "Someone Else",
		make([]byte, 32), make([]byte, 32), make([]byte, 64), nil,
		[]any{id.New(), make([]byte, 32), uint64(0), uint64(0), []byte{1}},
	})
	if res := post(t, h, "/v1/accounts", body); res.Code != http.StatusConflict {
		t.Fatalf("re-registering a tombstoned username gave %d, want 409", res.Code)
	}
	_ = h
}

func TestRevokingADeviceDeletesItsSessionsInOneTransaction(t *testing.T) {
	h, deps := newTestAPI(t)
	ctx := context.Background()
	u, d, token := seedSession(t, deps)
	req := httptest.NewRequestWithContext(t.Context(), http.MethodDelete, "/v1/devices/"+d.ID.String(), nil)
	req.Header.Set("Authorization", "Bearer "+token)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("DELETE device = %d, want 204", rec.Code)
	}
	n, err := deps.Repo.CountSessionsByDevice(ctx, d.ID)
	if err != nil {
		t.Fatalf("CountSessionsByDevice: %v", err)
	}
	if n != 0 {
		t.Fatalf("%d sessions survived the revocation", n)
	}
	device, err := deps.Repo.GetDevice(ctx, d.ID)
	if err != nil {
		t.Fatalf("GetDevice: %v", err)
	}
	if device.RevokedAt == nil {
		t.Fatal("the device was not marked revoked")
	}
	_ = u
}

func TestInviteLandingNeverMutates(t *testing.T) {
	h, deps := newTestAPI(t)
	code := seedInvite(t, deps, 1)
	req := httptest.NewRequestWithContext(t.Context(), http.MethodGet, "/i/"+code, nil)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d", rec.Code)
	}
	if got := rec.Header().Get("Cache-Control"); got != "no-store" {
		t.Fatalf("Cache-Control = %q, want no-store", got)
	}
	if got := rec.Header().Get("Referrer-Policy"); got != "no-referrer" {
		t.Fatalf("Referrer-Policy = %q, want no-referrer", got)
	}
	if bytes.Contains(rec.Body.Bytes(), []byte("<script")) {
		t.Fatal("the invite landing page carries script")
	}
	inv, err := deps.Repo.GetInviteByHash(context.Background(), auth.HashInviteCode(code))
	if err != nil {
		t.Fatalf("GetInviteByHash: %v", err)
	}
	if inv.UsedCount != 0 {
		t.Fatal("GET /i/{code} consumed a use")
	}
}

// users.flags bit 0 is the instance admin. It is set from the redeemed invite's
// grants_admin and nowhere else, so without this the bootstrap invite dillad
// init mints grants nothing and no instance admin ever exists.
func TestABootstrapInviteMakesAnInstanceAdmin(t *testing.T) {
	h, deps := newTestAPI(t)
	admin := seedAdminInvite(t, deps)
	plain := seedInvite(t, deps, 1)

	for _, tc := range []struct {
		name      string
		code      string
		username  string
		wantAdmin bool
	}{
		{"bootstrap invite", admin, "Root", true},
		{"ordinary invite", plain, "Jonas", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			body, _ := cborx.Marshal([]any{
				tc.code, tc.username, tc.username,
				make([]byte, 32), make([]byte, 32), make([]byte, 64), nil,
				[]any{id.New(), make([]byte, 32), uint64(0), uint64(0), []byte{1}},
			})
			if res := post(t, h, "/v1/accounts", body); res.Code != http.StatusOK {
				t.Fatalf("status = %d", res.Code)
			}
			u, err := deps.Repo.GetUserByUsername(context.Background(), strings.ToLower(tc.username))
			if err != nil {
				t.Fatalf("GetUserByUsername: %v", err)
			}
			got := u.Flags&store.UserFlagInstanceAdmin != 0
			if got != tc.wantAdmin {
				t.Fatalf("instance admin = %v, want %v (flags %d)", got, tc.wantAdmin, u.Flags)
			}
		})
	}
}
