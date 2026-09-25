package auth_test

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/jonasthim/dilla/internal/auth"
	"github.com/jonasthim/dilla/internal/clock"
	"github.com/jonasthim/dilla/internal/config"
	"github.com/jonasthim/dilla/internal/id"
	"github.com/jonasthim/dilla/internal/store"
	"github.com/jonasthim/dilla/internal/store/sqlite"
	sqlitemigrations "github.com/jonasthim/dilla/internal/store/sqlite/migrations"
	"github.com/pressly/goose/v3"
	_ "modernc.org/sqlite"
)

// authDBPaths lets corruptDSKPub reach the file behind a repository, which is
// the only way to write a row the schema's CHECK forbids.
var authDBPaths = map[store.Repository]string{}

// newSessions returns a Sessions over a migrated temporary database and the
// fake clock that drives it. The generation is 7, so a Token.Generation of 0 is
// a failure rather than a coincidence.
func newSessions(t *testing.T) (*auth.Sessions, store.Repository, *clock.Fake) {
	t.Helper()
	path := filepath.Join(t.TempDir(), "sessions.db")
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
	authDBPaths[repo] = path
	clk := clock.NewFake(time.Date(2026, 9, 24, 12, 0, 0, 0, time.UTC))
	return auth.NewSessions(repo, clk, config.Default().Auth.Session, id.New(), 7), repo, clk
}

// seedDevice creates a user and one native device, and returns the device's
// signing key. seedDeviceTier does the same at a chosen tier: 0 native,
// 1 browser.
func seedDevice(t *testing.T, repo store.Repository) (id.ID, id.ID, ed25519.PrivateKey) {
	t.Helper()
	return seedDeviceTier(t, repo, 0)
}

func seedDeviceTier(t *testing.T, repo store.Repository, tier uint8) (id.ID, id.ID, ed25519.PrivateKey) {
	t.Helper()
	ctx := context.Background()
	u := store.UserRow{ID: id.New(), Username: "jonas" + id.New().String()[:8], Display: "Jonas",
		UMKPub: make([]byte, 32), SSKPub: make([]byte, 32), SigUMKSSK: make([]byte, 64), Created: 1}
	if err := repo.CreateUser(ctx, u); err != nil {
		t.Fatalf("CreateUser: %v", err)
	}
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("GenerateKey: %v", err)
	}
	verified := int64(1)
	d := store.DeviceRow{ID: id.New(), UserID: u.ID, DSKPub: pub, Tier: tier, SignerTier: 0,
		CredentialBlob: []byte{1}, VerifiedAt: &verified, LastSeen: 1, Created: 1}
	if err := repo.CreateDevice(ctx, d); err != nil {
		t.Fatalf("CreateDevice: %v", err)
	}
	return u.ID, d.ID, priv
}

// corruptDSKPub writes a wrong-length dsk_pub straight into the row. The
// schema's CHECK (length(dsk_pub) = 32) is expected to refuse, which is the
// stronger guarantee; the caller skips in that case.
func corruptDSKPub(repo store.Repository, device id.ID, n int) error {
	db, err := sql.Open("sqlite", "file:"+authDBPaths[repo])
	if err != nil {
		return err
	}
	defer db.Close()
	_, err = db.Exec(`UPDATE devices SET dsk_pub = ? WHERE id = ?`, make([]byte, n), device[:])
	return err
}

// fakeAssertions is the enrolment-assertion store Sessions spends on the
// pending path. The concrete type lives in internal/api (task 9); Sessions
// takes the one-method interface, so a test needs no import cycle.
type fakeAssertions struct{ items map[string]id.ID }

func newFakeAssertions() *fakeAssertions { return &fakeAssertions{items: map[string]id.ID{}} }

func (f *fakeAssertions) issue(user id.ID) string {
	token := id.New().String()
	f.items[token] = user
	return token
}

func (f *fakeAssertions) Spend(token string) (id.ID, bool, bool) {
	user, ok := f.items[token]
	if !ok {
		return id.ID{}, false, false
	}
	delete(f.items, token)
	return user, false, true
}

