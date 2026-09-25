package ds_test

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/jonasthim/dilla/internal/auth"
	"github.com/jonasthim/dilla/internal/cborx"
	"github.com/jonasthim/dilla/internal/clock"
	"github.com/jonasthim/dilla/internal/ds"
	"github.com/jonasthim/dilla/internal/gateway"
	"github.com/jonasthim/dilla/internal/id"
	"github.com/jonasthim/dilla/internal/mlswasi"
	"github.com/jonasthim/dilla/internal/store"
	"github.com/jonasthim/dilla/internal/store/sqlite"
	sqlitemigrations "github.com/jonasthim/dilla/internal/store/sqlite/migrations"
	"github.com/pressly/goose/v3"
	_ "modernc.org/sqlite"
)

// dsHarness is a whole delivery service over a real SQLite file, a real wazero runtime and a real
// gateway, driven by a fake clock. Nothing under test is mocked: the wasm guest, the SQL and the
// fan-out are the things the DS invariants are defined over, and a double for any of them would
// test the double.
//
// Later tasks add the helpers their own tests name; each lists
// `Modify: internal/ds/harness_test.go` in its Files and shows the helper body beside the test
// that first needs it.
type dsHarness struct {
	t    *testing.T
	path string
	ds   *ds.DS
	gw   *gateway.Gateway
	clk  *clock.Fake
	wasm *mlswasi.Runtime
	repo *failingRepo

	channels *fakeChannels
	// auth is the gateway's token resolver. The gateway holds an `Authenticator` interface, not
	// *auth.Sessions (deviation B9), so the delivery service's tests satisfy that seam directly
	// rather than standing a whole account stack up to put one device online.
	auth *fakeAuth

	// calls counts guest exports by name, through mlswasi.Options.OnCall. It is what makes
	// "the state blob is imported lazily, and the tree is never rebuilt" an assertion rather
	// than a claim.
	callsMu sync.Mutex
	calls   map[string]int64

	// sessions, conns and hello belong to task 22's election harness, whose helpers are in
	// election_harness_test.go: the session of every member device the fixture exposed, the live
	// gateway connection of every device a test put online, and the hello frame the last of them
	// was greeted with. They are fields here because `dsHarness` is one type; a test that never
	// elects a committer leaves all three nil.
	sessions map[id.ID]auth.Session
	conns    map[id.ID]*deviceConn
	hello    recordedFrame
}

func newDSHarness(t *testing.T) *dsHarness {
	t.Helper()
	ctx := context.Background()
	// The fake clock starts at the wall clock's current second rather than a fixed epoch. The
	// guest sees this clock (mlswasi.Options.Now) and OpenMLS validates every leaf's KeyPackage
	// lifetime, so a fixed timestamp would put the whole 1,500-leaf fixture outside its validity
	// window and every from_external would fail with LeafNodeValidation(Lifetime(...)). Nothing
	// here depends on the absolute value — a test that needs time to pass calls clk.Advance — so
	// the tests stay deterministic in everything they actually assert.
	clk := clock.NewFake(time.Unix(time.Now().Unix(), 0))

	// A file, not :memory:: restartDS reopens the same database, and an in-memory database
	// vanishes with its first connection.
	path := filepath.Join(t.TempDir(), "dilla.db")
	base := openMigratedSQLite(t, path)
	repo := &failingRepo{Repository: base}

	h := &dsHarness{t: t, path: path, clk: clk, repo: repo, calls: map[string]int64{}}

	wasm, err := mlswasi.New(ctx, loadWasmForDS(t), mlswasi.Options{
		PoolSize: 2,
		CacheDir: sharedWasmCacheDir(t),
		Now:      clk.Now,
		OnCall:   h.countCall,
	})
	if err != nil {
		t.Fatalf("mlswasi.New: %v", err)
	}
	t.Cleanup(func() { _ = wasm.Close(context.Background()) })
	h.wasm = wasm

	h.auth = newFakeAuth()
	h.gw = gateway.New(gateway.Options{
		Clock: clk, Store: gatewayStore{repo}, Generation: 1, Auth: h.auth,
	})
	t.Cleanup(func() { _ = h.gw.Shutdown(context.Background()) })

	h.channels = &fakeChannels{modes: map[id.ID][2]uint8{}}

	d, err := ds.New(ds.Options{
		Store:    repo,
		Wasm:     wasm,
		Gateway:  h.gw,
		Clock:    clk,
		Keys:     testInstanceKeys(t),
		Policy:   ds.DefaultPolicy(),
		Channels: h.channels,
	})
	if err != nil {
		t.Fatalf("ds.New: %v", err)
	}
	t.Cleanup(func() { _ = d.Shutdown(context.Background()) })
	h.ds = d
	return h
}

