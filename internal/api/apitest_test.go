package api_test

import (
	"bytes"
	"context"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/fxamacker/cbor/v2"
	"github.com/pressly/goose/v3"

	"github.com/jonasthim/dilla/internal/api"
	"github.com/jonasthim/dilla/internal/auth"
	"github.com/jonasthim/dilla/internal/blob"
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
	// DS records the delivery-service calls the Communities and Channels
	// handlers communityEnv and channelEnv mount make (task 4). It never stands
	// in for the delivery service's own behaviour, which internal/ds tests.
	DS *recordingDS
	// Blobs is the blob store blobEnv mounts the blob and admin routes over
	// (tasks 10 and 11); nil in every other harness.
	Blobs *blob.Store
	sess  map[string]auth.Session // bearer token -> session
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
		DS:   &recordingDS{},
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
	return e.NewUserWithID(id.New(), username)
}

// NewUserWithID is NewUser for a given user id: the identity an MLS leaf's
// credential already carries, when a test drives a real group.
func (e *env) NewUserWithID(uid id.ID, username string) (id.ID, string) {
	e.t.Helper()
	did := id.New()
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

// DoRaw sends one request with an arbitrary content type and body (a blob's raw
// octets, which are the one exception to the CBOR rule) and returns the status
// and the raw response body.
func (e *env) DoRaw(method, path, token, contentType string, body []byte) (int, []byte) {
	e.t.Helper()
	var headers map[string]string
	if contentType != "" {
		headers = map[string]string{"Content-Type": contentType}
	}
	resp := e.Request(e.t, method, path, token, headers, body)
	defer resp.Body.Close()
	out, err := io.ReadAll(resp.Body)
	if err != nil {
		e.t.Fatalf("ReadAll: %v", err)
	}
	return resp.StatusCode, out
}

// Request sends one request with the given extra headers and body and returns
// the *http.Response, so a test can assert headers; the caller closes the body.
func (e *env) Request(t *testing.T, method, path, token string, headers map[string]string, body []byte) *http.Response {
	t.Helper()
	req, err := http.NewRequestWithContext(t.Context(), method, e.Srv.URL+path, bytes.NewReader(body))
	if err != nil {
		t.Fatalf("NewRequest: %v", err)
	}
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	resp, err := e.Srv.Client().Do(req)
	if err != nil {
		t.Fatalf("Do %s %s: %v", method, path, err)
	}
	return resp
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

// seedTextGroup writes one open mls_groups row of kind text bound to channelID
// in community cid, and returns its id. It is a row, not an MLS group: the
// handlers under test read it through GroupsForTarget and hand its id to the
// delivery service, which the recording double stands behind.
func seedTextGroup(t *testing.T, e *env, channelID, cid id.ID) id.ID {
	t.Helper()
	return seedGroupOfKind(t, e, channelID, cid, 0)
}

// seedGroupOfKind is seedTextGroup for any group kind (1 is a call group).
func seedGroupOfKind(t *testing.T, e *env, target, cid id.ID, kind uint8) id.ID {
	t.Helper()
	c := cid
	g := store.GroupRow{
		GroupID: id.New(), Binding: []byte{0x80}, Kind: kind, CommunityID: &c, TargetID: target,
		Ciphersuite: 1, ExternalSenderKeyID: id.New(), E2EEVersion: 1, MediaVersion: 1,
		PolicyVersion: 1, Created: e.Clk.Now().Unix(),
	}
	if err := e.Repo.CreateGroup(t.Context(), g); err != nil {
		t.Fatalf("CreateGroup: %v", err)
	}
	return g.GroupID
}

// seedMember adds one mls_members row: user at leaf in group, on a fresh device.
func seedMember(t *testing.T, e *env, group, user id.ID, leaf uint32) {
	t.Helper()
	members, err := e.Repo.ListMembers(t.Context(), group)
	if err != nil {
		t.Fatalf("ListMembers: %v", err)
	}
	members = append(members, store.MemberRow{
		GroupID: group, LeafIndex: leaf, UserID: user, DeviceID: id.New(),
		SignatureKey: make([]byte, 32),
	})
	if err := e.Repo.ReplaceMembers(t.Context(), group, 0, members); err != nil {
		t.Fatalf("ReplaceMembers: %v", err)
	}
}

// ownerOf reads the community's owner.
func ownerOf(t *testing.T, e *env, cid id.ID) id.ID {
	t.Helper()
	row, err := e.Repo.GetCommunity(t.Context(), cid)
	if err != nil {
		t.Fatalf("GetCommunity: %v", err)
	}
	return row.Owner
}

// seedDevices gives user n more devices and returns their ids, in creation
// order. They carry no KeyPackage; seedKeyPackage publishes one.
func seedDevices(t *testing.T, e *env, user id.ID, n int) []id.ID {
	t.Helper()
	now := e.Clk.Now().Unix()
	out := make([]id.ID, 0, n)
	for range n {
		did := id.New()
		if err := e.Repo.CreateDevice(t.Context(), newAPITestDevice(did, user, now)); err != nil {
			t.Fatalf("CreateDevice: %v", err)
		}
		out = append(out, did)
	}
	return out
}

// seedKeyPackage publishes one ordinary (not last-resort) KeyPackage row for
// device, valid for a day. It is a row, not a KeyPackage: the code under test
// only counts what is available, and the recording double stands in for the
// delivery service that would take and validate it.
func seedKeyPackage(t *testing.T, e *env, device id.ID) {
	t.Helper()
	now := e.Clk.Now().Unix()
	ref := id.New()
	if err := e.Repo.PutKeyPackages(t.Context(), device, []store.KeyPackageRow{{
		DeviceID: device, KPRef: ref[:], Blob: []byte{1}, Expires: now + 86_400, Created: now,
	}}); err != nil {
		t.Fatalf("PutKeyPackages: %v", err)
	}
}

// userOf is the user a bearer token NewUser minted authenticates as.
func userOf(t *testing.T, e *env, tok string) id.ID {
	t.Helper()
	s, ok := e.sess[tok]
	if !ok {
		t.Fatalf("no session for token %q", tok)
	}
	return s.UserID
}

// codeOf is the E_* code of a *server.Error, or "" for nil or any other error.
func codeOf(err error) string {
	var se *server.Error
	if !errors.As(err, &se) {
		return ""
	}
	return string(se.Code)
}

// repoRoot is the repository root: go test runs in the package directory.
func repoRoot(t *testing.T) string {
	t.Helper()
	root, err := filepath.Abs(filepath.Join("..", ".."))
	if err != nil {
		t.Fatalf("repo root: %v", err)
	}
	return root
}

// attsToAny spells attachments as protocol/04's 8-element arrays, an empty list
// as an empty array (never null).
func attsToAny(atts []api.Attachment) []any {
	out := make([]any, 0, len(atts))
	for _, a := range atts {
		out = append(out, []any{a.BlobID, a.Key, a.Nonce, a.Size, a.Mime, a.W, a.H, a.Thumb})
	}
	return out
}

// prevsToAny spells previews as protocol/04's 4-element arrays.
func prevsToAny(prevs []api.Preview) []any {
	out := make([]any, 0, len(prevs))
	for _, p := range prevs {
		out = append(out, []any{p.URL, p.Title, p.Description, p.Image})
	}
	return out
}

// ptr returns a pointer to a copy of v.
func ptr[T any](v T) *T { return &v }

// stubSFU stands in for internal/sfu.(*Server).Token: the JWT's contents are
// internal/sfu's own test's business, and the epoch gate in front of it is
// this file's.
type stubSFU struct {
	mu    sync.Mutex
	calls [][2]string // (room, identity)
	fail  error
}

func (s *stubSFU) Token(room, identity string) (string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.fail != nil {
		return "", s.fail
	}
	s.calls = append(s.calls, [2]string{room, identity})
	return "jwt-for-" + identity, nil
}

func (s *stubSFU) minted() [][2]string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([][2]string(nil), s.calls...)
}

const (
	testTURNSecret = "0123456789abcdef0123456789abcdef"
	testLiveKitURL = "wss://chat.example.test"
	callGroupEpoch = 7
)

// callEnv is a voice channel with a call group at epoch 7, the owner's token,
// and the calls routes mounted over a stub SFU with TURN on.
func callEnv(t *testing.T) (*env, id.ID, string, id.ID) {
	t.Helper()
	e, ch, tok, group, _ := callEnvWith(t, api.CallsConfig{
		LiveKitURL: testLiveKitURL, TURNSecret: testTURNSecret,
		TURNURLs:      []string{"turns:chat.example.test:443?transport=tcp"},
		CredentialTTL: time.Hour,
	})
	return e, ch, tok, group
}

func callEnvWith(t *testing.T, cfg api.CallsConfig) (*env, id.ID, string, id.ID, *stubSFU) {
	t.Helper()
	e, cid, tok := channelEnv(t)
	ch, _, status := newChannel(t, e, cid, tok, 1 /* voice */, 1, 2, "voice")
	if status != http.StatusCreated {
		t.Fatalf("voice channel = %d", status)
	}
	sfu := &stubSFU{}
	api.NewCalls(e.Repo, api.NewResolver(e.Repo), sfu, cfg, e.Clk, slog.New(slog.DiscardHandler)).Register(e.Mux)
	return e, ch, tok, seedCallGroup(t, e, ch, cid, callGroupEpoch), sfu
}

// seedCallGroup writes one open call group row bound to the channel at the
// given epoch, with the call id the delivery service gives a call group (R9:
// its target, the channel).
func seedCallGroup(t *testing.T, e *env, ch, cid id.ID, epoch uint64) id.ID {
	t.Helper()
	c, call := cid, ch
	g := store.GroupRow{
		GroupID: id.New(), Binding: []byte{0x80}, Kind: api.GroupCall, CommunityID: &c, TargetID: ch,
		CallID: &call, Ciphersuite: 1, Epoch: epoch, ExternalSenderKeyID: id.New(),
		E2EEVersion: 1, MediaVersion: 1, PolicyVersion: 1, Created: e.Clk.Now().Unix(),
	}
	if err := e.Repo.CreateGroup(t.Context(), g); err != nil {
		t.Fatalf("CreateGroup: %v", err)
	}
	return g.GroupID
}

// deviceOf is the device a bearer token NewUser minted authenticates as.
func deviceOf(t *testing.T, e *env, tok string) id.ID {
	t.Helper()
	s, ok := e.sess[tok]
	if !ok {
		t.Fatalf("no session for token %q", tok)
	}
	return s.DeviceID
}

// seedLeaf adds dev as the next leaf of group, added at addedEpoch and removed
// at removedEpoch (nil while it is still a member).
func seedLeaf(t *testing.T, e *env, group, dev id.ID, addedEpoch uint64, removedEpoch *uint64) {
	t.Helper()
	members, err := e.Repo.ListMembers(t.Context(), group)
	if err != nil {
		t.Fatalf("ListMembers: %v", err)
	}
	d, err := e.Repo.GetDevice(t.Context(), dev)
	if err != nil {
		t.Fatalf("GetDevice: %v", err)
	}
	members = append(members, store.MemberRow{
		GroupID: group, LeafIndex: uint32(len(members)), UserID: d.UserID, DeviceID: dev,
		SignatureKey: make([]byte, 32), AddedEpoch: addedEpoch, RemovedEpoch: removedEpoch,
	})
	if err := e.Repo.ReplaceMembers(t.Context(), group, callGroupEpoch, members); err != nil {
		t.Fatalf("ReplaceMembers: %v", err)
	}
}
