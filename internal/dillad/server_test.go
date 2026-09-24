package dillad_test

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/hex"
	"go/build"
	"net"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/jonasthim/dilla/internal/auth"
	"github.com/jonasthim/dilla/internal/cborx"
	"github.com/jonasthim/dilla/internal/clock"
	"github.com/jonasthim/dilla/internal/config"
	"github.com/jonasthim/dilla/internal/dillad"
	"github.com/jonasthim/dilla/internal/id"
	"github.com/jonasthim/dilla/internal/server"
	"github.com/jonasthim/dilla/internal/store"
	"github.com/jonasthim/dilla/internal/store/sqlite"
	sqlitemigrations "github.com/jonasthim/dilla/internal/store/sqlite/migrations"
	"github.com/pressly/goose/v3"
	_ "modernc.org/sqlite"
)

// testConfig writes a dilla.toml under t.TempDir(), migrates the database it
// names and inserts the instance row and one bootstrap invite, exactly as
// `dillad init` does, and returns the loaded config. newInstance is testConfig
// plus dillad.New, returning the server, its handler and the invite code;
// newInstanceWith takes a mutator that runs on the config before New.
func testConfig(t *testing.T) *config.Config {
	t.Helper()
	cfg, _ := testConfigInvite(t)
	return cfg
}

// testConfigInvite is testConfig plus the plain bootstrap invite code, which is
// printed once by `dillad init` and is not recoverable from the database.
func testConfigInvite(t *testing.T) (*config.Config, string) {
	t.Helper()
	dir := t.TempDir()

	c := config.Default()
	c.Instance.Domain = "dilla.test"
	c.Instance.PublicIP = netip.MustParseAddr("203.0.113.7")
	c.Instance.DataDir = dir
	c.DB.Path = filepath.Join(dir, "dilla.db")
	c.Blobs.Dir = filepath.Join(dir, "blobs")
	c.TLS.Agreed = true
	c.TURN.SharedSecretFile = writeTestSecret(t, dir, "turn.secret")
	c.TURN.RelayIP = c.Instance.PublicIP.String()
	c.LiveKit.APISecretFile = writeTestSecret(t, dir, "livekit.secret")
	c.Derive()

	write, err := sqlite.OpenWrite(c.DB.Path)
	if err != nil {
		t.Fatalf("OpenWrite: %v", err)
	}
	provider, err := goose.NewProvider(goose.DialectSQLite3, write, sqlitemigrations.FS)
	if err != nil {
		write.Close()
		t.Fatalf("goose provider: %v", err)
	}
	if _, err := provider.Up(context.Background()); err != nil {
		write.Close()
		t.Fatalf("goose up: %v", err)
	}
	read, err := sqlite.OpenRead(c.DB.Path)
	if err != nil {
		write.Close()
		t.Fatalf("OpenRead: %v", err)
	}
	repo := sqlite.New(write, read)

	now := time.Now().Unix()
	instance := store.InstanceRow{
		InstanceID: id.New(), ExternalSenderKeyID: id.New(), KeyHistory: []byte{1},
		FrankingKeyID: id.New(), Generation: 1, PolicyVersion: 1, Created: now,
	}
	code, hash := auth.NewInviteCode()
	invite := store.InviteRow{
		ID: id.New(), CodeHash: hash, GrantsAdmin: 1, MaxUses: 1,
		Created: now, ExpiresAt: now + int64(24*time.Hour/time.Second),
	}
	if err := repo.Tx(context.Background(), func(tx store.Repository) error {
		if err := tx.CreateInstance(context.Background(), instance); err != nil {
			return err
		}
		return tx.CreateInvite(context.Background(), invite)
	}); err != nil {
		repo.Close()
		t.Fatalf("bootstrap: %v", err)
	}
	// The composition root opens its own pools from the config, exactly as
	// `dillad serve` does, so the seeding pools are closed here.
	if err := repo.Close(); err != nil {
		t.Fatalf("close seeding repository: %v", err)
	}

	cfgPath := filepath.Join(dir, "dilla.toml")
	f, err := os.OpenFile(cfgPath, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		t.Fatalf("create dilla.toml: %v", err)
	}
	if err := c.WriteTo(f); err != nil {
		f.Close()
		t.Fatalf("write dilla.toml: %v", err)
	}
	if err := f.Close(); err != nil {
		t.Fatalf("close dilla.toml: %v", err)
	}
	loaded, err := config.Load(cfgPath)
	if err != nil {
		t.Fatalf("config.Load: %v", err)
	}
	return loaded, code
}