func openMigratedSQLite(t *testing.T, path string) store.Repository {
	t.Helper()
	write, err := sqlite.OpenWrite(path)
	if err != nil {
		t.Fatalf("sqlite.OpenWrite: %v", err)
	}
	p, err := goose.NewProvider(goose.DialectSQLite3, write, sqlitemigrations.FS)
	if err != nil {
		t.Fatalf("goose provider: %v", err)
	}
	if _, err := p.Up(context.Background()); err != nil {
		t.Fatalf("goose up: %v", err)
	}
	read, err := sqlite.OpenRead(path)
	if err != nil {
		t.Fatalf("sqlite.OpenRead: %v", err)
	}
	repo := sqlite.New(write, read)
	t.Cleanup(func() { _ = repo.Close() })
	return repo
}

// gatewayStore is the real repository plus the one method `store.Cursors` owns. `device_cursors`
// is 00002_mls.sql's table but `Cursors` does not join `store.Repository` until task 23, so the
// method is answered here: a zero cursor, which is what a group nobody has read means.
//
// It answers (zero, nil), NOT store.ErrNotFound. `sendReady` reads one cursor per group of the
// connecting device and returns the first error it gets, so an ErrNotFound here closes every
// connection with 4000 "register" before ready — and `Gateway.Online`, which invariants 5, 6 and
// 7 are all defined over, would then be false for every device forever. The gateway's own harness
// answers the same shape (internal/gateway/harness_test.go:255).
type gatewayStore struct{ store.Repository }

func (gatewayStore) GetCursor(_ context.Context, _, _ id.ID) (store.CursorRow, error) {
	return store.CursorRow{}, nil
}

func (h *dsHarness) countCall(export string) {
	h.callsMu.Lock()
	h.calls[export]++
	h.callsMu.Unlock()
}

// wasmCalls is the number of times the guest export was invoked so far.
func (h *dsHarness) wasmCalls(export string) int64 {
	h.callsMu.Lock()
	defer h.callsMu.Unlock()
	return h.calls[export]
}

// failNextTx makes the named repository call inside the next transaction fail, which is how the
// R12 tests prove that a failed transaction leaves neither SQL nor the cached PublicGroup
// half-written.
func (h *dsHarness) failNextTx(method string) { h.repo.failNext(method) }

// restartDS closes the delivery service and builds a new one over the SAME database and the same
// fake clock, which is what a process restart looks like from SQL's point of view.
func (h *dsHarness) restartDS() {
	h.t.Helper()
	if err := h.ds.Shutdown(context.Background()); err != nil {
		h.t.Fatalf("Shutdown: %v", err)
	}
	d, err := ds.New(ds.Options{
		Store: h.repo, Wasm: h.wasm, Gateway: h.gw, Clock: h.clk,
		Keys: testInstanceKeys(h.t), Policy: ds.DefaultPolicy(), Channels: h.channels,
	})
	if err != nil {
		h.t.Fatalf("ds.New after restart: %v", err)
	}
	h.t.Cleanup(func() { _ = d.Shutdown(context.Background()) })
	h.ds = d
}

// channel declares the visibility and mode the injected Channels source reports for the fixture's
// target, and returns that target. Plan 1 has no `channels` table (NV-B5), so invariant 1's input
// is an injected seam here exactly as it is in production until Plan 2 task 2 replaces it.
func (h *dsHarness) channel(t *testing.T, visibility, mode uint8) id.ID {
	t.Helper()
	target := dsFixture(t).targetID
	h.channels.modes[target] = [2]uint8{visibility, mode}
	return target
}

// registerRequest builds the registration the committed 1,500-leaf fixture supports. The binding
// is encoded HERE, in Go, and `Register` checks it against the one the Rust core put in the group
// context — so a positive case is a cross-language assertion that the two encoders agree byte for
// byte.
func (h *dsHarness) registerRequest(t *testing.T, target id.ID) ds.RegisterRequest {
	t.Helper()
	f := dsFixture(t)
	binding, err := cborx.Marshal(f.binding)
	if err != nil {
		t.Fatalf("encode the binding: %v", err)
	}
	return ds.RegisterRequest{
		GroupID:     f.groupID,
		Binding:     binding,
		GroupInfo:   f.groupInfo,
		RatchetTree: f.ratchetTree,
		Session:     auth.Session{Scope: auth.ScopeEnrolled},
	}
}

// mustRegister registers the fixture group on a private end-to-end-encrypted channel and returns
// the result together with a session for the creating device, which every group-scoped read needs:
// `Info` and `Tree` are member-only and answer E_NOT_FOUND to a non-member.
func (h *dsHarness) mustRegister(t *testing.T) (ds.RegisterResult, auth.Session) {
	t.Helper()
	got, err := h.ds.Register(context.Background(), h.registerRequest(t, h.channel(t, 0, 0)))
	if err != nil {
		t.Fatalf("Register: %v", err)
	}
	return got, h.memberSession(t, got.GroupID, 0)
}

