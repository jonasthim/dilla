package dilladtest

import (
	"bytes"
	"context"
	"encoding/json"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/jonasthim/dilla/internal/sfu"
)

// startSidecar starts an LiveKit the host does not own, as `dillad media` would: its key is the
// instance's default, its secret is in a file, its webhooks go to webhookListen.
func startSidecar(t *testing.T, webhookListen string) (s *sfu.Server, tcp, udp int, secretFile string) {
	t.Helper()
	tcp, udp = freePorts(t)
	secret, err := newSFUSecret()
	if err != nil {
		t.Fatal(err)
	}
	cfg := testSFUConfig(tcp, udp, "dilla", secret)
	cfg.WebhookURL = "http://" + webhookListen + sfu.WebhookPath
	s, err = sfu.Start(t.Context(), cfg)
	if err != nil {
		t.Fatalf("start the sidecar SFU: %v", err)
	}
	t.Cleanup(func() { _ = s.Stop(context.Background()) })
	secretFile = filepath.Join(t.TempDir(), "livekit.secret")
	if err := os.WriteFile(secretFile, []byte(secret+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	return s, tcp, udp, secretFile
}

func freeAddr(t *testing.T) string {
	t.Helper()
	ln, err := (&net.ListenConfig{}).Listen(t.Context(), "tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = ln.Close() }()
	return ln.Addr().String()
}

func sidecarHost(t *testing.T, dataDir string, tcp, udp int, secretFile, webhook string) *Host {
	t.Helper()
	h, err := NewHost(t.Context(), HostOptions{
		DataDir: dataDir, CorePath: corePath(t), SFUSidecar: true, SFUPort: tcp, SFUUDPPort: udp,
		SFUSecretFile: secretFile, SFUWebhookListen: webhook,
	})
	if err != nil {
		t.Fatalf("NewHost (sidecar): %v", err)
	}
	return h
}

// UP5: in sidecar mode the host talks to an SFU it did not start (sfu.NewRemote). The debug routes
// name that SFU, a debug room is opened in it, and closing the host leaves the SFU running, so a
// second host on the same data directory and webhook address finds the room still there.
func TestASidecarHostUsesTheSFUItDoesNotOwnAndLeavesItRunning(t *testing.T) {
	webhook := freeAddr(t)
	s, tcp, udp, secretFile := startSidecar(t, webhook)
	dataDir := t.TempDir()

	h := sidecarHost(t, dataDir, tcp, udp, secretFile, webhook)
	if h.SFU() != nil {
		t.Fatal("a sidecar host must not claim to own an in-process SFU")
	}
	if h.WebhookURL() != "http://"+webhook+sfu.WebhookPath {
		t.Fatalf("WebhookURL = %q, want the address the sidecar was told", h.WebhookURL())
	}
	control := httptest.NewServer(ControlHandler(h))
	defer control.Close()

	res, err := http.Get(control.URL + "/debug/sfu") //nolint:noctx // test against httptest
	if err != nil {
		t.Fatal(err)
	}
	var info map[string]string
	if err := json.NewDecoder(res.Body).Decode(&info); err != nil {
		t.Fatal(err)
	}
	_ = res.Body.Close()
	if info["url"] != s.URL() || info["http_url"] != s.HTTPURL() {
		t.Fatalf("GET /debug/sfu = %v, want %s and %s", info, s.URL(), s.HTTPURL())
	}

	body, _ := json.Marshal(map[string]any{"room": "sidecar-room", "identity": "0123456789abcdef0123456789abcdef", "create": true})
	res, err = http.Post(control.URL+"/debug/sfu/token", "application/json", bytes.NewReader(body)) //nolint:noctx // test against httptest
	if err != nil {
		t.Fatal(err)
	}
	_ = res.Body.Close()
	if res.StatusCode != http.StatusOK {
		t.Fatalf("POST /debug/sfu/token = %d", res.StatusCode)
	}
	rooms, err := s.Rooms(t.Context())
	if err != nil || !slices.Contains(rooms, "sidecar-room") {
		t.Fatalf("the sidecar's rooms = %v, %v; want sidecar-room opened through the host", rooms, err)
	}

	// The API alone restarts: the host closes, the SFU and its room stay.
	if err := h.Close(t.Context()); err != nil {
		t.Fatalf("Close: %v", err)
	}
	if rooms, err = s.Rooms(t.Context()); err != nil || !slices.Contains(rooms, "sidecar-room") {
		t.Fatalf("after Close the sidecar's rooms = %v, %v; want sidecar-room kept", rooms, err)
	}
	h2 := sidecarHost(t, dataDir, tcp, udp, secretFile, webhook) // the webhook address is free again
	defer func() { _ = h2.Close(context.Background()) }()
}

// A sidecar host with a missing secret file, or no webhook address, fails NewHost rather than
// talking to an SFU with the wrong key.
func TestASidecarHostRefusesAMissingSecretOrWebhook(t *testing.T) {
	for name, o := range map[string]HostOptions{
		"secret file missing": {SFUSidecar: true, SFUSecretFile: filepath.Join(t.TempDir(), "nope"), SFUWebhookListen: "127.0.0.1:0"},
		"no secret file":      {SFUSidecar: true, SFUWebhookListen: "127.0.0.1:0"},
		"no webhook":          {SFUSidecar: true, SFUSecretFile: "/x"},
	} {
		o.DataDir, o.CorePath = t.TempDir(), corePath(t)
		if h, err := NewHost(t.Context(), o); err == nil {
			_ = h.Close(context.Background())
			t.Errorf("%s: NewHost succeeded", name)
		} else if !strings.Contains(err.Error(), "sidecar") {
			t.Errorf("%s: error %q does not name the sidecar", name, err)
		}
	}
}

// StateDir is where the host's own state files go (UP9's sockets); empty means the data directory,
// and it is never a fixed path.
func TestTheStateDirDefaultsToTheDataDir(t *testing.T) {
	dir, state := t.TempDir(), t.TempDir()
	if got := (HostOptions{DataDir: dir}).stateDir(); got != dir {
		t.Fatalf("stateDir() = %q, want the data dir %q", got, dir)
	}
	if got := (HostOptions{DataDir: dir, StateDir: state}).stateDir(); got != state {
		t.Fatalf("stateDir() = %q, want %q", got, state)
	}
	if c := hostConfig(HostOptions{DataDir: dir, StateDir: state}); c.Instance.DataDir != state || c.DB.Path != filepath.Join(dir, "dilla.db") {
		t.Fatalf("instance.data_dir = %q, db.path = %q", c.Instance.DataDir, c.DB.Path)
	}
}
