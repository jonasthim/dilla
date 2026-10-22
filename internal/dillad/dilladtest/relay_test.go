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
	"strings"
	"testing"
	"time"

	"github.com/jonasthim/dilla/internal/clock"
	"github.com/jonasthim/dilla/internal/id"
	"github.com/jonasthim/dilla/internal/server"
)

// relayStateDir is a state directory as `dillad media` leaves it for a host to share: mode 0700, a
// media.json listing caps, and (when media) a media.sock served by a relay control of its own.
func relayStateDir(t *testing.T, caps []string, level int) string {
	t.Helper()
	dir, err := os.MkdirTemp("", "up9-state-") //nolint:usetesting // a short path: t.TempDir's can pass a unix socket name's 107 bytes
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(dir) })
	if err := os.Chmod(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	raw, _ := json.Marshal(map[string]any{"version": "test", "media_level": level, "capabilities": caps, "pid": os.Getpid()})
	if err := os.WriteFile(filepath.Join(dir, "media.json"), raw, 0o600); err != nil {
		t.Fatal(err)
	}
	return dir
}

// mediaRelay serves media.sock in dir as `dillad media`'s relay does (server.NewRelayControl), and
// answers its cut state.
func mediaRelay(t *testing.T, dir string) *server.RelayRevocations {
	t.Helper()
	rev := server.NewRelayRevocations(time.Hour, clock.System())
	ln, err := server.ListenControl(t.Context(), server.ControlSocketPath(dir, server.MediaSocketName), nil)
	if err != nil {
		t.Fatalf("media.sock: %v", err)
	}
	stop := server.ServeControl(ln, server.NewRelayControl(rev, func() server.RelayState { return server.RelayState{Owner: "media", Serving: true} }), nil)
	t.Cleanup(stop)
	return rev
}

