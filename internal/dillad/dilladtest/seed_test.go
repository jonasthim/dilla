package dilladtest_test

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/jonasthim/dilla/internal/dillad/dilladtest"
	"github.com/jonasthim/dilla/internal/ds"
	"github.com/jonasthim/dilla/internal/id"
)

func newHost(t *testing.T) *dilladtest.Host {
	t.Helper()
	core, err := filepath.Abs(filepath.Join("..", "..", "mlswasi", "testdata", "dilla_core_wasi.wasm"))
	if err != nil {
		t.Fatalf("core path: %v", err)
	}
	if _, err := os.Stat(core); err != nil {
		t.Fatalf("%s is missing: build it with\n"+
			"  cargo build -p dilla-core-wasi --target wasm32-wasip1 --release --locked\n"+
			"and copy it there (CI downloads the rust-wasi job's artifact): %v", core, err)
	}
	h, err := dilladtest.NewHost(context.Background(), dilladtest.HostOptions{
		DataDir: t.TempDir(), CorePath: core,
	})
	if err != nil {
		t.Fatalf("NewHost: %v", err)
	}
	t.Cleanup(func() { _ = h.Close(context.Background()) })
	return h
}

// POST /debug/seed creates the account and its devices from key material the caller holds, and
// answers a session token per device that the instance itself resolves — the seeding convenience
// that stays out of `dillad serve`.
func TestTheSeedRouteCreatesAnAccountWhoseSessionsResolve(t *testing.T) {
	h := newHost(t)
	control := httptest.NewServer(dilladtest.ControlHandler(h))
	t.Cleanup(control.Close)

	pub := func() string {
		p, _, err := ed25519.GenerateKey(rand.Reader)
		if err != nil {
			t.Fatalf("GenerateKey: %v", err)
		}
		return hex.EncodeToString(p)
	}
	device := id.New()
	req := []dilladtest.SeedRequest{{
		Username: "seeded", Display: "Seeded",
		UMKPub: pub(), SSKPub: pub(), SigUMKSSK: hex.EncodeToString(make([]byte, 64)),
		Devices: []dilladtest.Device{{
			DeviceID: device.String(), DSKPub: pub(), Credential: hex.EncodeToString([]byte{0x01}),
		}},
	}}
	body, err := json.Marshal(req)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	res, err := http.Post(control.URL+"/debug/seed", "application/json", bytes.NewReader(body))
	if err != nil {
		t.Fatalf("POST /debug/seed: %v", err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200", res.StatusCode)
	}
	var out []dilladtest.SeedResponse
	if err := json.NewDecoder(res.Body).Decode(&out); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(out) != 1 || out[0].Tokens[device.String()] == "" {
		t.Fatalf("got %+v, want one account with a token for the seeded device", out)
	}
	session, err := h.Server().Sessions().Resolve(context.Background(), out[0].Tokens[device.String()])
	if err != nil {
		t.Fatalf("the seeded token does not resolve: %v", err)
	}
	if session.DeviceID != device || session.UserID.String() != out[0].UserID {
		t.Fatalf("the session names %s/%s, want the seeded device and user", session.UserID, session.DeviceID)
	}
}

// postJSON posts v to the control listener and answers the status.
func postJSON(t *testing.T, url string, v any) int {
	t.Helper()
	body, err := json.Marshal(v)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	res, err := http.Post(url, "application/json", bytes.NewReader(body))
	if err != nil {
		t.Fatalf("POST %s: %v", url, err)
	}
	defer res.Body.Close()
	return res.StatusCode
}

// seedDevice creates one account with one device through SeedUsers and answers the device and
// its session token.
func seedDevice(t *testing.T, h *dilladtest.Host, username string) (id.ID, string) {
	t.Helper()
	pub := func() string {
		p, _, err := ed25519.GenerateKey(rand.Reader)
		if err != nil {
			t.Fatalf("GenerateKey: %v", err)
		}
		return hex.EncodeToString(p)
	}
	device := id.New()
	out, err := dilladtest.SeedUsers(context.Background(), h.Server(), []dilladtest.SeedRequest{{
		Username: username, Display: username,
		UMKPub: pub(), SSKPub: pub(), SigUMKSSK: hex.EncodeToString(make([]byte, 64)),
		Devices: []dilladtest.Device{{
			DeviceID: device.String(), DSKPub: pub(), Credential: hex.EncodeToString([]byte{0x01}),
		}},
	}})
	if err != nil {
		t.Fatalf("SeedUsers: %v", err)
	}
	return device, out[0].Tokens[device.String()]
}

// POST /debug/mark-revoked revokes the device ROW and nothing else: its session still resolves.
// That is the window a real revocation — which deletes the sessions in the same transaction — can
// race, where a request already authenticated reaches the delivery service after the row changed.
// Invariant 4's external-joiner clause refuses a revoked joiner, and this is the only way a
// scenario can reach that refusal.
func TestTheMarkRevokedRouteRevokesTheRowAndLeavesTheSession(t *testing.T) {
	h := newHost(t)
	control := httptest.NewServer(dilladtest.ControlHandler(h))
	t.Cleanup(control.Close)
	device, token := seedDevice(t, h, "revoked")

	if status := postJSON(t, control.URL+"/debug/mark-revoked",
		map[string]string{"device": device.String()}); status != http.StatusNoContent {
		t.Fatalf("status = %d, want 204", status)
	}
	row, err := h.Server().Repo().GetDevice(context.Background(), device)
	if err != nil {
		t.Fatalf("GetDevice: %v", err)
	}
	if row.RevokedAt == nil {
		t.Fatal("the device row is not revoked")
	}
	if _, err := h.Server().Sessions().Resolve(context.Background(), token); err != nil {
		t.Fatalf("the session was deleted with the row: %v", err)
	}
	if status := postJSON(t, control.URL+"/debug/mark-revoked",
		map[string]string{"device": "zz"}); status != http.StatusBadRequest {
		t.Fatalf("a malformed device id: status = %d, want 400", status)
	}
}

// POST /debug/channel records a channel's visibility and mode under its target id, which is what
// invariant 1's registration check reads (ds.Channels). A target the route never named is no
// channel at all — a DM or a pairing group — exactly as ds.PermissiveChannels answers it.
func TestTheChannelRouteRecordsWhatInvariantOneReads(t *testing.T) {
	h := newHost(t)
	control := httptest.NewServer(dilladtest.ControlHandler(h))
	t.Cleanup(control.Close)
	target := id.New()

	for _, c := range []struct {
		visibility, mode string
		wantV, wantM     uint8
	}{
		{"private", "e2ee", 0, 0},
		{"private", "readable", 0, 1},
		{"invite", "readable", 1, 1},
		{"discoverable", "readable", 2, 1},
	} {
		if status := postJSON(t, control.URL+"/debug/channel", map[string]string{
			"target": target.String(), "visibility": c.visibility, "mode": c.mode,
		}); status != http.StatusNoContent {
			t.Fatalf("%s/%s: status = %d, want 204", c.visibility, c.mode, status)
		}
		v, m, err := h.Channels().Channel(context.Background(), target)
		if err != nil || v != c.wantV || m != c.wantM {
			t.Fatalf("%s/%s: Channel = %d, %d, %v; want %d, %d", c.visibility, c.mode, v, m, err,
				c.wantV, c.wantM)
		}
	}
	if _, _, err := h.Channels().Channel(context.Background(), id.New()); !errors.Is(err, ds.ErrNoChannel) {
		t.Fatalf("an unnamed target: %v, want ds.ErrNoChannel", err)
	}
	for _, bad := range []map[string]string{
		{"target": target.String(), "visibility": "secret", "mode": "e2ee"},
		{"target": target.String(), "visibility": "private", "mode": "plain"},
		{"target": "zz", "visibility": "private", "mode": "e2ee"},
	} {
		if status := postJSON(t, control.URL+"/debug/channel", bad); status != http.StatusBadRequest {
			t.Fatalf("%v: status = %d, want 400", bad, status)
		}
	}
}

// GET /debug/state carries the counters and the three things scenarios read: the two lists and the
// external-sender key every text and call group needs.
func TestTheStateRouteCarriesTheListsAndTheExternalSenderKey(t *testing.T) {
	h := newHost(t)
	control := httptest.NewServer(dilladtest.ControlHandler(h))
	t.Cleanup(control.Close)

	res, err := http.Get(control.URL + "/debug/state")
	if err != nil {
		t.Fatalf("GET /debug/state: %v", err)
	}
	defer res.Body.Close()
	var state map[string]any
	if err := json.NewDecoder(res.Body).Decode(&state); err != nil {
		t.Fatalf("decode: %v", err)
	}
	for _, key := range []string{"quarantined_devices", "closed_groups"} {
		if _, ok := state[key].([]any); !ok {
			t.Errorf("%s is %T, want a JSON array", key, state[key])
		}
	}
	key, _ := state["external_sender_pub"].(string)
	if raw, err := hex.DecodeString(key); err != nil || len(raw) != ed25519.PublicKeySize {
		t.Errorf("external_sender_pub = %q, want 64 hex digits", key)
	}
	if _, ok := state["now_unix"].(float64); !ok {
		t.Error("now_unix is missing")
	}
}