func TestPreimageIsEightyOneBytesAndMatchesTheVector(t *testing.T) {
	instance, _ := id.Parse("00112233445566778899aabbccddeeff")
	device, _ := id.Parse("0102030405060708090a0b0c0d0e0f10")
	nonce := bytes.Repeat([]byte{0xab}, 32)
	got := auth.SessionPreimage(instance, device, nonce, auth.PurposeSession)
	if len(got) != 81 {
		t.Fatalf("preimage is %d bytes, want 81 (16 + 16 + 16 + 32 + 1)", len(got))
	}
	if string(got[:16]) != "dilla session v1" {
		t.Fatalf("domain separator = %q", got[:16])
	}
	if !bytes.Equal(got[16:32], instance[:]) || !bytes.Equal(got[32:48], device[:]) {
		t.Fatal("instance_id or device_id is not in its documented position")
	}
	if !bytes.Equal(got[48:80], nonce) || got[80] != 0 {
		t.Fatal("nonce or purpose is not in its documented position")
	}

	// The same bytes are in protocol/vectors/identity.json, so a client in any
	// language can check itself against the instance.
	body, err := os.ReadFile("../../protocol/vectors/identity.json")
	if err != nil {
		t.Fatalf("read identity.json: %v", err)
	}
	var doc struct {
		SessionPreimage struct {
			InstanceID, DeviceID, Nonce, Preimage string
			Purpose                               int
		} `json:"session_preimage"`
	}
	if err := json.Unmarshal(body, &doc); err != nil {
		t.Fatalf("parse identity.json: %v", err)
	}
	if doc.SessionPreimage.Preimage != hex.EncodeToString(got) {
		t.Fatalf("vector preimage %s != computed %s", doc.SessionPreimage.Preimage, hex.EncodeToString(got))
	}
}

func TestPurposeIsBoundIntoTheSignature(t *testing.T) {
	instance := id.New()
	device := id.New()
	nonce := bytes.Repeat([]byte{7}, 32)
	establish := auth.SessionPreimage(instance, device, nonce, auth.PurposeSession)
	renew := auth.SessionPreimage(instance, device, nonce, auth.PurposeRenew)
	if bytes.Equal(establish, renew) {
		t.Fatal("purpose is not bound into the preimage; a renew signature could be replayed as an establish")
	}
}

func TestNonceIsSingleUseAndSixtySeconds(t *testing.T) {
	s, repo, clk := newSessions(t)
	ctx := context.Background()
	user, device, priv := seedDevice(t, repo)

	nonce, expires, err := s.Challenge(ctx, device)
	if err != nil {
		t.Fatalf("Challenge: %v", err)
	}
	if len(nonce) != 32 {
		t.Fatalf("nonce is %d bytes, want 32", len(nonce))
	}
	if expires != clk.Now().Add(60*time.Second).Unix() {
		t.Fatalf("nonce TTL is not 60s: expires %d, now %d", expires, clk.Now().Unix())
	}
	req := signed(t, s, device, nonce, auth.PurposeSession, priv)
	tok, err := s.Establish(ctx, req)
	if err != nil {
		t.Fatalf("Establish: %v", err)
	}
	if tok.UserID != user {
		t.Fatalf("token bound to %s, want %s", tok.UserID, user)
	}
	if _, err := s.Establish(ctx, req); err == nil {
		t.Fatal("the same nonce was accepted twice")
	}

	nonce, _, _ = s.Challenge(ctx, device)
	clk.Advance(61 * time.Second)
	if _, err := s.Establish(ctx, signed(t, s, device, nonce, auth.PurposeSession, priv)); err == nil {
		t.Fatal("an expired nonce was accepted")
	}
}

func TestAReplayedNonceIsRefusedBeforeTheSignatureIsChecked(t *testing.T) {
	s, repo, _ := newSessions(t)
	ctx := context.Background()
	_, device, priv := seedDevice(t, repo)
	nonce, _, _ := s.Challenge(ctx, device)
	req := signed(t, s, device, nonce, auth.PurposeSession, priv)
	if _, err := s.Establish(ctx, req); err != nil {
		t.Fatalf("Establish: %v", err)
	}
	// A replay with a DELIBERATELY BROKEN signature must still be refused for
	// the nonce, which is what proves the nonce is consumed first: otherwise a
	// replay costs one Ed25519 verification per attempt.
	req.Sig = bytes.Repeat([]byte{0}, 64)
	before := s.VerifyCount()
	if _, err := s.Establish(ctx, req); err == nil {
		t.Fatal("a replayed nonce was accepted")
	}
	if s.VerifyCount() != before {
		t.Fatal("the signature was verified before the nonce was checked")
	}
}

