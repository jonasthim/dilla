package dilladtest

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"encoding/hex"
	"encoding/json"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/livekit/protocol/auth"

	"github.com/jonasthim/dilla/internal/api"
	"github.com/jonasthim/dilla/internal/cborx"
	"github.com/jonasthim/dilla/internal/id"
	"github.com/jonasthim/dilla/internal/store"
)

// freePorts asks the kernel for an unused TCP port and an unused UDP port on loopback, so this
// package's SFU never collides with internal/sfu's fixed test ports when `go test ./...` runs the
// packages in parallel.
func freePorts(t *testing.T) (tcp, udp int) {
	t.Helper()
	var lc net.ListenConfig
	ln, err := lc.Listen(t.Context(), "tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen tcp: %v", err)
	}
	tcp = ln.Addr().(*net.TCPAddr).Port
	_ = ln.Close()
	pc, err := lc.ListenPacket(t.Context(), "udp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen udp: %v", err)
	}
	udp = pc.LocalAddr().(*net.UDPAddr).Port
	_ = pc.Close()
	return tcp, udp
}

func sfuHost(t *testing.T, withSFU bool) *Host {
	t.Helper()
	core, err := filepath.Abs(filepath.Join("..", "..", "mlswasi", "testdata", "dilla_core_wasi.wasm"))
	if err != nil {
		t.Fatalf("core path: %v", err)
	}
	if _, err := os.Stat(core); err != nil {
		t.Fatalf("%s is missing: build it with\n"+
			"  cargo build -p dilla-core-wasi --target wasm32-wasip1 --release --locked\n"+
			"and copy it there: %v", core, err)
	}
	tcp, udp := freePorts(t)
	h, err := NewHost(context.Background(), HostOptions{
		DataDir: t.TempDir(), CorePath: core, SFU: withSFU, SFUPort: tcp, SFUUDPPort: udp,
	})
	if err != nil {
		t.Fatalf("NewHost: %v", err)
	}
	t.Cleanup(func() { _ = h.Close(context.Background()) })
	return h
}

// The YAML the harness SFU renders carries the two settings Firefox needs: node_ip on loopback
// and advertise_internal_ip (G35 run A1), never sfu.DefaultConfig()'s AdvertiseInternalIP false.
func TestTheTestSFUAdvertisesInternalAddresses(t *testing.T) {
	yaml, err := testSFUConfig(7880, 7882, "dilla", strings.Repeat("s", 64)).YAML()
	if err != nil {
		t.Fatalf("YAML: %v", err)
	}
	for _, want := range []string{
		"port: 7880\n", "  node_ip: 127.0.0.1\n", "  enable_loopback_candidate: true\n",
		"  udp_port: 7882\n", "  advertise_internal_ip: true\n", "keys:\n  dilla: ",
	} {
		if !strings.Contains(yaml, want) {
			t.Errorf("the harness SFU YAML lacks %q:\n%s", want, yaml)
		}
	}
}

// GET /debug/sfu and POST /debug/sfu/token exist on the control listener only; the public
// listener — what a scenario client and a browser reach — answers 404 for both.
func TestTheDebugSFURoutesAreControlOnly(t *testing.T) {
	h := sfuHost(t, true)
	public := httptest.NewServer(h.Handler())
	t.Cleanup(public.Close)
	control := httptest.NewServer(ControlHandler(h))
	t.Cleanup(control.Close)

	body := []byte(`{"room":"r1","identity":"0123456789abcdef0123456789abcdef","create":true}`)
	for _, req := range []struct{ method, path string }{{http.MethodGet, "/debug/sfu"}, {http.MethodPost, "/debug/sfu/token"}} {
		r, err := http.NewRequestWithContext(t.Context(), req.method, public.URL+req.path, bytes.NewReader(body))
		if err != nil {
			t.Fatalf("request: %v", err)
		}
		res, err := http.DefaultClient.Do(r)
		if err != nil {
			t.Fatalf("%s %s: %v", req.method, req.path, err)
		}
		_ = res.Body.Close()
		if res.StatusCode != http.StatusNotFound {
			t.Errorf("public %s %s = %d, want 404", req.method, req.path, res.StatusCode)
		}
	}

	res, err := http.Get(control.URL + "/debug/sfu") //nolint:noctx // test against httptest
	if err != nil {
		t.Fatalf("GET /debug/sfu: %v", err)
	}
	var info map[string]string
	if err := json.NewDecoder(res.Body).Decode(&info); err != nil {
		t.Fatalf("decode: %v", err)
	}
	_ = res.Body.Close()
	if info["url"] != h.SFU().URL() || info["http_url"] != h.SFU().HTTPURL() {
		t.Fatalf("GET /debug/sfu = %v, want %s and %s", info, h.SFU().URL(), h.SFU().HTTPURL())
	}

	res, err = http.Post(control.URL+"/debug/sfu/token", "application/json", bytes.NewReader(body)) //nolint:noctx // test against httptest
	if err != nil {
		t.Fatalf("POST /debug/sfu/token: %v", err)
	}
	var tok map[string]string
	if err := json.NewDecoder(res.Body).Decode(&tok); err != nil {
		t.Fatalf("decode: %v", err)
	}
	_ = res.Body.Close()
	v, err := auth.ParseAPIToken(tok["token"])
	if err != nil {
		t.Fatalf("the debug token is not a LiveKit JWT: %v", err)
	}
	if v.Identity() != "0123456789abcdef0123456789abcdef" || v.APIKey() != h.cfg.LiveKit.APIKey || tok["url"] != h.SFU().URL() {
		t.Fatalf("token identity %q key %q url %q", v.Identity(), v.APIKey(), tok["url"])
	}

	// A host without an SFU answers 404 on the control listener too.
	bare := httptest.NewServer(ControlHandler(sfuHost(t, false)))
	t.Cleanup(bare.Close)
	res, err = http.Get(bare.URL + "/debug/sfu") //nolint:noctx // test against httptest
	if err != nil {
		t.Fatalf("GET /debug/sfu without an SFU: %v", err)
	}
	_ = res.Body.Close()
	if res.StatusCode != http.StatusNotFound {
		t.Fatalf("GET /debug/sfu without an SFU = %d, want 404", res.StatusCode)
	}
}