// writeTestSecret writes 32 CSPRNG bytes as hex at 0600: config.Validate refuses
// a secret file that is missing, group-readable or under 32 bytes.
func writeTestSecret(t *testing.T, dir, name string) string {
	t.Helper()
	buf := make([]byte, 32)
	if _, err := rand.Read(buf); err != nil {
		t.Fatalf("rand: %v", err)
	}
	path := filepath.Join(dir, name)
	if err := os.WriteFile(path, []byte(hex.EncodeToString(buf)), 0o600); err != nil {
		t.Fatalf("write %s: %v", path, err)
	}
	return path
}

func newInstance(t *testing.T) (*dillad.Server, http.Handler, string) {
	t.Helper()
	return newInstanceWith(t, nil)
}

func newInstanceWith(t *testing.T, tune func(*config.Config)) (*dillad.Server, http.Handler, string) {
	t.Helper()
	cfg, code := testConfigInvite(t)
	if tune != nil {
		tune(cfg)
	}
	srv, err := dillad.New(context.Background(), dillad.Options{Config: cfg, Clock: clock.System()})
	if err != nil {
		t.Fatalf("dillad.New: %v", err)
	}
	return srv, srv.Handler(), code
}

// testDevice is one client device's identity: the 16-byte id the registration
// body carries and the Ed25519 key the session ceremony proves possession of.
type testDevice struct {
	ID   id.ID
	Priv ed25519.PrivateKey
}

func newTestDevice(t *testing.T) testDevice {
	t.Helper()
	_, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("GenerateKey: %v", err)
	}
	return testDevice{ID: id.New(), Priv: priv}
}

// newAccountRequest is POST /v1/accounts' eight-element body (interfaces.md
// §5.1). The identity keys are zero-filled: nothing in this file verifies them,
// and the lengths are all CreateAccount checks.
func newAccountRequest(code, username string, dev testDevice) []any {
	return []any{
		code, username, "Jonas",
		make([]byte, 32), make([]byte, 32), make([]byte, 64),
		nil,
		[]any{
			dev.ID, []byte(dev.Priv.Public().(ed25519.PublicKey)),
			uint64(0), uint64(0), []byte{1},
		},
	}
}

func post(_ *testing.T, h http.Handler, path string, body []byte) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodPost, path, bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/cbor")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

// establishSession runs the real two-leg session ceremony against the handler
// and returns the establish response.
func establishSession(t *testing.T, h http.Handler, srv *dillad.Server, dev testDevice) *httptest.ResponseRecorder {
	t.Helper()
	res := post(t, h, "/v1/devices/"+dev.ID.String()+"/sessions/challenge", nil)
	if res.Code != http.StatusCreated {
		t.Fatalf("POST sessions/challenge = %d", res.Code)
	}
	var challenge []any
	if err := cborx.Unmarshal(res.Body.Bytes(), &challenge); err != nil {
		t.Fatalf("decode challenge: %v", err)
	}
	nonce, ok := challenge[0].([]byte)
	if !ok {
		t.Fatalf("challenge element 0 is %T, want a byte string", challenge[0])
	}
	pre := auth.SessionPreimage(srv.Sessions().InstanceID(), dev.ID, nonce, auth.PurposeSession)
	body, err := cborx.Marshal([]any{nonce, uint64(auth.PurposeSession), ed25519.Sign(dev.Priv, pre), nil, nil})
	if err != nil {
		t.Fatalf("marshal establish: %v", err)
	}
	return post(t, h, "/v1/devices/"+dev.ID.String()+"/sessions", body)
}