func TestAWrongLengthPublicKeyDoesNotPanic(t *testing.T) {
	// ed25519.Verify PANICS on a key that is not 32 bytes. A device row can only
	// hold 32 by CHECK constraint, but Establish length-checks anyway, because a
	// panic here is a remote denial of service.
	s, repo, _ := newSessions(t)
	ctx := context.Background()
	_, device, priv := seedDevice(t, repo)
	if err := corruptDSKPub(repo, device, 31); err != nil {
		t.Skipf("the schema refuses a 31-byte dsk_pub, which is the stronger guarantee: %v", err)
	}
	nonce, _, _ := s.Challenge(ctx, device)
	req := signed(t, s, device, nonce, auth.PurposeSession, priv)
	if _, err := s.Establish(ctx, req); err == nil {
		t.Fatal("a device with a malformed key established a session")
	}
}

func TestANinthSessionEvictsTheOldest(t *testing.T) {
	s, repo, clk := newSessions(t)
	ctx := context.Background()
	_, device, priv := seedDevice(t, repo)
	for i := 0; i < 9; i++ {
		nonce, _, _ := s.Challenge(ctx, device)
		if _, err := s.Establish(ctx, signed(t, s, device, nonce, auth.PurposeSession, priv)); err != nil {
			t.Fatalf("session %d: %v", i, err)
		}
		clk.Advance(time.Second)
	}
	n, err := repo.CountSessionsByDevice(ctx, device)
	if err != nil {
		t.Fatalf("CountSessionsByDevice: %v", err)
	}
	if n != int64(config.Default().Auth.Session.MaxPerDevice) {
		t.Fatalf("%d live sessions, want %d", n, config.Default().Auth.Session.MaxPerDevice)
	}
}

func TestRevokingADeviceKillsEverySessionAndSocketInOneTransaction(t *testing.T) {
	s, repo, _ := newSessions(t)
	ctx := context.Background()
	_, device, priv := seedDevice(t, repo)
	nonce, _, _ := s.Challenge(ctx, device)
	tok, err := s.Establish(ctx, signed(t, s, device, nonce, auth.PurposeSession, priv))
	if err != nil {
		t.Fatalf("Establish: %v", err)
	}
	closed := make([]id.ID, 0, 1)
	s.OnRevoke = func(d id.ID) { closed = append(closed, d) }
	if err := s.RevokeDevice(ctx, device); err != nil {
		t.Fatalf("RevokeDevice: %v", err)
	}
	if _, err := s.Resolve(ctx, tok.Token); err == nil {
		t.Fatal("a revoked device's token still resolves")
	}
	if len(closed) != 1 || closed[0] != device {
		t.Fatalf("the gateway was not told to close the device's sockets: %v", closed)
	}
}

func TestProvisionalIsRefusedOutsideThePairingSurface(t *testing.T) {
	s, repo, _ := newSessions(t)
	ctx := context.Background()
	_, device, priv := seedDevice(t, repo)
	nonce, _, _ := s.Challenge(ctx, device)
	tok, err := s.Establish(ctx, signed(t, s, device, nonce, auth.PurposeProvisional, priv))
	if err != nil {
		t.Fatalf("Establish provisional: %v", err)
	}
	if tok.Scope != auth.ScopeProvisional {
		t.Fatalf("scope = %d, want provisional", tok.Scope)
	}
	guarded := s.Middleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}), auth.ScopeEnrolled)
	req := httptest.NewRequest(http.MethodGet, "/v1/accounts/me", nil)
	req.Header.Set("Authorization", "Bearer "+tok.Token)
	rec := httptest.NewRecorder()
	guarded.ServeHTTP(rec, req)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("a provisional session reached an enrolled-only route: %d", rec.Code)
	}
	// protocol/02 § Device sessions item 4 names the code, so the instance must
	// emit that code and not a generic E_FORBIDDEN.
	if !bytes.Contains(rec.Body.Bytes(), []byte("E_PROVISIONAL_OUTSIDE_PAIRING")) {
		t.Fatalf("refusal body %x does not carry E_PROVISIONAL_OUTSIDE_PAIRING", rec.Body.Bytes())
	}
}