// With HostOptions.SFU the call route that answers 501 on a bare host (api's
// TestAnInstanceWithoutAnSFUAnswersNotImplemented) mints a real LiveKit token for a current leaf.
func TestAHostWithAnSFUMintsCallTokens(t *testing.T) {
	h := sfuHost(t, true)
	ctx := t.Context()

	key := func() string {
		p, _, err := ed25519.GenerateKey(nil)
		if err != nil {
			t.Fatalf("GenerateKey: %v", err)
		}
		return hex.EncodeToString(p)
	}
	device := id.New()
	if _, err := SeedUsers(ctx, h.Server(), []SeedRequest{{
		Username: "caller", Display: "caller", UMKPub: key(), SSKPub: key(),
		SigUMKSSK: hex.EncodeToString(make([]byte, 64)),
		Devices:   []Device{{DeviceID: device.String(), DSKPub: key(), Credential: "01"}},
	}}); err != nil {
		t.Fatalf("SeedUsers: %v", err)
	}
	call := func(method, path string, body any) []any {
		t.Helper()
		status, raw, err := h.AsDevice(ctx, device, method, path, body)
		if err != nil {
			t.Fatalf("%s %s: %v", method, path, err)
		}
		if status != http.StatusCreated {
			t.Fatalf("%s %s = %d (%x), want 201", method, path, status, raw)
		}
		var out []any
		if err := cborx.Unmarshal(raw, &out); err != nil {
			t.Fatalf("decode %s: %v", path, err)
		}
		return out
	}
	idOf := func(v any) id.ID {
		b, ok := v.([]byte)
		if !ok || len(b) != len(id.ID{}) {
			t.Fatalf("%#v is not a 16-byte id", v)
		}
		return id.ID(b)
	}
	cid := idOf(call(http.MethodPost, "/v1/communities", []any{"voice", []byte("{}"), uint64(0), uint64(0)})[0])
	// kind voice (1); a discoverable channel is forced readable (mode 1).
	ch := idOf(call(http.MethodPost, "/v1/communities/"+cid.String()+"/channels",
		[]any{uint64(api.ChannelVoice), uint64(1), uint64(2), nil, "voice", "", uint64(0), uint64(0)})[0])

	// The call group and the caller's leaf in its current epoch, as the delivery service would
	// have recorded them after the caller's external commit.
	repo := h.Server().Repo()
	group := store.GroupRow{
		GroupID: id.New(), Binding: []byte{0x80}, Kind: api.GroupCall, CommunityID: &cid, TargetID: ch,
		CallID: &ch, Ciphersuite: 1, Epoch: 7, ExternalSenderKeyID: id.New(),
		E2EEVersion: 1, MediaVersion: 1, PolicyVersion: 1, Created: h.Clock().Now().Unix(),
	}
	if err := repo.CreateGroup(ctx, group); err != nil {
		t.Fatalf("CreateGroup: %v", err)
	}
	dev, err := repo.GetDevice(ctx, device)
	if err != nil {
		t.Fatalf("GetDevice: %v", err)
	}
	if err := repo.ReplaceMembers(ctx, group.GroupID, 7, []store.MemberRow{{
		GroupID: group.GroupID, LeafIndex: 0, UserID: dev.UserID, DeviceID: device,
		SignatureKey: make([]byte, 32), AddedEpoch: 7,
	}}); err != nil {
		t.Fatalf("ReplaceMembers: %v", err)
	}

	out := call(http.MethodPost, "/v1/channels/"+ch.String()+"/calls", []any{})
	token, ok := out[3].(string)
	if !ok {
		t.Fatalf("the call response's token is %#v", out[3])
	}
	v, err := auth.ParseAPIToken(token)
	if err != nil {
		t.Fatalf("the call token is not a LiveKit JWT: %v", err)
	}
	if v.Identity() != device.String() || v.APIKey() != h.cfg.LiveKit.APIKey {
		t.Fatalf("token identity %q key %q, want %s and %q", v.Identity(), v.APIKey(), device, h.cfg.LiveKit.APIKey)
	}
	if idOf(out[1]) != group.GroupID {
		t.Fatalf("group_id = %x, want %s", out[1], group.GroupID)
	}
}
