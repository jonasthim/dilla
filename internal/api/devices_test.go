package api_test

// devices_test.go covers the device and device-list routes as web-2a reshapes them: what a
// pending session (a host login without the recovery key, L-HTTP-57) reaches, and — task 8 — the
// verified publication, the revocation action and the history read.

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/jonasthim/dilla/internal/api"
	"github.com/jonasthim/dilla/internal/cborx"
	"github.com/jonasthim/dilla/internal/clock"
	"github.com/jonasthim/dilla/internal/id"
	"github.com/jonasthim/dilla/internal/store"
)

// cborCall sends one request through the real mux; body is CBOR-encoded when it is not nil.
func cborCall(t *testing.T, h http.Handler, method, path, token string, body any) *httptest.ResponseRecorder {
	t.Helper()
	var raw []byte
	if body != nil {
		var err error
		if raw, err = cborx.Marshal(body); err != nil {
			t.Fatalf("marshal %s %s: %v", method, path, err)
		}
	}
	req := httptest.NewRequestWithContext(context.Background(), method, path, bytes.NewReader(raw))
	if body != nil {
		req.Header.Set("Content-Type", "application/cbor")
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

// pendingSession registers a fresh browser device for user through the assertion path and
// returns its id and its pending token. The user must be listed in the harness lister.
func pendingSession(t *testing.T, h http.Handler, d api.Deps, user id.ID) (id.ID, string) {
	t.Helper()
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("GenerateKey: %v", err)
	}
	device := id.New()
	reg := []any{device, []byte(pub), uint64(1), uint64(1), bytes.Repeat([]byte{0}, 10)}
	rec := postCBOR(h, "/v1/devices/"+device.String()+"/sessions",
		establishBody(t, h, d, device, priv, reg, []byte(d.Assertions.Issue(user, false))))
	if rec.Code != http.StatusCreated {
		t.Fatalf("pending registration = %d %x", rec.Code, rec.Body.Bytes())
	}
	var out []any
	if err := cborx.Unmarshal(rec.Body.Bytes(), &out); err != nil || out[1] != uint64(1) {
		t.Fatalf("pending registration answered %v (err %v), want scope 1", out, err)
	}
	token, _ := out[0].(string)
	return device, token
}

// L-HTTP-57. Attacker statement for the 403s: a pending session is a host login without the
// recovery key; it reads and publishes only its own list (what its own enrolment needs) and no
// other route, so a stolen password reaches nothing of another user and nothing of the groups.
func TestAPendingSessionReachesItsOwnDeviceListAndNothingElse(t *testing.T) {
	h, deps := newTestAPI(t)
	ctx := context.Background()
	owner, dev, _ := seedAPIDevice(t, deps)
	listerOf(t, deps).list(owner.ID, dev.DSKPub)
	other, _, otherToken := seedAPISession(t, deps)
	stored := store.DeviceListRow{UserID: owner.ID, Version: 1, Blob: []byte{0x80},
		SSKSignature: bytes.Repeat([]byte{7}, 64), PrevHash: make([]byte, 32), Created: deps.Clock.Now().Unix()}
	if err := deps.Repo.PutDeviceList(ctx, stored); err != nil {
		t.Fatalf("PutDeviceList: %v", err)
	}
	_, pending := pendingSession(t, h, deps, owner.ID)
	own := "/v1/users/" + owner.ID.String() + "/device-list"
	theirs := "/v1/users/" + other.ID.String() + "/device-list"

	rec := cborCall(t, h, http.MethodGet, own, pending, nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("a pending session reading its own list = %d %x, want 200", rec.Code, rec.Body.Bytes())
	}
	var got []any
	if err := cborx.Unmarshal(rec.Body.Bytes(), &got); err != nil || len(got) != 4 || got[0] != uint64(1) {
		t.Fatalf("own list = %v (err %v), want [1, blob, sig, prev]", got, err)
	}
	// The publish route is reached (the handler's own 400 for an empty body, never the scope's 403).
	if rec := cborCall(t, h, http.MethodPut, own, pending, []any{}); rec.Code != http.StatusBadRequest {
		t.Fatalf("a pending session publishing its own list = %d %q, want the handler's 400", rec.Code, refusalCode(t, rec))
	}
	for _, r := range []struct {
		method, path string
		body         any
	}{
		{http.MethodGet, theirs, nil},
		{http.MethodPut, theirs, []any{}},
		{http.MethodPost, "/v1/devices", []any{}},
		{http.MethodGet, "/v1/devices", nil},
		{http.MethodDelete, "/v1/devices/" + dev.ID.String(), nil},
		{http.MethodDelete, "/v1/devices/" + dev.ID.String() + "/sessions", nil},
		{http.MethodGet, "/v1/accounts/me", nil},
		{http.MethodPost, "/v1/gateway/ticket", []any{}},
	} {
		rec := cborCall(t, h, r.method, r.path, pending, r.body)
		if rec.Code != http.StatusForbidden || refusalCode(t, rec) != "E_FORBIDDEN" {
			t.Errorf("pending %s %s = %d %q, want 403 E_FORBIDDEN", r.method, r.path, rec.Code, refusalCode(t, rec))
		}
	}
	// An enrolled session still reads any user's list (DEV-W2-34 stays open for web-2c).
	if rec := cborCall(t, h, http.MethodGet, own, otherToken, nil); rec.Code != http.StatusOK {
		t.Fatalf("an enrolled session reading another user's list = %d, want 200", rec.Code)
	}
}

// An enrolled token alone must not bypass the same device cap and hourly rate as
// assertion registration. A stolen enrolled token cannot fill unlimited rows.
func TestPostDevicesAppliesTheCapAndRate(t *testing.T) {
	h, deps := newTestAPI(t)
	user, first, token := seedAPISession(t, deps)
	keys := [][]byte{first.DSKPub}
	for i := 0; i < 7; i++ {
		pub, _, err := ed25519.GenerateKey(rand.Reader)
		if err != nil {
			t.Fatal(err)
		}
		keys = append(keys, pub)
		if err := deps.Repo.CreateDevice(t.Context(), store.DeviceRow{ID: id.New(), UserID: user.ID,
			DSKPub: pub, CredentialBlob: []byte{1}, Created: 1, LastSeen: 1}); err != nil {
			t.Fatal(err)
		}
	}
	listerOf(t, deps).list(user.ID, keys...)
	create := func() *httptest.ResponseRecorder {
		pub, _, err := ed25519.GenerateKey(rand.Reader)
		if err != nil {
			t.Fatal(err)
		}
		return cborCall(t, h, http.MethodPost, "/v1/devices", token,
			[]any{id.New(), []byte(pub), uint64(1), uint64(1), []byte{1}})
	}
	if rec := create(); rec.Code != http.StatusForbidden || refusalCode(t, rec) != "E_FORBIDDEN" {
		t.Fatalf("POST /v1/devices at cap = %d %q, want 403 E_FORBIDDEN", rec.Code, refusalCode(t, rec))
	}
	// Free the cap, then consume the hourly rate with three live unlisted rows.
	rows, err := deps.Repo.ListDevicesByUser(t.Context(), user.ID)
	if err != nil {
		t.Fatal(err)
	}
	for _, row := range rows[1:] {
		if err := deps.Repo.RevokeDevice(t.Context(), row.ID, deps.Clock.Now().Unix()); err != nil {
			t.Fatal(err)
		}
	}
	for i := 0; i < 3; i++ {
		if rec := create(); rec.Code != http.StatusOK {
			t.Fatalf("POST /v1/devices #%d = %d", i+1, rec.Code)
		}
	}
	if rec := create(); rec.Code != http.StatusTooManyRequests || refusalCode(t, rec) != "E_RATE_LIMITED" {
		t.Fatalf("POST /v1/devices over rate = %d %q, want 429 E_RATE_LIMITED", rec.Code, refusalCode(t, rec))
	}
}

// The no-list clause keeps a web-1 account's first device live while its owner
// uses the enrolled route; an absent list is not an omitted entry in a list.
func TestPostDevicesDoesNotExpireANoListAccount(t *testing.T) {
	h, deps := newTestAPI(t)
	user, first, token := seedAPISession(t, deps)
	deps.Clock.(*clock.Fake).Advance(24 * time.Hour)
	pub, _, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	rec := cborCall(t, h, http.MethodPost, "/v1/devices", token,
		[]any{id.New(), []byte(pub), uint64(1), uint64(1), []byte{1}})
	if rec.Code != http.StatusOK {
		t.Fatalf("no-list device creation = %d", rec.Code)
	}
	row, err := deps.Repo.GetDevice(t.Context(), first.ID)
	if err != nil || row.RevokedAt != nil || row.UserID != user.ID {
		t.Fatalf("first device after POST = %+v, err %v; want live", row, err)
	}
}