// protocol/02 § Device sessions item 5: 30 days for native devices, 7 days with
// a 12-hour idle window for browser devices. The window follows the DEVICE
// TIER, never the session scope — a browser device holds an ordinary `enrolled`
// session, so a scope-keyed window would give it 30 days.
func TestTheIdleWindowFollowsTheDeviceTierNotTheScope(t *testing.T) {
	s, repo, clk := newSessions(t)
	ctx := context.Background()
	c := config.Default().Auth.Session

	_, browser, browserPriv := seedDeviceTier(t, repo, 1)
	nonce, _, _ := s.Challenge(ctx, browser)
	tok, err := s.Establish(ctx, signed(t, s, browser, nonce, auth.PurposeSession, browserPriv))
	if err != nil {
		t.Fatalf("Establish browser: %v", err)
	}
	if tok.Scope != auth.ScopeEnrolled {
		t.Fatalf("a browser device got scope %d, want enrolled", tok.Scope)
	}
	if want := clk.Now().Add(c.BrowserIdle.Value()).Unix(); tok.IdleExpires != want {
		t.Fatalf("browser idle_expires = %d, want %d (12h)", tok.IdleExpires, want)
	}
	// One hour later a Resolve must slide the window by browser_idle, not by
	// native_lifetime: the scope is `enrolled` either way.
	clk.Advance(time.Hour)
	sess, err := s.Resolve(ctx, tok.Token)
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	if ceiling := clk.Now().Add(c.BrowserIdle.Value()).Unix(); sess.IdleExpires > ceiling {
		t.Fatalf("Resolve slid a browser session's idle window to %d, past now+browser_idle %d",
			sess.IdleExpires, ceiling)
	}
	if sess.IdleExpires > sess.Expires {
		t.Fatalf("idle_expires %d is past expires %d", sess.IdleExpires, sess.Expires)
	}

	_, native, nativePriv := seedDeviceTier(t, repo, 0)
	nonce, _, _ = s.Challenge(ctx, native)
	nativeTok, err := s.Establish(ctx, signed(t, s, native, nonce, auth.PurposeSession, nativePriv))
	if err != nil {
		t.Fatalf("Establish native: %v", err)
	}
	if want := clk.Now().Add(c.NativeLifetime.Value()).Unix(); nativeTok.IdleExpires != want {
		t.Fatalf("native idle_expires = %d, want %d (now + native_lifetime)", nativeTok.IdleExpires, want)
	}
}

// R29 / D12: the session response carries the instance generation, so a client
// learns about a restore from the same exchange that carries X-Dilla-Generation.
func TestTheTokenCarriesTheInstanceGeneration(t *testing.T) {
	s, repo, _ := newSessions(t)
	ctx := context.Background()
	_, device, priv := seedDevice(t, repo)
	nonce, _, _ := s.Challenge(ctx, device)
	tok, err := s.Establish(ctx, signed(t, s, device, nonce, auth.PurposeSession, priv))
	if err != nil {
		t.Fatalf("Establish: %v", err)
	}
	if tok.Generation != 7 {
		t.Fatalf("Token.Generation = %d, want the 7 NewSessions was given", tok.Generation)
	}
}

// The challenge route is unauthenticated and answers identically for an unknown
// device, so anyone can mint nonces for arbitrary 16-byte ids. The map that
// holds them for 60 seconds must therefore have a ceiling.
func TestThePendingNonceMapIsCapped(t *testing.T) {
	s, repo, _ := newSessions(t)
	ctx := context.Background()
	for i := 0; i < auth.MaxPendingNonces+1000; i++ {
		if _, _, err := s.Challenge(ctx, id.New()); err != nil {
			t.Fatalf("Challenge %d: %v", i, err)
		}
	}
	if n := s.PendingNonces(); n > auth.MaxPendingNonces {
		t.Fatalf("%d pending nonces, want at most %d", n, auth.MaxPendingNonces)
	}
	// A nonce minted after the eviction still establishes.
	_, device, priv := seedDevice(t, repo)
	nonce, _, _ := s.Challenge(ctx, device)
	if _, err := s.Establish(ctx, signed(t, s, device, nonce, auth.PurposeSession, priv)); err != nil {
		t.Fatalf("a nonce minted after eviction did not establish: %v", err)
	}
}

