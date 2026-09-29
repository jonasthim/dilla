package dilladtest_test

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/jonasthim/dilla/internal/dillad/dilladtest"
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