func TestRegisterEstablishAndReadTheInstanceDocument(t *testing.T) {
	srv, h, code := newInstance(t) // migrated SQLite, one bootstrap invite
	defer srv.Shutdown(context.Background())

	// 1. redeem the invite and create the account, which also mints the first
	//    device session.
	dev := newTestDevice(t)
	body, _ := cborx.Marshal(newAccountRequest(code, "jonas", dev))
	res := post(t, h, "/v1/accounts", body)
	if res.Code != http.StatusOK {
		t.Fatalf("POST /v1/accounts = %d", res.Code)
	}
	var account []any
	if err := cborx.Unmarshal(res.Body.Bytes(), &account); err != nil {
		t.Fatalf("decode: %v", err)
	}
	token, ok := account[2].(string)
	if !ok || token == "" {
		t.Fatalf("no session token in the account response: %#v", account)
	}

	// 2. the instance document, with and without a session.
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/v1/instance", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("GET /v1/instance = %d with discovery = public", rec.Code)
	}
	var doc []any
	if err := cborx.Unmarshal(rec.Body.Bytes(), &doc); err != nil {
		t.Fatalf("decode instance: %v", err)
	}
	if len(doc) != 9 {
		t.Fatalf("the instance document has %d elements, want 9", len(doc))
	}

	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/v1/instance/limits", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("GET /v1/instance/limits = %d", rec.Code)
	}
	var limits []uint64
	if err := cborx.Unmarshal(rec.Body.Bytes(), &limits); err != nil {
		t.Fatalf("decode limits: %v", err)
	}
	if len(limits) != 11 {
		t.Fatalf("the limits document has %d elements, want 11", len(limits))
	}
	if limits[0] != 131072 {
		t.Fatalf("max_ciphertext_bytes = %d, want 131072", limits[0])
	}
	if limits[8] != limits[0]+512 {
		t.Fatalf("max_frame_bytes = %d, want max_ciphertext_bytes + 512 = %d", limits[8], limits[0]+512)
	}

	// The session response's element 6 and the X-Dilla-Generation header carry
	// the same number, so a client that compares them sees a restore and not a
	// bug (R29, D12). POST /v1/accounts answers the FOUR-element array
	// interfaces.md §5.1 fixes and carries no generation element, so the
	// comparison is made on the session ceremony's own seven-element answer.
	if got := res.Header().Get("X-Dilla-Generation"); got != "1" {
		t.Fatalf("X-Dilla-Generation = %q on the registration response, want \"1\"", got)
	}
	sres := establishSession(t, h, srv, dev)
	if sres.Code != http.StatusCreated {
		t.Fatalf("POST /v1/devices/{device_id}/sessions = %d", sres.Code)
	}
	var session []any
	if err := cborx.Unmarshal(sres.Body.Bytes(), &session); err != nil {
		t.Fatalf("decode session: %v", err)
	}
	if len(session) != 7 {
		t.Fatalf("the session response has %d elements, want 7", len(session))
	}
	if session[6] != uint64(1) {
		t.Fatalf("the session response's generation = %v, want 1 on a fresh instance", session[6])
	}
	if got := sres.Header().Get("X-Dilla-Generation"); got != "1" {
		t.Fatalf("X-Dilla-Generation = %q on the same response, want \"1\"", got)
	}

	// 3. an authenticated read.
	req := httptest.NewRequest(http.MethodGet, "/v1/accounts/me", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("GET /v1/accounts/me = %d", rec.Code)
	}
}

func TestEveryResponseCarriesTheGenerationHeader(t *testing.T) {
	srv, h, _ := newInstance(t)
	defer srv.Shutdown(context.Background())
	for _, path := range []string{"/v1/instance", "/v1/instance/limits", "/healthz", "/v1/accounts/me"} {
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, path, nil))
		if rec.Header().Get("X-Dilla-Generation") == "" {
			t.Fatalf("%s carries no X-Dilla-Generation header (status %d)", path, rec.Code)
		}
	}
}

func TestDiscoverySessionMakesTheInstanceDocumentAuthenticated(t *testing.T) {
	srv, h, _ := newInstanceWith(t, func(c *config.Config) { c.Instance.Discovery = "session" })
	defer srv.Shutdown(context.Background())
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/v1/instance", nil))
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("GET /v1/instance = %d with discovery = session, want 401", rec.Code)
	}
}

func TestShutdownClosesTheListenerWithinTheGrace(t *testing.T) {
	srv, _, _ := newInstance(t)
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	go srv.Serve(context.Background(), ln)
	time.Sleep(50 * time.Millisecond)
	start := time.Now()
	if err := srv.Shutdown(context.Background()); err != nil {
		t.Fatalf("Shutdown: %v", err)
	}
	if elapsed := time.Since(start); elapsed > 30*time.Second {
		t.Fatalf("Shutdown took %s, longer than shutdown_grace", elapsed)
	}
	if _, err := net.DialTimeout("tcp", ln.Addr().String(), 200*time.Millisecond); err == nil {
		t.Fatal("the listener is still accepting connections after Shutdown")
	}
}

// facts-http-gateway §4.1 is a recorded CORRECTION: h2c is stdlib in Go 1.27
// (Server.Protocols + SetUnencryptedHTTP2), not x/net/http2/h2c. Without the
// field a front proxy speaking unencrypted HTTP/2 cannot reach the API in
// behind_proxy mode, and the one fact the facts file went out of its way to
// correct goes silently unused.
func TestTheServerSpeaksUnencryptedHTTP2AndHTTP1(t *testing.T) {
	srv, _, _ := newInstance(t)
	defer srv.Shutdown(context.Background())
	p := srv.Protocols()
	if p == nil {
		t.Fatal("http.Server.Protocols is unset; the listener is HTTP/1 only")
	}
	if !p.UnencryptedHTTP2() {
		t.Fatal("unencrypted HTTP/2 is not enabled")
	}
	if !p.HTTP1() {
		t.Fatal("HTTP/1 is not enabled; the /gateway route needs it for the WebSocket upgrade")
	}
}