// memberSession is a session for the device at the given leaf of a registered group, read back
// out of `mls_members` — so the identity in the test is the one the guest's own credential
// carried, not one the test invented.
func (h *dsHarness) memberSession(t *testing.T, groupID id.ID, leaf uint32) auth.Session {
	t.Helper()
	members, err := h.repo.ListMembers(context.Background(), groupID)
	if err != nil {
		t.Fatalf("ListMembers: %v", err)
	}
	for _, m := range members {
		if m.LeafIndex == leaf {
			return auth.Session{UserID: m.UserID, DeviceID: m.DeviceID, Scope: auth.ScopeEnrolled}
		}
	}
	t.Fatalf("no member at leaf %d of %s", leaf, groupID)
	return auth.Session{}
}

// fakeChannels is the Plan-1 stand-in for `store.Structure`: the `channels` table arrives with
// Plan 2 task 2 (NV-B5), so invariant 1's input is injected. It is not a mock of the delivery
// service — it is the other side of a seam the production build also injects.
type fakeChannels struct {
	modes map[id.ID][2]uint8
}

func (f *fakeChannels) Channel(_ context.Context, targetID id.ID) (visibility, mode uint8, err error) {
	v, ok := f.modes[targetID]
	if !ok {
		return 0, 0, ds.ErrNoChannel
	}
	return v[0], v[1], nil
}

// failingRepo wraps a real repository and can be told to fail one named call inside the next
// transaction. It is a fault injector, not a mock: every call it does not fail goes to the real
// store.
type failingRepo struct {
	store.Repository

	mu     sync.Mutex
	failOn string
}

var errInjected = errors.New("injected failure")

func (r *failingRepo) failNext(method string) {
	r.mu.Lock()
	r.failOn = method
	r.mu.Unlock()
}

func (r *failingRepo) take(method string) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.failOn != method {
		return false
	}
	r.failOn = ""
	return true
}

func (r *failingRepo) Tx(ctx context.Context, fn func(store.Repository) error) error {
	return r.Repository.Tx(ctx, func(tx store.Repository) error {
		sub := &failingRepo{Repository: tx, failOn: r.snapshotFailOn()}
		err := fn(sub)
		// The sub-repository owns the injection for the duration of the transaction; whatever it
		// did not consume goes back, so failNextTx("X") before a call that never reaches X does
		// not silently disarm.
		r.failNext(sub.snapshotFailOn())
		return err
	})
}

func (r *failingRepo) snapshotFailOn() string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.failOn
}

func (r *failingRepo) CreateGroup(ctx context.Context, row store.GroupRow) error {
	if r.take("CreateGroup") {
		return errInjected
	}
	return r.Repository.CreateGroup(ctx, row)
}

func (r *failingRepo) PutGroupState(ctx context.Context, groupID id.ID, epoch uint64, state, groupInfo, treeHash []byte) error {
	if r.take("PutGroupState") {
		return errInjected
	}
	return r.Repository.PutGroupState(ctx, groupID, epoch, state, groupInfo, treeHash)
}

func (r *failingRepo) ReplaceMembers(ctx context.Context, groupID id.ID, epoch uint64, m []store.MemberRow) error {
	if r.take("ReplaceMembers") {
		return errInjected
	}
	return r.Repository.ReplaceMembers(ctx, groupID, epoch, m)
}

func (r *failingRepo) AppendHandshake(ctx context.Context, row store.HandshakeRow) error {
	if r.take("AppendHandshake") {
		return errInjected
	}
	return r.Repository.AppendHandshake(ctx, row)
}

// ---------------------------------------------------------------- the fixture

// dsFixtureData is the committed 1,500-leaf public group of testkit/fixtures/ds-1500, plus the
// `dilla_binding` its generator put in the group context (testkit/src/fixtures.rs:96-104).
type dsFixtureData struct {
	groupID     id.ID
	targetID    id.ID
	groupInfo   []byte
	ratchetTree []byte
	binding     ds.Binding
}

var (
	fixtureOnce sync.Once
	fixtureVal  dsFixtureData
	fixtureErr  error
)

const dsFixtureDir = "../../testkit/fixtures/ds-1500"

// dsFixture reads the committed fixture once per `go test` run and refuses to run once its
// KeyPackage lifetimes have expired: PublicGroup::from_external validates every leaf's lifetime
// and would otherwise fail with an opaque MLS error.
func dsFixture(tb testing.TB) dsFixtureData {
	tb.Helper()
	fixtureOnce.Do(func() { fixtureVal, fixtureErr = loadDSFixture() })
	if fixtureErr != nil {
		tb.Fatalf("testkit/fixtures/ds-1500: %v; regenerate it with\n"+
			"  cargo run -p dilla-testkit --bin dilla-testkit -- gen-public-group --leaves 1500 "+
			"--out testkit/fixtures/ds-1500/", fixtureErr)
	}
	return fixtureVal
}

