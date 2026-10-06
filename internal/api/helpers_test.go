package api_test

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/pressly/goose/v3"
	_ "modernc.org/sqlite"

	"github.com/jonasthim/dilla/internal/api"
	"github.com/jonasthim/dilla/internal/auth"
	"github.com/jonasthim/dilla/internal/blob"
	"github.com/jonasthim/dilla/internal/clock"
	"github.com/jonasthim/dilla/internal/config"
	"github.com/jonasthim/dilla/internal/id"
	"github.com/jonasthim/dilla/internal/server"
	"github.com/jonasthim/dilla/internal/store"
	"github.com/jonasthim/dilla/internal/store/sqlite"
	sqlitemigrations "github.com/jonasthim/dilla/internal/store/sqlite/migrations"
)

// testHasher stands in for task 9's Argon2id *auth.Hasher, which does not exist
// yet. It is NOT a mock of the thing under test: what these tests assert is that
// a supplied password is hashed OUTSIDE the transaction and its PHC string
// stored, and the identity of the KDF is task 9's own tests' business. A real
// Argon2id hash here would add ~19 MiB and tens of milliseconds to every
// registration in the suite and prove nothing this file claims.
type testHasher struct{}

func (testHasher) Hash(_ context.Context, pw string) (string, error) {
	sum := sha256.Sum256([]byte(pw))
	return "$dilla-test$" + base64.RawStdEncoding.EncodeToString(sum[:]), nil
}

func (testHasher) Verify(_ context.Context, pw, phc string) (bool, bool, error) {
	got, err := testHasher{}.Hash(context.Background(), pw)
	return err == nil && got == phc, false, err
}

// newTestAPI opens a migrated SQLite repository in a temporary directory,
// registers every route this task owns on a real server.Mux, and returns the
// handler and the Deps behind it. Nothing is stubbed but the password hasher:
// the store is real SQLite, the sessions are real auth.Sessions, and the
// requests go through the real mux.
func newTestAPI(t *testing.T) (http.Handler, api.Deps) {
	t.Helper()
	return newTestAPIWithConfig(t, nil)
}

// newTestAPIWithConfig is newTestAPI with one hook into the configuration the
// harness is built from, called after config.Default() and before anything
// reads it. A throttling test has to be able to move one limit out of the way
// so the limit it is actually about is the one that fires; every other test
// keeps the defaults.
func newTestAPIWithConfig(t *testing.T, tune func(*config.Config)) (http.Handler, api.Deps) {
	t.Helper()
	path := filepath.Join(t.TempDir(), "api.db")
	write, err := sqlite.OpenWrite(path)
	if err != nil {
		t.Fatalf("OpenWrite: %v", err)
	}
	p, err := goose.NewProvider(goose.DialectSQLite3, write, sqlitemigrations.FS)
	if err != nil {
		t.Fatalf("provider: %v", err)
	}
	if _, err := p.Up(context.Background()); err != nil {
		t.Fatalf("up: %v", err)
	}
	read, err := sqlite.OpenRead(path)
	if err != nil {
		t.Fatalf("OpenRead: %v", err)
	}
	repo := sqlite.New(write, read)
	t.Cleanup(func() { repo.Close() })
	bs, err := blob.Open(filepath.Join(t.TempDir(), "blobs"), "fs")
	if err != nil {
		t.Fatalf("blob.Open: %v", err)
	}
	t.Cleanup(func() { _ = bs.Close() })

	clk := clock.NewFake(time.Date(2026, 9, 24, 12, 0, 0, 0, time.UTC))
	cfg := config.Default()
	cfg.Instance.Domain = "dilla.test"
	if tune != nil {
		tune(cfg)
	}
	instance := store.InstanceRow{
		InstanceID: id.New(), ExternalSenderKeyID: id.New(), KeyHistory: []byte{1},
		FrankingKeyID: id.New(), Generation: 7, PolicyVersion: 1, Created: clk.Now().Unix(),
	}
	if err := repo.CreateInstance(context.Background(), instance); err != nil {
		t.Fatalf("CreateInstance: %v", err)
	}
	sessions := auth.NewSessions(repo, clk, cfg.Auth.Session, instance.InstanceID, instance.Generation)
	sessions.DeviceLists = &testLister{keys: map[id.ID][][]byte{}}

	deps := api.Deps{
		Repo:         repo,
		Clock:        clk,
		Log:          slog.New(slog.NewTextHandler(io.Discard, nil)),
		Limiter:      server.NewRateLimiter(cfg.Limits.Rate, clk),
		Instance:     instance,
		Domain:       cfg.Instance.Domain,
		Config:       cfg,
		Registration: cfg.Registration,
		Sessions:     sessions,
		Hasher:       testHasher{},
		Throttle:     auth.NewThrottle(cfg.Limits.Rate, cfg.Auth.Lockout, clk),
		Assertions:   api.NewAssertions(clk, api.AssertionTTL),
		Blobs:        bs,
	}
	deps.Sessions.Assertions = deps.Assertions
	m := server.NewMux()
	api.Register(m, deps)
	return m, deps
}

// seedInvite mints an ordinary invite with max_uses uses and no admin grant,
// and returns the plain code.
func seedInvite(t *testing.T, d api.Deps, maxUses uint64) string {
	t.Helper()
	return seedInviteAdmin(t, d, maxUses, 0)
}