// interfaces.md §7.3 requires the test harness to reach the repository, the
// delivery service and the gateway. Part 1b fills the last two; all three
// accessors must exist here so 1b changes their contents and not this file's
// shape. And Options must default what it is not given: part 1b's harness calls
// New with Config and Clock alone.
func TestNewDefaultsTheCollaboratorsItIsNotGiven(t *testing.T) {
	cfg := testConfig(t) // writes dilla.toml, migrates the database, runs init's bootstrap
	srv, err := dillad.New(context.Background(), dillad.Options{Config: cfg, Clock: clock.System()})
	if err != nil {
		t.Fatalf("New with only Config and Clock: %v", err)
	}
	defer srv.Shutdown(context.Background())
	if srv.Repo() == nil {
		t.Fatal("Server.Repo() is nil after New opened the store itself")
	}
	if srv.Mux() == nil {
		t.Fatal("Server.Mux() is nil; parts 1b and 2 mount their routes through it")
	}
	if srv.DS() != nil || srv.Gateway() != nil {
		t.Fatal("DS() and Gateway() must be nil in 1a, and present for 1b to fill")
	}
}

// Options.Extra is the registrar hook parts 1b and 2 mount through.
func TestExtraRegistrarsAreMounted(t *testing.T) {
	cfg := testConfig(t)
	srv, err := dillad.New(context.Background(), dillad.Options{
		Config: cfg, Clock: clock.System(),
		Extra: []func(*server.Mux){func(m *server.Mux) {
			m.HandleFunc("GET /v1/extra", func(w http.ResponseWriter, r *http.Request) {
				w.WriteHeader(http.StatusTeapot)
			})
		}},
	})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	defer srv.Shutdown(context.Background())
	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/v1/extra", nil))
	if rec.Code != http.StatusTeapot {
		t.Fatalf("an Extra registrar's route answered %d; it was never mounted", rec.Code)
	}
}

// metrics.require_admin is on by DEFAULT and Options.ScrapeToken is a plain
// string, so the composition root must not hand obs.Metrics.Handler an empty
// token: it compares the Authorization header against it in constant time, and
// a request with no header compares equal to "". Mounting /metrics that way
// would publish every counter of a default instance to anyone who asks.
func TestMetricsIsNotOpenWhenNoScrapeTokenWasSupplied(t *testing.T) {
	srv, h, _ := newInstance(t)
	defer srv.Shutdown(context.Background())
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/metrics", nil))
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("GET /metrics with no Authorization header = %d, want 401", rec.Code)
	}
	if strings.Contains(rec.Body.String(), "dilla_http_requests_total") {
		t.Fatal("an unauthenticated scrape read the registry")
	}
}

// goToolPath resolves the `go` command to shell out to. It must NOT be a
// literal absolute path: the toolchain lives at /home/thim/.local/go on the
// development box and under /opt/hostedtoolcache/go/<version>/x64 on the CI
// runner actions/setup-go provisions, so a hard-coded path makes exec.Command
// fail to start in CI ("fork/exec …: no such file or directory") and turns the
// fail-closed `go` gate red on a machine where nothing is actually wrong.
//
// build.Default.GOROOT is $GOROOT when it is set and otherwise the GOROOT of
// the toolchain that built this test binary — the one whose `go list` already
// agrees with go.mod's `go 1.27.0`, so it is preferred over PATH, which may
// hold an older go that would try to download a toolchain instead.
func goToolPath(t *testing.T) string {
	t.Helper()
	if root := build.Default.GOROOT; root != "" {
		p := filepath.Join(root, "bin", "go")
		if fi, err := os.Stat(p); err == nil && !fi.IsDir() {
			return p
		}
	}
	p, err := exec.LookPath("go")
	if err != nil {
		t.Fatalf("no go toolchain: GOROOT %q holds no bin/go and PATH has none: %v", build.Default.GOROOT, err)
	}
	return p
}

func TestTheReleaseBinaryDoesNotLinkTheTestHelpers(t *testing.T) {
	// The MODULE path, not "./cmd/dillad": the test's working directory is
	// internal/dillad, where that relative path does not exist and go list exits
	// non-zero on every run.
	out, err := exec.Command(goToolPath(t), "list", "-deps",
		"github.com/jonasthim/dilla/cmd/dillad").Output()
	if err != nil {
		t.Fatalf("go list: %v", err)
	}
	if strings.Contains(string(out), "dilladtest") {
		t.Fatal("cmd/dillad depends on internal/dillad/dilladtest; the seeding helpers must never ship")
	}
}