// interfaces.md §5.1: the enrolment assertion "is spent by
// POST /v1/devices/{device_id}/sessions on the pending path". Without this the
// six auth-ceremony routes hand back an assertion no endpoint accepts, and
// ScopePending is never issued by anything.
func TestAPendingSessionRequiresASpentAssertion(t *testing.T) {
	s, repo, _ := newSessions(t)
	ctx := context.Background()
	assertions := newFakeAssertions()
	s.Assertions = assertions
	user, device, priv := seedDevice(t, repo)

	// An unknown assertion is refused outright.
	nonce, _, _ := s.Challenge(ctx, device)
	req := signed(t, s, device, nonce, auth.PurposeSession, priv)
	req.Login = []byte("not-an-assertion")
	if _, err := s.Establish(ctx, req); err == nil {
		t.Fatal("an unknown enrolment assertion was accepted")
	}

	// A valid one yields a pending session.
	token := assertions.issue(user)
	nonce, _, _ = s.Challenge(ctx, device)
	req = signed(t, s, device, nonce, auth.PurposeSession, priv)
	req.Login = []byte(token)
	tok, err := s.Establish(ctx, req)
	if err != nil {
		t.Fatalf("Establish with an assertion: %v", err)
	}
	if tok.Scope != auth.ScopePending {
		t.Fatalf("scope = %d, want pending (1)", tok.Scope)
	}

	// Replay: the assertion was spent, so the same bytes must not work twice.
	nonce, _, _ = s.Challenge(ctx, device)
	req = signed(t, s, device, nonce, auth.PurposeSession, priv)
	req.Login = []byte(token)
	if _, err := s.Establish(ctx, req); err == nil {
		t.Fatal("a replayed enrolment assertion was accepted")
	}

	// An assertion belonging to another user does not reach this device.
	other := assertions.issue(id.New())
	nonce, _, _ = s.Challenge(ctx, device)
	req = signed(t, s, device, nonce, auth.PurposeSession, priv)
	req.Login = []byte(other)
	if _, err := s.Establish(ctx, req); err == nil {
		t.Fatal("an assertion for another user established a session on this device")
	}

	// And with no assertion store wired at all, a login byte string is refused
	// rather than silently ignored.
	s.Assertions = nil
	nonce, _, _ = s.Challenge(ctx, device)
	req = signed(t, s, device, nonce, auth.PurposeSession, priv)
	req.Login = []byte(assertions.issue(user))
	if _, err := s.Establish(ctx, req); err == nil {
		t.Fatal("an assertion was accepted with no assertion store configured")
	}
}

func TestAProvisionalSessionActsOnlyInItsPairingGroup(t *testing.T) {
	pairing, other := id.New(), id.New()
	s := auth.Session{Scope: auth.ScopeProvisional, PairingGroup: &pairing}
	if !s.InPairingGroup(pairing) {
		t.Error("a provisional session must act in its own pairing group")
	}
	if s.InPairingGroup(other) {
		t.Error("a provisional session must not act outside its pairing group")
	}
	if (auth.Session{Scope: auth.ScopeProvisional}).InPairingGroup(pairing) {
		t.Error("a provisional session with no pairing group may act on nothing")
	}
	if !(auth.Session{Scope: auth.ScopeEnrolled}).InPairingGroup(other) {
		t.Error("an enrolled session is unrestricted")
	}
}

func signed(t *testing.T, s *auth.Sessions, device id.ID, nonce []byte, p auth.Purpose, priv ed25519.PrivateKey) auth.EstablishRequest {
	t.Helper()
	pre := auth.SessionPreimage(s.InstanceID(), device, nonce, p)
	return auth.EstablishRequest{DeviceID: device, Nonce: nonce, Purpose: p, Sig: ed25519.Sign(priv, pre)}
}