func loadDSFixture() (dsFixtureData, error) {
	raw, err := os.ReadFile(filepath.Join(dsFixtureDir, "manifest.json"))
	if err != nil {
		return dsFixtureData{}, err
	}
	var m struct {
		GroupIDHex string `json:"group_id_hex"`
		NotAfter   uint64 `json:"not_after"`
	}
	if err := json.Unmarshal(raw, &m); err != nil {
		return dsFixtureData{}, err
	}
	if m.NotAfter == 0 {
		return dsFixtureData{}, errors.New("manifest.json carries no not_after")
	}
	if now := uint64(time.Now().Unix()); now >= m.NotAfter {
		return dsFixtureData{}, errors.New("the fixture's KeyPackage lifetimes have expired")
	}
	groupID, err := id.Parse(m.GroupIDHex)
	if err != nil {
		return dsFixtureData{}, err
	}
	var out dsFixtureData
	out.groupID = groupID
	// The generator binds the group to its own target, and the group id IS that target
	// (testkit/src/fixtures.rs:106).
	out.targetID = groupID
	if out.groupInfo, err = os.ReadFile(filepath.Join(dsFixtureDir, "group_info.mls")); err != nil {
		return dsFixtureData{}, err
	}
	if out.ratchetTree, err = os.ReadFile(filepath.Join(dsFixtureDir, "ratchet_tree.mls")); err != nil {
		return dsFixtureData{}, err
	}
	// testkit/src/fixtures.rs:96-104, verbatim.
	var instance id.ID
	for i := range instance {
		instance[i] = 0x11
	}
	out.binding = ds.Binding{
		V: 1, InstanceID: instance, CommunityID: nil, TargetID: groupID,
		Kind: 0, PolicyVersion: 1, E2EEVersion: 1, MediaVersion: 0,
	}
	return out, nil
}

// loadWasmForDS reads the same artifact internal/mlswasi's tests use. An absent module is a hard
// failure, not a skip: CI downloads it from the rust-wasi job, so its absence means the
// cross-target leg did not run.
func loadWasmForDS(tb testing.TB) []byte {
	tb.Helper()
	raw, err := os.ReadFile(filepath.Join("..", "mlswasi", "testdata", "dilla_core_wasi.wasm"))
	if err != nil {
		tb.Fatalf("the wasi module is absent (%v); build it with "+
			"`cargo build -p dilla-core-wasi --target wasm32-wasip1 --release --locked` and copy "+
			"it to internal/mlswasi/testdata/", err)
	}
	return raw
}

var (
	dsCacheOnce sync.Once
	dsCacheDir  string
)

// sharedWasmCacheDir compiles the large OpenMLS module once per `go test` run rather than once per
// harness: gap-31 §5 records wazero's compile time on it as unmeasured, so it is not a cost to pay
// twenty-five times.
func sharedWasmCacheDir(tb testing.TB) string {
	tb.Helper()
	dsCacheOnce.Do(func() { dsCacheDir, _ = os.MkdirTemp("", "ds-wasm-cache-") })
	return dsCacheDir
}

// TestMain drops the shared compilation cache once the package's tests are done.
func TestMain(m *testing.M) {
	code := m.Run()
	if dsCacheDir != "" {
		_ = os.RemoveAll(dsCacheDir)
	}
	os.Exit(code)
}

// testInstanceKeys is one deterministic set of instance keys for the whole package. InstanceID is
// the fixture generator's own instance (0x11 sixteen times, testkit/src/fixtures.rs:98).
func testInstanceKeys(tb testing.TB) ds.InstanceKeys {
	tb.Helper()
	var k ds.InstanceKeys
	for i := range k.InstanceID {
		k.InstanceID[i] = 0x11
	}
	for i := range k.ExternalSenderKeyID {
		k.ExternalSenderKeyID[i] = 0x22
	}
	for i := range k.FrankingKeyID {
		k.FrankingKeyID[i] = 0x33
	}
	// The instance's external-sender signing key is the fixture's own, re-derived rather than
	// invented: `queue_proposal` resolves an external proposal's sender through the group's
	// `external_senders` extension and verifies the signature against it, so a key of the test's
	// invention would make every ProposeAdd and ProposeRemove fail at the guest and leave the
	// whole issuing path of task 21 unexercised. See fixtureExternalSenderKey in proposal_test.go.
	k.ExternalSenderPriv = fixtureExternalSenderKey()
	for i := range k.FrankingKey {
		k.FrankingKey[i] = byte(0x80 + i)
	}
	return k
}