func turnSecret(t *testing.T) string {
	t.Helper()
	f := filepath.Join(t.TempDir(), "turn.secret")
	if err := os.WriteFile(f, []byte(strings.Repeat("ab", 32)+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	return f
}

func turnHost(t *testing.T, state, turnListen, secret string) *Host {
	t.Helper()
	webhook := freeAddr(t)
	_, tcp, udp, lkSecret := startSidecar(t, webhook)
	h, err := NewHost(t.Context(), HostOptions{
		DataDir: t.TempDir(), CorePath: corePath(t), SFUSidecar: true, SFUPort: tcp, SFUUDPPort: udp,
		SFUSecretFile: lkSecret, SFUWebhookListen: webhook, StateDir: state, TURNListen: turnListen, TURNSecretFile: secret,
	})
	if err != nil {
		t.Fatalf("NewHost (sidecar with TURN): %v", err)
	}
	t.Cleanup(func() { _ = h.Close(context.Background()) })
	return h
}

func apiSocket(t *testing.T, dir, path string, out any) int {
	t.Helper()
	req, _ := http.NewRequestWithContext(t.Context(), http.MethodGet, "http://api.sock"+path, nil)
	res, err := server.ControlClient(server.ControlSocketPath(dir, server.APISocketName)).Do(req)
	if err != nil {
		t.Fatalf("api.sock %s: %v", path, err)
	}
	defer func() { _ = res.Body.Close() }()
	if out != nil && res.StatusCode == http.StatusOK {
		if err := json.NewDecoder(res.Body).Decode(out); err != nil {
			t.Fatal(err)
		}
	}
	return res.StatusCode
}

// UP9: a sidecar host whose media process serves TURN hands that relay out (turn.public_url on
// loopback), forwards every cut to it over media.sock, and serves api.sock in the shared state
// directory: the media relay's barred lookup and GET /relay/state, as `dillad serve` does.
func TestASidecarHostWithMediaTURNForwardsCutsAndServesAPISock(t *testing.T) {
	state := relayStateDir(t, []string{"turn"}, 2)
	media := mediaRelay(t, state)
	listen := freeAddr(t)
	h := turnHost(t, state, listen, turnSecret(t))

	if c := h.cfg.TURN; !c.Enabled || c.Listen != listen || c.PublicURL != "turn:"+listen+"?transport=tcp" || c.RelayIP != "127.0.0.1" {
		t.Fatalf("turn config %+v", c)
	}
	if h.relayTURN != nil || h.relayFwd == nil {
		t.Fatal("with media.json listing turn the host must forward, not serve a relay of its own")
	}
	var st server.RelayState
	if code := apiSocket(t, state, "/relay/state", &st); code != http.StatusOK || st.Owner != "api" || st.Serving {
		t.Fatalf("GET /relay/state = %d %+v, want the api owner serving nothing", code, st)
	}
	var barred map[string]bool
	if code := apiSocket(t, state, "/relay/barred/"+id.New().String(), &barred); code != http.StatusOK || barred["barred"] {
		t.Fatalf("GET /relay/barred = %d %v, want an unknown device not barred", code, barred)
	}

	// A cut the call routes make (through the relay they were given) reaches the media relay.
	dev := id.New()
	if _, wait := h.relay.Mint(dev, h.clk.Now()); wait != 0 {
		t.Fatalf("Mint waited %s for a device nobody cut", wait)
	}
	h.relay.Revoke(dev, h.clk.Now())
	deadline := time.Now().Add(10 * time.Second)
	for {
		if _, ok := media.CutOf(dev.String()); ok {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("the cut never reached the media relay over media.sock")
		}
		time.Sleep(50 * time.Millisecond)
	}
	if acks, ok := h.relay.(interface{ Unacked(id.ID) bool }); !ok {
		t.Fatal("the forwarding relay must tell the call routes about unacknowledged cuts")
	} else if acks.Unacked(dev) {
		deadline = time.Now().Add(10 * time.Second)
		for acks.Unacked(dev) && time.Now().Before(deadline) {
			time.Sleep(50 * time.Millisecond)
		}
		if acks.Unacked(dev) {
			t.Fatal("the media relay applied the cut, but it stays unacknowledged")
		}
	}

	// Close stops api.sock: nothing answers there afterwards.
	if err := h.Close(t.Context()); err != nil {
		t.Fatal(err)
	}
	if res, err := server.ControlClient(server.ControlSocketPath(state, server.APISocketName)).Get("http://api.sock/relay/state"); err == nil { //nolint:noctx // a refused dial is the point
		_ = res.Body.Close()
		t.Fatal("api.sock still answers after Close")
	}
}

// A media process without TURN (a web3.11 SFU, UP4's compat run): the host binds turn.listen and
// serves the relay itself, as serve does during the transition.
func TestASidecarHostWhoseMediaServesNoTURNServesTheRelayItself(t *testing.T) {
	state := relayStateDir(t, []string{}, 1)
	listen := freeAddr(t)
	h := turnHost(t, state, listen, turnSecret(t))
	if h.relayTURN == nil || h.relayFwd != nil {
		t.Fatal("with media.json not listing turn the host must serve the relay itself")
	}
	conn, err := (&net.Dialer{}).DialContext(t.Context(), "tcp", listen)
	if err != nil {
		t.Fatalf("turn.listen %s does not accept: %v", listen, err)
	}
	_ = conn.Close()
	var st server.RelayState
	if code := apiSocket(t, state, "/relay/state", &st); code != http.StatusOK || !st.Serving || st.Listen != listen {
		t.Fatalf("GET /relay/state = %d %+v, want the api serving on %s", code, st, listen)
	}
}

// TURNListen and TURNSecretFile go together, and only with a sidecar SFU.
func TestTheRelayOptionsGoTogetherWithTheSidecar(t *testing.T) {
	for name, o := range map[string]HostOptions{
		"no sidecar":     {TURNListen: "127.0.0.1:1", TURNSecretFile: "/s"},
		"no secret file": {SFUSidecar: true, SFUSecretFile: "/x", SFUWebhookListen: "127.0.0.1:0", TURNListen: "127.0.0.1:1"},
		"no listen":      {SFUSidecar: true, SFUSecretFile: "/x", SFUWebhookListen: "127.0.0.1:0", TURNSecretFile: "/s"},
	} {
		o.DataDir, o.CorePath = t.TempDir(), corePath(t)
		if h, err := NewHost(t.Context(), o); err == nil {
			_ = h.Close(context.Background())
			t.Errorf("%s: NewHost succeeded", name)
		} else if !strings.Contains(err.Error(), "TURNListen") {
			t.Errorf("%s: error %q does not name the relay options", name, err)
		}
	}
}

// recordedRelay is an api.RelayRevoker that records the times it was handed.
type recordedRelay struct{ since, at time.Time }

func (r *recordedRelay) Revoke(_ id.ID, at time.Time) { r.at = at }
func (r *recordedRelay) Mint(_ id.ID, since time.Time) (time.Time, time.Duration) {
	r.since = since
	return time.Now(), 0
}

// The call routes hand the relay instance times (a fake clock, frozen and moved by the harness); the
// relay runs on the wall clock. relayClock moves each onto the wall clock, so "the start began just
// now" stays just now, whatever the fake clock says (without it every mint waited for ever).
func TestTheRelayClockMovesInstanceTimesOntoTheWallClock(t *testing.T) {
	fake := clock.NewFake(time.Now().Add(-time.Hour))
	inner := &recordedRelay{}
	r := relayClock{inner: inner, clk: fake}
	r.Mint(id.New(), fake.Now())
	if d := time.Since(inner.since); d < 0 || d > time.Second {
		t.Fatalf("Mint's since is %s from now, want now", d)
	}
	r.Revoke(id.New(), fake.Now().Add(-10*time.Second))
	if d := time.Since(inner.at); d < 9*time.Second || d > 11*time.Second {
		t.Fatalf("Revoke's at is %s before now, want 10 s", d)
	}
}

func postJSON(t *testing.T, url string, body any) int {
	t.Helper()
	raw, _ := json.Marshal(body)
	res, err := http.Post(url, "application/json", bytes.NewReader(raw)) //nolint:noctx // test against httptest
	if err != nil {
		t.Fatal(err)
	}
	_ = res.Body.Close()
	return res.StatusCode
}

// POST /debug/sfu/sweep runs the room sweep now (204 with an SFU, 404 without one); POST
// /debug/afk/timeout stores a community's AFK timeout within the settings' range.
func TestTheSweepAndAFKTimeoutRoutes(t *testing.T) {
	webhook := freeAddr(t)
	_, tcp, udp, secretFile := startSidecar(t, webhook)
	h := sidecarHost(t, t.TempDir(), tcp, udp, secretFile, webhook)
	defer func() { _ = h.Close(context.Background()) }()
	control := httptest.NewServer(ControlHandler(h))
	defer control.Close()
	if code := postJSON(t, control.URL+"/debug/sfu/sweep", nil); code != http.StatusNoContent {
		t.Fatalf("POST /debug/sfu/sweep = %d", code)
	}

	owner, _, _ := seedOwedPerson(t, h, "afk-owner")
	community := id.New()
	if err := h.PutCommunityChannel(t.Context(), community, id.New(), VisibilityPrivate, ModeE2EE, []id.ID{owner}); err != nil {
		t.Fatal(err)
	}
	for name, body := range map[string]map[string]any{
		"too short":     {"community": community.String(), "seconds": 59},
		"too long":      {"community": community.String(), "seconds": 3601},
		"not an id":     {"community": "nope", "seconds": 60},
		"unknown field": {"community": community.String(), "seconds": 60, "x": 1},
	} {
		if code := postJSON(t, control.URL+"/debug/afk/timeout", body); code != http.StatusBadRequest {
			t.Errorf("%s: POST /debug/afk/timeout = %d, want 400", name, code)
		}
	}
	if code := postJSON(t, control.URL+"/debug/afk/timeout", map[string]any{"community": community.String(), "seconds": 60}); code != http.StatusNoContent {
		t.Fatalf("POST /debug/afk/timeout = %d", code)
	}
	if got, err := h.Server().Repo().GetCommunityAFK(t.Context(), community); err != nil || got.TimeoutSeconds != 60 {
		t.Fatalf("the stored AFK timeout = %+v, %v; want 60 s", got, err)
	}

	plain, err := NewHost(t.Context(), HostOptions{DataDir: t.TempDir(), CorePath: corePath(t)})
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = plain.Close(context.Background()) }()
	noSFU := httptest.NewServer(ControlHandler(plain))
	defer noSFU.Close()
	if code := postJSON(t, noSFU.URL+"/debug/sfu/sweep", nil); code != http.StatusNotFound {
		t.Fatalf("POST /debug/sfu/sweep without an SFU = %d, want 404", code)
	}
}
