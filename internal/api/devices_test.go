package api_test

// devices_test.go covers the device and device-list routes as web-2a reshapes them: what a
// pending session (a host login without the recovery key, L-HTTP-57) reaches, and — task 8 — the
// verified publication, the revocation action and the history read.

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/jonasthim/dilla/internal/api"
	"github.com/jonasthim/dilla/internal/auth"
	"github.com/jonasthim/dilla/internal/cborx"
	"github.com/jonasthim/dilla/internal/clock"
	"github.com/jonasthim/dilla/internal/ds"
	"github.com/jonasthim/dilla/internal/id"
	"github.com/jonasthim/dilla/internal/mlswasi"
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

// The enrolled route uses the same deterministic oldest-unlisted eviction as
// assertion registration; a newer pending row retains its place.
func TestPostDevicesEvictsOldestUnlistedAtCap(t *testing.T) {
	h, deps := newTestAPI(t)
	user, first, token := seedAPISession(t, deps)
	keys := [][]byte{first.DSKPub}
	for i := 0; i < 5; i++ {
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
	now := deps.Clock.Now().Unix()
	var unlisted [2]id.ID
	for i := range unlisted {
		pub, _, err := ed25519.GenerateKey(rand.Reader)
		if err != nil {
			t.Fatal(err)
		}
		unlisted[i] = id.New()
		if err := deps.Repo.CreateDevice(t.Context(), store.DeviceRow{ID: unlisted[i], UserID: user.ID,
			DSKPub: pub, CredentialBlob: []byte{1}, Created: now - int64(2-i), LastSeen: now}); err != nil {
			t.Fatal(err)
		}
	}
	pub, _, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	rec := cborCall(t, h, http.MethodPost, "/v1/devices", token,
		[]any{id.New(), []byte(pub), uint64(1), uint64(1), []byte{1}})
	if rec.Code != http.StatusOK {
		t.Fatalf("POST at cap = %d %x, want 200", rec.Code, rec.Body.Bytes())
	}
	for i, wantRevoked := range []bool{true, false} {
		row, err := deps.Repo.GetDevice(t.Context(), unlisted[i])
		if err != nil || (row.RevokedAt != nil) != wantRevoked {
			t.Fatalf("unlisted row %d = %+v, err %v; want revoked %t", i, row, err, wantRevoked)
		}
	}
}

func TestPostDevicesSweepsExpiredUnlistedRow(t *testing.T) {
	h, deps := newTestAPI(t)
	user, first, token := seedAPISession(t, deps)
	listerOf(t, deps).list(user.ID, first.DSKPub)
	pub, _, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	old := id.New()
	if err := deps.Repo.CreateDevice(t.Context(), store.DeviceRow{ID: old, UserID: user.ID,
		DSKPub: pub, CredentialBlob: []byte{1}, Created: deps.Clock.Now().Unix() - 86400, LastSeen: 1}); err != nil {
		t.Fatal(err)
	}
	newPub, _, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	rec := cborCall(t, h, http.MethodPost, "/v1/devices", token,
		[]any{id.New(), []byte(newPub), uint64(1), uint64(1), []byte{1}})
	if rec.Code != http.StatusOK {
		t.Fatalf("POST after expiry = %d %x, want 200", rec.Code, rec.Body.Bytes())
	}
	row, err := deps.Repo.GetDevice(t.Context(), old)
	if err != nil || row.RevokedAt == nil {
		t.Fatalf("expired unlisted row = %+v, err %v; want revoked", row, err)
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

// signedListPut is version `version` of user's list chained to prevBlob (nil: 32 zero bytes),
// signed by ssk as a client signs it; it returns the PUT body and the blob.
func signedListPut(t *testing.T, ssk ed25519.PrivateKey, user id.ID, version uint64, prevBlob []byte, entries []apiListEntry) ([]any, []byte) {
	t.Helper()
	prev := make([]byte, 32)
	if prevBlob != nil {
		sum := sha256.Sum256(prevBlob)
		prev = sum[:]
	}
	unsigned, err := cborx.Marshal(apiListUnsigned{V: 1, UserID: user[:], Version: version, PrevHash: prev, Entries: entries})
	if err != nil {
		t.Fatalf("encode the unsigned list: %v", err)
	}
	sig := ed25519.Sign(ssk, append([]byte("dilla devices v1"), unsigned...))
	blob, err := cborx.Marshal(apiListSigned{V: 1, UserID: user[:], Version: version, PrevHash: prev, Entries: entries, SigSSK: sig})
	if err != nil {
		t.Fatalf("encode the signed list: %v", err)
	}
	return []any{version, blob, sig, prev}, blob
}

// listedUser is a user whose users.ssk_pub is SSK's public half, with enrolled devices.
type listedUser struct {
	User   store.UserRow
	SSK    ed25519.PrivateKey
	Devs   []store.DeviceRow
	Tokens []string
}

func entryOf(u listedUser, i int, revokedAt *uint64) apiListEntry {
	return apiListEntry{DeviceID: u.Devs[i].ID[:], DSKPub: u.Devs[i].DSKPub, Tier: uint64(u.Devs[i].Tier), AddedAt: 1, RevokedAt: revokedAt}
}

// seedListedUser writes the user and n native devices and establishes each through the real
// session path (the harness lister answers no list, so each is enrolled).
func seedListedUser(t *testing.T, d api.Deps, seed byte, n int) listedUser {
	t.Helper()
	ctx := context.Background()
	ssk := ed25519.NewKeyFromSeed(bytes.Repeat([]byte{seed}, 32))
	now := d.Clock.Now().Unix()
	u := store.UserRow{ID: id.New(), Username: "lister" + id.New().String()[:8], Display: "Lister",
		UMKPub: make([]byte, 32), SSKPub: ssk.Public().(ed25519.PublicKey), SigUMKSSK: make([]byte, 64), Created: now}
	if err := d.Repo.CreateUser(ctx, u); err != nil {
		t.Fatalf("CreateUser: %v", err)
	}
	out := listedUser{User: u, SSK: ssk}
	for i := 0; i < n; i++ {
		pub, priv, err := ed25519.GenerateKey(rand.Reader)
		if err != nil {
			t.Fatalf("GenerateKey: %v", err)
		}
		dev := store.DeviceRow{ID: id.New(), UserID: u.ID, DSKPub: pub, CredentialBlob: []byte{1}, LastSeen: now, Created: now - 7200}
		if err := d.Repo.CreateDevice(ctx, dev); err != nil {
			t.Fatalf("CreateDevice: %v", err)
		}
		nonce, _, err := d.Sessions.Challenge(ctx, dev.ID)
		if err != nil {
			t.Fatalf("Challenge: %v", err)
		}
		pre := auth.SessionPreimage(d.Sessions.InstanceID(), dev.ID, nonce, auth.PurposeSession)
		tok, err := d.Sessions.Establish(ctx, auth.EstablishRequest{DeviceID: dev.ID, Nonce: nonce,
			Purpose: auth.PurposeSession, Sig: ed25519.Sign(priv, pre)})
		if err != nil {
			t.Fatalf("Establish: %v", err)
		}
		out.Devs = append(out.Devs, dev)
		out.Tokens = append(out.Tokens, tok.Token)
	}
	return out
}

// listAPI is the api harness with the real device-list verifier — the committed wasi core's
// device_list_entries — and an optional AfterDeviceList hook.
func listAPI(t *testing.T, hook func(ctx context.Context, user id.ID, revoked []id.ID)) (http.Handler, api.Deps) {
	t.Helper()
	wasm, err := os.ReadFile(filepath.Join("..", "mlswasi", "testdata", "dilla_core_wasi.wasm"))
	if err != nil {
		t.Fatalf("read the wasi core: %v", err)
	}
	rt, err := mlswasi.New(context.Background(), wasm, mlswasi.Options{PoolSize: 1, CacheDir: apiWasmCacheDir(t)})
	if err != nil {
		t.Fatalf("mlswasi.New: %v", err)
	}
	t.Cleanup(func() { _ = rt.Close(context.Background()) })
	return newTestAPIWired(t, func(d *api.Deps) {
		d.DeviceLists = ds.NewDeviceLists(d.Repo, rt)
		d.AfterDeviceList = hook
	})
}

// wantListRefusal requires status and the CBOR error [code, detail, …].
func wantListRefusal(t *testing.T, rec *httptest.ResponseRecorder, status int, code, detail string) {
	t.Helper()
	if rec.Code != status {
		t.Fatalf("status %d (%x), want %d %s %q", rec.Code, rec.Body.Bytes(), status, code, detail)
	}
	var body []any
	if err := cborx.Unmarshal(rec.Body.Bytes(), &body); err != nil || len(body) < 2 {
		t.Fatalf("error body %x (err %v)", rec.Body.Bytes(), err)
	}
	if body[0] != code || body[1] != detail {
		t.Fatalf("refusal %v %q, want %s %q", body[0], body[1], code, detail)
	}
}

// L-HTTP-55. Attacker statement: only the user's own sessions reach the route; the verification
// keeps a stolen session (no SSK_priv) from storing an unverifiable list that would lock every
// device of the user out (DEV-W2-24); the 409 is a race between the user's own devices, cured by
// a refetch.
func TestAPublishedDeviceListIsVerified(t *testing.T) {
	h, deps := listAPI(t, nil)
	lu := seedListedUser(t, deps, 0x5a, 1)
	path := "/v1/users/" + lu.User.ID.String() + "/device-list"
	put := func(body []any) *httptest.ResponseRecorder {
		return cborCall(t, h, http.MethodPut, path, lu.Tokens[0], body)
	}
	entries := []apiListEntry{entryOf(lu, 0, nil)}

	genesis2, _ := signedListPut(t, lu.SSK, lu.User.ID, 2, nil, entries)
	wantListRefusal(t, put(genesis2), http.StatusConflict, "E_INVALID_REQUEST", "device-list version 2 is not the next version")
	body1, blob1 := signedListPut(t, lu.SSK, lu.User.ID, 1, nil, entries)
	if rec := put(body1); rec.Code != http.StatusNoContent {
		t.Fatalf("v1 = %d %x, want 204", rec.Code, rec.Body.Bytes())
	}

	body2, blob2 := signedListPut(t, lu.SSK, lu.User.ID, 2, blob1, entries)
	for i, v := range map[int]any{0: uint64(3), 2: bytes.Repeat([]byte{9}, 64), 3: bytes.Repeat([]byte{9}, 32)} {
		lying := slices.Clone(body2)
		lying[i] = v
		wantListRefusal(t, put(lying), http.StatusBadRequest, "E_INVALID_REQUEST", "device list elements disagree")
	}
	wantListRefusal(t, put([]any{uint64(2), []byte{0x80}, body2[2], body2[3]}), http.StatusBadRequest,
		"E_INVALID_REQUEST", "device list elements disagree")

	forged, _ := signedListPut(t, ed25519.NewKeyFromSeed(bytes.Repeat([]byte{0x77}, 32)), lu.User.ID, 2, blob1, entries)
	wantListRefusal(t, put(forged), http.StatusBadRequest, "E_INVALID_REQUEST", "device list does not verify")
	elsewhere, _ := signedListPut(t, lu.SSK, id.New(), 2, blob1, entries)
	wantListRefusal(t, put(elsewhere), http.StatusBadRequest, "E_INVALID_REQUEST", "device list does not verify")

	skip, _ := signedListPut(t, lu.SSK, lu.User.ID, 3, blob1, entries)
	wantListRefusal(t, put(skip), http.StatusConflict, "E_INVALID_REQUEST", "device-list version 3 is not the next version")
	// A list chaining from the wrong parent is refused.
	wrongParent, _ := signedListPut(t, lu.SSK, lu.User.ID, 2, []byte("not the newest list"), entries)
	wantListRefusal(t, put(wrongParent), http.StatusConflict, "E_INVALID_REQUEST", "device-list version 2 is not the next version")

	newest, err := deps.Repo.GetDeviceList(context.Background(), lu.User.ID)
	if err != nil || newest.Version != 1 || !bytes.Equal(newest.Blob, blob1) {
		t.Fatalf("after the refusals the newest is v%d (err %v), want v1 unchanged", newest.Version, err)
	}
	if rec := put(body2); rec.Code != http.StatusNoContent {
		t.Fatalf("v2 = %d %x, want 204", rec.Code, rec.Body.Bytes())
	}
	wantListRefusal(t, put(body2), http.StatusConflict, "E_INVALID_REQUEST", "device-list version 2 is not the next version")
	got := cborCall(t, h, http.MethodGet, path, lu.Tokens[0], nil)
	var row []any
	if err := cborx.Unmarshal(got.Body.Bytes(), &row); err != nil || row[0] != uint64(2) || !bytes.Equal(row[1].([]byte), blob2) {
		t.Fatalf("GET after v2 = %v (err %v), want v2", row, err)
	}
}

// protocol/02 item 6, Q13. Attacker statement: the action touches only devices of this user that
// the user's SSK signed as revoked; another user's device named in a list is ignored; the
// publisher may revoke itself.
func TestARevokingListRevokesTheDeviceItsSessionsAndItsSockets(t *testing.T) {
	var closed []id.ID
	var hooked [][]id.ID
	h, deps := listAPI(t, func(_ context.Context, _ id.ID, revoked []id.ID) { hooked = append(hooked, revoked) })
	deps.Sessions.OnRevoke = func(dev id.ID) { closed = append(closed, dev) }
	ctx := context.Background()
	lu := seedListedUser(t, deps, 0x5a, 2)
	stranger := seedListedUser(t, deps, 0x6b, 1)
	path := "/v1/users/" + lu.User.ID.String() + "/device-list"
	put := func(token string, body []any) {
		t.Helper()
		if rec := cborCall(t, h, http.MethodPut, path, token, body); rec.Code != http.StatusNoContent {
			t.Fatalf("PUT = %d %x, want 204", rec.Code, rec.Body.Bytes())
		}
	}
	me := func(token string) int { return doAuth(h, http.MethodGet, "/v1/accounts/me", token).Code }

	body1, blob1 := signedListPut(t, lu.SSK, lu.User.ID, 1, nil, []apiListEntry{entryOf(lu, 0, nil), entryOf(lu, 1, nil)})
	put(lu.Tokens[0], body1)
	if len(closed) != 0 || len(hooked) != 1 || len(hooked[0]) != 0 {
		t.Fatalf("a list that revokes nothing: closed %v, hook %v", closed, hooked)
	}

	now := uint64(deps.Clock.Now().Unix())
	strangerEntry := apiListEntry{DeviceID: stranger.Devs[0].ID[:], DSKPub: stranger.Devs[0].DSKPub, AddedAt: 1, RevokedAt: &now}
	revoking := []apiListEntry{entryOf(lu, 0, nil), entryOf(lu, 1, &now), strangerEntry}
	body2, blob2 := signedListPut(t, lu.SSK, lu.User.ID, 2, blob1, revoking)
	put(lu.Tokens[0], body2)
	row, err := deps.Repo.GetDevice(ctx, lu.Devs[1].ID)
	if err != nil || row.RevokedAt == nil || *row.RevokedAt != int64(now) {
		t.Fatalf("the revoked device's row = %+v (err %v), want revoked_at %d", row, err, now)
	}
	if _, err := deps.Sessions.Resolve(ctx, lu.Tokens[1]); err == nil {
		t.Fatal("a revoked device's token still resolves")
	}
	if got := me(lu.Tokens[1]); got != http.StatusUnauthorized {
		t.Fatalf("the revoked device's token answered %d, want 401", got)
	}
	if len(closed) != 1 || closed[0] != lu.Devs[1].ID {
		t.Fatalf("OnRevoke saw %v, want exactly [%s]", closed, lu.Devs[1].ID)
	}
	if len(hooked) != 2 || len(hooked[1]) != 1 || hooked[1][0] != lu.Devs[1].ID {
		t.Fatalf("AfterDeviceList saw %v, want the second run to carry [%s]", hooked, lu.Devs[1].ID)
	}
	if srow, err := deps.Repo.GetDevice(ctx, stranger.Devs[0].ID); err != nil || srow.RevokedAt != nil {
		t.Fatalf("another user's device was revoked by this user's list: %+v (err %v)", srow, err)
	}
	if got := me(stranger.Tokens[0]); got != http.StatusOK {
		t.Fatalf("another user's session answered %d, want 200", got)
	}
	if got := me(lu.Tokens[0]); got != http.StatusOK {
		t.Fatalf("the publisher's session answered %d, want 200", got)
	}

	body3, blob3 := signedListPut(t, lu.SSK, lu.User.ID, 3, blob2, revoking)
	put(lu.Tokens[0], body3)
	if len(closed) != 1 || len(hooked[2]) != 0 {
		t.Fatalf("a list that keeps a revocation acted again: closed %v, hook %v", closed, hooked[2])
	}

	body4, _ := signedListPut(t, lu.SSK, lu.User.ID, 4, blob3, []apiListEntry{entryOf(lu, 0, &now), entryOf(lu, 1, &now)})
	put(lu.Tokens[0], body4)
	if got := me(lu.Tokens[0]); got != http.StatusUnauthorized {
		t.Fatalf("the self-revoking publisher's token answered %d, want 401", got)
	}
	if len(closed) != 2 || closed[1] != lu.Devs[0].ID {
		t.Fatalf("OnRevoke saw %v, want the publisher second", closed)
	}
}

// A Deps without a verifier refuses every publish rather than store an unverified list.
func TestAnUnwiredDeviceListVerifierFailsClosed(t *testing.T) {
	h, deps := newTestAPI(t)
	lu := seedListedUser(t, deps, 0x5a, 1)
	body1, _ := signedListPut(t, lu.SSK, lu.User.ID, 1, nil, []apiListEntry{entryOf(lu, 0, nil)})
	wantListRefusal(t, cborCall(t, h, http.MethodPut, "/v1/users/"+lu.User.ID.String()+"/device-list", lu.Tokens[0], body1),
		http.StatusInternalServerError, "E_INTERNAL", "")
	if _, err := deps.Repo.GetDeviceList(context.Background(), lu.User.ID); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("an unverified list was stored: %v", err)
	}
}

// failingRemoveDS refuses the Remove of one group, as the guest refuses an instance Remove in a
// pairing group, and records every other call.
type failingRemoveDS struct {
	*recordingDS
	fail id.ID
}

func (f *failingRemoveDS) ProposeRemoveDevice(ctx context.Context, g, dev, a id.ID) error {
	if g == f.fail {
		return errors.New("the guest refused the instance Remove")
	}
	return f.recordingDS.ProposeRemoveDevice(ctx, g, dev, a)
}

// The revoked device's live leaves each get an instance Remove; a leaf it already left gets none;
// one refusal does not stop the rest and is reported with its group and device.
func TestRemoveRevokedDevicesProposesARemoveInEveryGroupTheDeviceHolds(t *testing.T) {
	e := newEnv(t)
	ctx := t.Context()
	_, tok := e.NewUser("revoked")
	dev := deviceOf(t, e, tok)
	cid := id.New()
	g1 := seedGroupOfKind(t, e, id.New(), cid, 0)
	g2 := seedGroupOfKind(t, e, id.New(), cid, 0)
	left := seedGroupOfKind(t, e, id.New(), cid, 0)
	seedLeaf(t, e, g1, dev, 0, nil)
	seedLeaf(t, e, g2, dev, 0, nil)
	gone := uint64(3)
	seedLeaf(t, e, left, dev, 0, &gone)

	if err := api.RemoveRevokedDevices(ctx, e.Repo, e.DS, []id.ID{dev}); err != nil {
		t.Fatalf("RemoveRevokedDevices: %v", err)
	}
	got := map[id.ID]id.ID{}
	for _, r := range e.DS.deviceRemoves() {
		got[r.Group] = r.Device
	}
	if len(got) != 2 || got[g1] != dev || got[g2] != dev {
		t.Fatalf("Removes = %v, want one per live leaf (%s, %s) and none for %s", got, g1, g2, left)
	}

	failing := &failingRemoveDS{recordingDS: &recordingDS{}, fail: g1}
	err := api.RemoveRevokedDevices(ctx, e.Repo, failing, []id.ID{dev})
	if err == nil || !strings.Contains(err.Error(), g1.String()) || !strings.Contains(err.Error(), dev.String()) {
		t.Fatalf("a refused Remove: err %v, want one naming group %s and device %s", err, g1, dev)
	}
	var re *api.RevokedRemoveError
	if !errors.As(err, &re) || re.Group != g1 || re.Device != dev || re.Err == nil {
		t.Fatalf("a refused Remove: %v, want an *api.RevokedRemoveError for group %s and device %s", err, g1, dev)
	}
	if rs := failing.deviceRemoves(); len(rs) != 1 || rs[0].Group != g2 {
		t.Fatalf("after the refusal the other group got %v, want its Remove", rs)
	}
	if err := api.RemoveRevokedDevices(ctx, e.Repo, nil, []id.ID{dev}); err == nil {
		t.Fatal("no delivery service was a silent no-op")
	}
}

// L-HTTP-56, DEV-W2-32. Attacker statement: the history refuses nothing new and exposes only what
// the user published; a pending session reads only its own.
func TestTheDeviceListHistoryIsServedAfterAVersion(t *testing.T) {
	h, deps := listAPI(t, nil)
	ctx := context.Background()
	lu := seedListedUser(t, deps, 0x5a, 1)
	stranger := seedListedUser(t, deps, 0x6b, 1)
	path := "/v1/users/" + lu.User.ID.String() + "/device-list"
	strangerPath := "/v1/users/" + stranger.User.ID.String() + "/device-list"
	entries := []apiListEntry{entryOf(lu, 0, nil)}
	var bodies [][]any
	var blobs [][]byte
	var prev []byte
	for v := uint64(1); v <= 3; v++ {
		body, blob := signedListPut(t, lu.SSK, lu.User.ID, v, prev, entries)
		if rec := cborCall(t, h, http.MethodPut, path, lu.Tokens[0], body); rec.Code != http.StatusNoContent {
			t.Fatalf("PUT v%d = %d", v, rec.Code)
		}
		bodies, blobs, prev = append(bodies, body), append(blobs, blob), blob
	}
	history := func(token, p, after string) []any {
		t.Helper()
		rec := cborCall(t, h, http.MethodGet, p+"?after="+after, token, nil)
		if rec.Code != http.StatusOK {
			t.Fatalf("GET %s?after=%s = %d %x, want 200", p, after, rec.Code, rec.Body.Bytes())
		}
		var rows []any
		if err := cborx.Unmarshal(rec.Body.Bytes(), &rows); err != nil {
			t.Fatalf("decode history: %v", err)
		}
		return rows
	}

	rows := history(lu.Tokens[0], path, "0")
	if len(rows) != 3 {
		t.Fatalf("history after 0 has %d rows, want 3", len(rows))
	}
	for i, r := range rows {
		row, _ := r.([]any)
		if len(row) != 4 || row[0] != uint64(i+1) || !bytes.Equal(row[1].([]byte), blobs[i]) ||
			!bytes.Equal(row[2].([]byte), bodies[i][2].([]byte)) || !bytes.Equal(row[3].([]byte), bodies[i][3].([]byte)) {
			t.Fatalf("history row %d = %v, want version %d as published", i, row, i+1)
		}
	}
	if rows := history(lu.Tokens[0], path, "1"); len(rows) != 2 || rows[0].([]any)[0] != uint64(2) || rows[1].([]any)[0] != uint64(3) {
		t.Fatalf("history after 1 = %v, want versions 2 and 3", rows)
	}
	if rec := cborCall(t, h, http.MethodGet, path+"?after=3", lu.Tokens[0], nil); rec.Code != http.StatusOK || !bytes.Equal(rec.Body.Bytes(), []byte{0x80}) {
		t.Fatalf("history after the newest = %d %x, want 200 and the empty array 80", rec.Code, rec.Body.Bytes())
	}
	var newest []any
	if err := cborx.Unmarshal(cborCall(t, h, http.MethodGet, path, lu.Tokens[0], nil).Body.Bytes(), &newest); err != nil || len(newest) != 4 || newest[0] != uint64(3) {
		t.Fatalf("GET without after = %v (err %v), want the newest row [3, …]", newest, err)
	}
	for _, bad := range []string{"abc", "-1", "", "1.5", "9223372036854775808", "18446744073709551616"} {
		if rec := cborCall(t, h, http.MethodGet, path+"?after="+bad, lu.Tokens[0], nil); rec.Code != http.StatusBadRequest || refusalCode(t, rec) != "E_INVALID_REQUEST" {
			t.Errorf("after=%q = %d, want 400 E_INVALID_REQUEST", bad, rec.Code)
		}
	}
	if rows := history(lu.Tokens[0], strangerPath, "0"); len(rows) != 0 {
		t.Fatalf("a user with no list: history %v, want []", rows)
	}
	if rec := cborCall(t, h, http.MethodGet, strangerPath, lu.Tokens[0], nil); rec.Code != http.StatusNotFound {
		t.Fatalf("a user with no list: GET without after = %d, want 404", rec.Code)
	}

	for v := uint64(4); v <= 70; v++ {
		if err := deps.Repo.PutDeviceList(ctx, store.DeviceListRow{UserID: lu.User.ID, Version: v, Blob: []byte{byte(v)},
			SSKSignature: make([]byte, 64), PrevHash: make([]byte, 32), Created: 1}); err != nil {
			t.Fatalf("PutDeviceList v%d: %v", v, err)
		}
	}
	rows = history(lu.Tokens[0], path, "0")
	if len(rows) != 64 || rows[0].([]any)[0] != uint64(1) || rows[63].([]any)[0] != uint64(64) {
		t.Fatalf("history after 0 of 70 versions: %d rows, want 64 from 1 to 64", len(rows))
	}
	if rows := history(lu.Tokens[0], path, "64"); len(rows) != 6 || rows[5].([]any)[0] != uint64(70) {
		t.Fatalf("history after 64: %d rows, want 6 ending at 70", len(rows))
	}

	listerOf(t, deps).list(lu.User.ID, lu.Devs[0].DSKPub)
	_, pending := pendingSession(t, h, deps, lu.User.ID)
	if rows := history(pending, path, "0"); len(rows) != 64 {
		t.Fatalf("a pending session's own history: %d rows, want 64", len(rows))
	}
	if rec := cborCall(t, h, http.MethodGet, strangerPath+"?after=0", pending, nil); rec.Code != http.StatusForbidden {
		t.Fatalf("a pending session reading another user's history = %d, want 403", rec.Code)
	}
}

// A session without the SSK may clear an unlisted registration row, but the owner's signed list
// is the authority for revoking a listed device. Only this user's own sessions reach the route.
func TestKeylessDeleteRefusesAListedDevice(t *testing.T) {
	h, deps := listAPI(t, nil)
	lu := seedListedUser(t, deps, 0x5a, 2)
	body, _ := signedListPut(t, lu.SSK, lu.User.ID, 1, nil, []apiListEntry{entryOf(lu, 0, nil)})
	path := "/v1/users/" + lu.User.ID.String() + "/device-list"
	if rec := cborCall(t, h, http.MethodPut, path, lu.Tokens[0], body); rec.Code != http.StatusNoContent {
		t.Fatalf("publish = %d %x, want 204", rec.Code, rec.Body.Bytes())
	}
	listerOf(t, deps).list(lu.User.ID, lu.Devs[0].DSKPub)
	listed := "/v1/devices/" + lu.Devs[0].ID.String()
	wantListRefusal(t, cborCall(t, h, http.MethodDelete, listed, lu.Tokens[0], nil),
		http.StatusConflict, "E_INVALID_REQUEST", "a listed device is revoked by a signed device list")
	if row, err := deps.Repo.GetDevice(t.Context(), lu.Devs[0].ID); err != nil || row.RevokedAt != nil {
		t.Fatalf("listed device after refused DELETE = %+v, %v", row, err)
	}
	unlisted := "/v1/devices/" + lu.Devs[1].ID.String()
	if rec := cborCall(t, h, http.MethodDelete, unlisted, lu.Tokens[0], nil); rec.Code != http.StatusNoContent {
		t.Fatalf("unlisted DELETE = %d %x, want 204", rec.Code, rec.Body.Bytes())
	}
}
