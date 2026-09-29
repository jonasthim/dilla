package api_test

import (
	"bytes"
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/fxamacker/cbor/v2"
	"github.com/pressly/goose/v3"

	"github.com/jonasthim/dilla/internal/auth"
	"github.com/jonasthim/dilla/internal/cborx"
	"github.com/jonasthim/dilla/internal/clock"
	"github.com/jonasthim/dilla/internal/id"
	"github.com/jonasthim/dilla/internal/server"
	"github.com/jonasthim/dilla/internal/store"
	"github.com/jonasthim/dilla/internal/store/sqlite"
	sqlitemigrations "github.com/jonasthim/dilla/internal/store/sqlite/migrations"
)

// env is the shared internal/api harness Plan 2's handler tests build on: a
// real migrated SQLite repository, a fake clock, a real server.Mux behind a
// real httptest server, and a stand-in for the session middleware. Each test
// registers only the handlers it drives.
type env struct {
	t    *testing.T
	Repo store.Repository
	Clk  *clock.Fake
	Mux  *server.Mux
	Srv  *httptest.Server
	sess map[string]auth.Session // bearer token -> session
}

// newEnv builds a repository over a temp SQLite file, migrates it, and returns an
// httptest server whose mux is empty; each test registers the handlers it needs.
func newEnv(t *testing.T) *env {
	t.Helper()
	path := filepath.Join(t.TempDir(), "dilla.db")
	write, err := sqlite.OpenWrite(path)
	if err != nil {
		t.Fatalf("OpenWrite: %v", err)
	}
	p, err := goose.NewProvider(goose.DialectSQLite3, write, sqlitemigrations.FS)
	if err != nil {
		t.Fatalf("goose provider: %v", err)
	}
	if _, err := p.Up(context.Background()); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	read, err := sqlite.OpenRead(path)
	if err != nil {
		t.Fatalf("OpenRead: %v", err)
	}
	repo := sqlite.New(write, read)
	t.Cleanup(func() { _ = repo.Close() })

	clk := clock.NewFake(time.Unix(1_790_000_000, 0).UTC())
	e := &env{
		t:    t,
		Repo: repo,
		Clk:  clk,
		Mux:  server.NewMux(),
		sess: map[string]auth.Session{},
	}
	e.Srv = httptest.NewServer(e.authMiddleware(e.Mux))
	t.Cleanup(e.Srv.Close)
	return e
}

// authMiddleware is the test stand-in for auth.Sessions.Middleware: it maps a
// bearer token registered by NewUser to an auth.Session on the request context.
func (e *env) authMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		tok, _ := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer ")
		if s, ok := e.sess[tok]; ok {
			r = r.WithContext(auth.WithSession(r.Context(), s))
		}
		next.ServeHTTP(w, r)
	})
}

// NewUser creates a user row plus one device, and returns the bearer token that
// authenticates as that (user, device) with an enrolled session.
func (e *env) NewUser(username string) (id.ID, string) {
	e.t.Helper()
	uid, did := id.New(), id.New()
	now := e.Clk.Now().Unix()
	if err := e.Repo.CreateUser(context.Background(), newAPITestUser(uid, username, now)); err != nil {
		e.t.Fatalf("CreateUser: %v", err)
	}
	if err := e.Repo.CreateDevice(context.Background(), newAPITestDevice(did, uid, now)); err != nil {
		e.t.Fatalf("CreateDevice: %v", err)
	}
	tok := uid.String()
	e.sess[tok] = auth.Session{UserID: uid, DeviceID: did, Scope: auth.ScopeEnrolled}
	return uid, tok
}

// Do sends one CBOR request and returns the status and the raw body.
func (e *env) Do(method, path, token string, body any) (int, []byte) {
	e.t.Helper()
	var rdr *bytes.Reader
	if body != nil {
		b, err := cborx.Marshal(body)
		if err != nil {
			e.t.Fatalf("cborx.Marshal: %v", err)
		}
		rdr = bytes.NewReader(b)
	} else {
		rdr = bytes.NewReader(nil)
	}
	req, err := http.NewRequestWithContext(e.t.Context(), method, e.Srv.URL+path, rdr)
	if err != nil {
		e.t.Fatalf("NewRequest: %v", err)
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/cbor")
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	resp, err := e.Srv.Client().Do(req)
	if err != nil {
		e.t.Fatalf("Do %s %s: %v", method, path, err)
	}
	defer resp.Body.Close()
	out, err := io.ReadAll(resp.Body)
	if err != nil {
		e.t.Fatalf("ReadAll: %v", err)
	}
	return resp.StatusCode, out
}

// ErrCode decodes an E_* error body and returns its code.
func (e *env) ErrCode(body []byte) string {
	e.t.Helper()
	var arr []cbor.RawMessage
	if err := cborx.Unmarshal(body, &arr); err != nil {
		e.t.Fatalf("error body is not a CBOR array: %v (%x)", err, body)
	}
	if len(arr) == 0 {
		e.t.Fatalf("error body is an empty array")
	}
	var code string
	if err := cborx.Unmarshal(arr[0], &code); err != nil {
		e.t.Fatalf("error code: %v", err)
	}
	return code
}

// newAPITestUser is a store.UserRow with the minimum non-null columns of §4.3.
func newAPITestUser(uid id.ID, username string, created int64) store.UserRow {
	return store.UserRow{
		ID: uid, Username: username + "-" + uid.String()[:8], Display: username,
		UMKPub: make([]byte, 32), SSKPub: make([]byte, 32), SigUMKSSK: make([]byte, 64),
		Created: created,
	}
}

// newAPITestDevice is a store.DeviceRow with the minimum non-null columns of §4.3.
func newAPITestDevice(did, uid id.ID, created int64) store.DeviceRow {
	return store.DeviceRow{
		ID: did, UserID: uid, DSKPub: make([]byte, 32), CredentialBlob: []byte{1},
		LastSeen: created, Created: created,
	}
}