// seedAdminInvite mints the one-use bootstrap invite `dillad init` writes:
// grants_admin = 1, which is the only thing that ever sets
// store.UserFlagInstanceAdmin.
func seedAdminInvite(t *testing.T, d api.Deps) string {
	t.Helper()
	return seedInviteAdmin(t, d, 1, 1)
}

func seedInviteAdmin(t *testing.T, d api.Deps, maxUses uint64, grantsAdmin uint8) string {
	t.Helper()
	code, hash := auth.NewInviteCode()
	now := d.Clock.Now().Unix()
	row := store.InviteRow{
		ID: id.New(), CodeHash: hash, GrantsAdmin: grantsAdmin, MaxUses: maxUses,
		Created: now, ExpiresAt: now + int64(24*time.Hour/time.Second),
	}
	if err := d.Repo.CreateInvite(context.Background(), row); err != nil {
		t.Fatalf("CreateInvite: %v", err)
	}
	return code
}

// seedAPIDevice creates a user and one native device and returns both rows and
// the device's Ed25519 signing key.
func seedAPIDevice(t *testing.T, d api.Deps) (store.UserRow, store.DeviceRow, ed25519.PrivateKey) {
	t.Helper()
	ctx := context.Background()
	now := d.Clock.Now().Unix()
	u := store.UserRow{
		ID: id.New(), Username: "user" + id.New().String()[:8], Display: "User",
		UMKPub: make([]byte, 32), SSKPub: make([]byte, 32), SigUMKSSK: make([]byte, 64),
		Created: now,
	}
	if err := d.Repo.CreateUser(ctx, u); err != nil {
		t.Fatalf("CreateUser: %v", err)
	}
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("GenerateKey: %v", err)
	}
	verified := now
	dev := store.DeviceRow{
		ID: id.New(), UserID: u.ID, DSKPub: pub, Tier: 0, SignerTier: 0,
		CredentialBlob: []byte{1}, VerifiedAt: &verified, LastSeen: now, Created: now,
	}
	if err := d.Repo.CreateDevice(ctx, dev); err != nil {
		t.Fatalf("CreateDevice: %v", err)
	}
	return u, dev, priv
}

// seedAPISession creates a user, a device and one live enrolled session, and
// returns the bearer token. The session is established through the real
// challenge-and-signature path, so nothing here can pass a test the wire could
// not.
func seedAPISession(t *testing.T, d api.Deps) (store.UserRow, store.DeviceRow, string) {
	t.Helper()
	ctx := context.Background()
	u, dev, priv := seedAPIDevice(t, d)
	nonce, _, err := d.Sessions.Challenge(ctx, dev.ID)
	if err != nil {
		t.Fatalf("Challenge: %v", err)
	}
	pre := auth.SessionPreimage(d.Sessions.InstanceID(), dev.ID, nonce, auth.PurposeSession)
	tok, err := d.Sessions.Establish(ctx, auth.EstablishRequest{
		DeviceID: dev.ID, Nonce: nonce, Purpose: auth.PurposeSession, Sig: ed25519.Sign(priv, pre),
	})
	if err != nil {
		t.Fatalf("Establish: %v", err)
	}
	return u, dev, tok.Token
}

// seedSession is seedAPISession under the name the accounts tests use.
func seedSession(t *testing.T, d api.Deps) (store.UserRow, store.DeviceRow, string) {
	t.Helper()
	return seedAPISession(t, d)
}

// post sends body as application/cbor. It never calls t.Fatal, because the
// concurrent-redemption test calls it from 64 goroutines and a Fatal outside
// the test goroutine is a silent Goexit.
func post(_ *testing.T, h http.Handler, path string, body []byte) *httptest.ResponseRecorder {
	return postCBOR(h, path, body)
}

// postCBOR posts an unauthenticated CBOR body.
func postCBOR(h http.Handler, path string, body []byte) *httptest.ResponseRecorder {
	return postCBORAuth(h, path, body, "")
}

// postCBORAuth is postCBOR with an Authorization: Bearer header.
func postCBORAuth(h http.Handler, path string, body []byte, token string) *httptest.ResponseRecorder {
	req := httptest.NewRequestWithContext(context.Background(), http.MethodPost, path, bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/cbor")
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

// testLister is the device-list gate the api tests run behind: a user it has no keys for has
// published no list (the no-list clause, so every seeded device establishes enrolled, exactly as
// web-1's fixtures always did), and a test lists a user's keys to drive the listed and unlisted
// branches of protocol/02 § Device sessions item 4.
type testLister struct {
	mu   sync.Mutex
	keys map[id.ID][][]byte
}

func (l *testLister) ListedKeys(_ context.Context, user id.ID) ([][]byte, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	keys, ok := l.keys[user]
	if !ok {
		return nil, auth.ErrNoDeviceList
	}
	return keys, nil
}

func (l *testLister) list(user id.ID, keys ...[]byte) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.keys[user] = keys
}

func listerOf(t *testing.T, d api.Deps) *testLister {
	t.Helper()
	l, ok := d.Sessions.DeviceLists.(*testLister)
	if !ok {
		t.Fatalf("Sessions.DeviceLists is %T, want the harness's *testLister", d.Sessions.DeviceLists)
	}
	return l
}
