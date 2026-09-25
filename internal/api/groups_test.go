package api_test

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/jonasthim/dilla/internal/api"
	"github.com/jonasthim/dilla/internal/auth"
	"github.com/jonasthim/dilla/internal/cborx"
	"github.com/jonasthim/dilla/internal/clock"
	"github.com/jonasthim/dilla/internal/ds"
	"github.com/jonasthim/dilla/internal/gateway"
	"github.com/jonasthim/dilla/internal/id"
	"github.com/jonasthim/dilla/internal/mlswasi"
	"github.com/jonasthim/dilla/internal/server"
	"github.com/jonasthim/dilla/internal/store"
)

// The three routes of endpoints 1-3, end to end over a real mux, a real session, a real delivery
// service and the real wasm core. Nothing between the request and the guest is a double.
func TestCreateGroupAnswersTwoZeroOneWithTheGroupIdAndNextSeq(t *testing.T) {
	h := newGroupsAPI(t)
	res := h.do(t, http.MethodPost, "/v1/groups", h.session, h.createBody(t))
	if res.Code != http.StatusCreated {
		t.Fatalf("status = %d, want 201: %s", res.Code, res.Body.String())
	}
	var out struct {
		_       struct{} `cbor:",toarray"`
		GroupID id.ID
		NextSeq uint64
	}
	if err := cborx.Unmarshal(res.Body.Bytes(), &out); err != nil {
		t.Fatalf("response: %v", err)
	}
	if out.GroupID != h.groupID {
		t.Errorf("group_id = %s, want %s", out.GroupID, h.groupID)
	}
	if out.NextSeq != 1 {
		t.Errorf("next_seq = %d, want 1", out.NextSeq)
	}
}

// A second registration of the same id is 409 E_GROUP_EXISTS, and the body is protocol/02's CBOR
// error array, not JSON.
func TestASecondCreateOfTheSameGroupIsFourZeroNine(t *testing.T) {
	h := newGroupsAPI(t)
	if res := h.do(t, http.MethodPost, "/v1/groups", h.session, h.createBody(t)); res.Code != http.StatusCreated {
		t.Fatalf("first create: %d %s", res.Code, res.Body.String())
	}
	res := h.do(t, http.MethodPost, "/v1/groups", h.session, h.createBody(t))
	if res.Code != http.StatusConflict {
		t.Fatalf("status = %d, want 409", res.Code)
	}
	if got := errorCode(t, res); got != string(server.CodeGroupExists) {
		t.Fatalf("code = %s, want %s", got, server.CodeGroupExists)
	}
}

// Both reads are member-only, and a non-member gets 404 rather than 403: a 403 would tell any
// authenticated device which group ids exist.
func TestInfoAndTreeAnswerFourZeroFourToANonMember(t *testing.T) {
	h := newGroupsAPI(t)
	h.mustCreate(t)
	for _, path := range []string{
		"/v1/groups/" + h.groupID.String() + "/info",
		"/v1/groups/" + h.groupID.String() + "/tree",
	} {
		res := h.do(t, http.MethodGet, path, h.session, nil) // the creating session is NOT a leaf
		if res.Code != http.StatusNotFound {
			t.Errorf("%s: status = %d, want 404", path, res.Code)
		}
		if got := errorCode(t, res); got != string(server.CodeNotFound) {
			t.Errorf("%s: code = %s, want %s", path, got, server.CodeNotFound)
		}
	}
}

// And a member gets the group's own epoch, GroupInfo and tree hash.
func TestInfoAndTreeServeTheInstancesOwnState(t *testing.T) {
	h := newGroupsAPI(t)
	h.mustCreate(t)
	member := h.memberToken(t)

	res := h.do(t, http.MethodGet, "/v1/groups/"+h.groupID.String()+"/info", member, nil)
	if res.Code != http.StatusOK {
		t.Fatalf("info: status = %d: %s", res.Code, res.Body.String())
	}
	var info struct {
		_         struct{} `cbor:",toarray"`
		Epoch     uint64
		GroupInfo []byte
		TreeHash  []byte
		NextSeq   uint64
	}
	if err := cborx.Unmarshal(res.Body.Bytes(), &info); err != nil {
		t.Fatalf("info: %v", err)
	}
	if !bytes.Equal(info.GroupInfo, h.fixture.groupInfo) {
		t.Error("info served a GroupInfo the creator did not upload")
	}

	res = h.do(t, http.MethodGet, "/v1/groups/"+h.groupID.String()+"/tree", member, nil)
	if res.Code != http.StatusOK {
		t.Fatalf("tree: status = %d: %s", res.Code, res.Body.String())
	}
	var tree struct {
		_           struct{} `cbor:",toarray"`
		Epoch       uint64
		RatchetTree []byte
		TreeHash    []byte
	}
	if err := cborx.Unmarshal(res.Body.Bytes(), &tree); err != nil {
		t.Fatalf("tree: %v", err)
	}
	if len(tree.RatchetTree) == 0 {
		t.Fatal("tree served no ratchet tree")
	}
	if !bytes.Equal(tree.TreeHash, info.TreeHash) {
		t.Error("the tree hash of GET /tree and GET /info disagree; one of them is not the " +
			"instance's own PublicGroup")
	}
	if tree.Epoch != info.Epoch {
		t.Errorf("tree epoch %d, info epoch %d", tree.Epoch, info.Epoch)
	}
}

// An unauthenticated request never reaches the delivery service.
func TestEveryDeliveryServiceRouteRequiresADeviceSession(t *testing.T) {
	h := newGroupsAPI(t)
	h.mustCreate(t)
	for _, c := range []struct{ method, path string }{
		{http.MethodPost, "/v1/groups"},
		{http.MethodGet, "/v1/groups/" + h.groupID.String() + "/info"},
		{http.MethodGet, "/v1/groups/" + h.groupID.String() + "/tree"},
		{http.MethodGet, "/v1/groups/" + h.groupID.String() + "/handshakes"},
		{http.MethodPost, "/v1/groups/" + h.groupID.String() + "/commit"},
		{http.MethodPost, "/v1/groups/" + h.groupID.String() + "/proposal"},
		{http.MethodGet, "/v1/groups/" + h.groupID.String() + "/proposals"},
	} {
		res := h.do(t, c.method, c.path, "", nil)
		if res.Code != http.StatusUnauthorized {
			t.Errorf("%s %s: status = %d, want 401", c.method, c.path, res.Code)
		}
	}
}

// A malformed group id in the path is E_INVALID_REQUEST and never reaches the database (R33).
func TestAMalformedGroupIdIsRefusedBeforeTheDeliveryService(t *testing.T) {
	h := newGroupsAPI(t)
	res := h.do(t, http.MethodGet, "/v1/groups/not-hex/info", h.session, nil)
	if res.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", res.Code)
	}
	if got := errorCode(t, res); got != string(server.CodeInvalidRequest) {
		t.Fatalf("code = %s, want %s", got, server.CodeInvalidRequest)
	}
}

// Endpoint 4 over the wire: the catch-up stream is a CBOR array of
// [seq, epoch, kind, sender_leaf|null, blob] rows over the group's ONE seq space, and a cursor
// below the retention floor is 410 E_PRUNED — the answer that tells a client to resync instead of
// retrying. Both shapes are what a client decodes, so both are asserted here rather than only at
// the delivery service's own boundary.
func TestTheHandshakeStreamIsServedAsRowsAndPrunesBelowItsFloor(t *testing.T) {
	h := newGroupsAPI(t)
	h.mustCreate(t)
	member := h.memberToken(t)
	ctx := context.Background()

	// Seqs 10 and 20, with the space between them belonging to application messages: one cursor
	// numbers both streams, so the handshake run a client sees is sparse.
	leaf := uint32(0)
	now := h.deps.Clock.Now().Unix()
	for _, row := range []store.HandshakeRow{
		{GroupID: h.groupID, Seq: 10, Epoch: 6, Kind: 1, SenderLeaf: &leaf, Blob: []byte("commit"), Created: now},
		{GroupID: h.groupID, Seq: 20, Epoch: 7, Kind: 0, Blob: []byte("proposal"), Created: now},
	} {
		if err := h.deps.Repo.AppendHandshake(ctx, row); err != nil {
			t.Fatalf("AppendHandshake: %v", err)
		}
	}

	res := h.do(t, http.MethodGet,
		"/v1/groups/"+h.groupID.String()+"/handshakes?from=9&limit=100", member, nil)
	if res.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200: %s", res.Code, res.Body.String())
	}
	var rows []struct {
		_      struct{} `cbor:",toarray"`
		Seq    uint64
		Epoch  uint64
		Kind   uint8
		Sender *uint32
		Blob   []byte
	}
	if err := cborx.Unmarshal(res.Body.Bytes(), &rows); err != nil {
		t.Fatalf("decode the handshake array: %v", err)
	}
	if len(rows) != 2 {
		t.Fatalf("got %d rows, want the two at seq 10 and 20", len(rows))
	}
	if rows[0].Seq != 10 || rows[0].Epoch != 6 || rows[0].Kind != 1 {
		t.Errorf("row 0 = [%d %d %d], want [10 6 1]", rows[0].Seq, rows[0].Epoch, rows[0].Kind)
	}
	if rows[0].Sender == nil || *rows[0].Sender != 0 {
		t.Errorf("row 0 sender = %v, want leaf 0", rows[0].Sender)
	}
	if !bytes.Equal(rows[0].Blob, []byte("commit")) {
		t.Errorf("row 0 blob = %q", rows[0].Blob)
	}
	if rows[1].Seq != 20 || rows[1].Sender != nil {
		t.Errorf("row 1 = seq %d sender %v, want seq 20 and a null sender", rows[1].Seq, rows[1].Sender)
	}

	// A cursor two or more below the oldest surviving handshake of a group the sweep can already
	// have reached has a hole the instance cannot fill: 410, not 200 with a short answer. The
	// group must be older than HandshakeRetention for that to be true — below the window the same
	// gap is the message stream's, which internal/ds pins.
	h.clk.Advance(31 * 24 * time.Hour)
	res = h.do(t, http.MethodGet,
		"/v1/groups/"+h.groupID.String()+"/handshakes?from=0", member, nil)
	if res.Code != http.StatusGone {
		t.Fatalf("status = %d, want 410: %s", res.Code, res.Body.String())
	}
	if got := errorCode(t, res); got != string(server.CodePruned) {
		t.Fatalf("code = %s, want %s", got, server.CodePruned)
	}
}

// Endpoint 5's refusal for invariant 3, over the wire. E_COMMIT_CONFLICT is one of the four codes
// that carry extra elements, so the body is the FIVE-element array
// [code, detail, retry_after_ms, winning_commit, proposals] — the loser processes the winner and
// re-commits over the outstanding refs, and a body that stops at three leaves it nothing to act
// on.
func TestACommitForADecidedEpochIsFourZeroNineCarryingTheWinnerAndTheProposals(t *testing.T) {
	h := newGroupsAPI(t)
	h.mustCreate(t)
	member := h.memberToken(t)
	ctx := context.Background()

	// The group sits at the fixture's epoch 6; the handshake that carried it there is the winner.
	winner := apiFixtureFile(t, "commits/09.mls")
	if err := h.deps.Repo.AppendHandshake(ctx, store.HandshakeRow{
		GroupID: h.groupID, Seq: 1, Epoch: 6, Kind: 1, Blob: winner,
		Created: h.deps.Clock.Now().Unix(),
	}); err != nil {
		t.Fatalf("AppendHandshake: %v", err)
	}
	ref := id.New()
	if err := h.deps.Repo.PutProposal(ctx, store.ProposalRow{
		GroupID: h.groupID, Ref: ref[:], Epoch: 6, Kind: 3, Origin: 0, ActionID: id.New(),
		IssuedAt: h.deps.Clock.Now().Unix(), TTL: 86400,
	}); err != nil {
		t.Fatalf("PutProposal: %v", err)
	}

	body := mustCBOR(t, []any{uint64(5), winner, h.fixture.groupInfo, []any{}, nil})
	res := h.do(t, http.MethodPost, "/v1/groups/"+h.groupID.String()+"/commit", member, body)
	if res.Code != http.StatusConflict {
		t.Fatalf("status = %d, want 409: %s", res.Code, res.Body.String())
	}
	var out []any
	if err := cborx.Unmarshal(res.Body.Bytes(), &out); err != nil {
		t.Fatalf("decode the error body: %v", err)
	}
	if len(out) != 5 {
		t.Fatalf("the conflict body has %d elements, want 5: "+
			"[code, detail, retry_after_ms, winning_commit, proposals]", len(out))
	}
	if out[0] != string(server.CodeCommitConflict) {
		t.Fatalf("code = %v, want %s", out[0], server.CodeCommitConflict)
	}
	if out[2] != nil {
		t.Errorf("retry_after_ms = %v, want null: a conflict is not retried after a delay", out[2])
	}
	got, ok := out[3].([]byte)
	if !ok {
		t.Fatalf("winning_commit is %T, want a bstr", out[3])
	}
	if !bytes.Equal(got, winner) {
		t.Errorf("winning_commit is %d bytes, want the %d-byte winner", len(got), len(winner))
	}
	refs, ok := out[4].([]any)
	if !ok || len(refs) != 1 {
		t.Fatalf("proposals = %v, want the one outstanding ref", out[4])
	}
	if first, ok := refs[0].([]byte); !ok || !bytes.Equal(first, ref[:]) {
		t.Errorf("proposals[0] = %x, want %x", refs[0], ref[:])
	}
}

// ------------------------------------------------------------------ harness

type groupsAPI struct {
	mux     *server.Mux
	deps    api.Deps
	ds      *ds.DS // the same delivery service the mounted routes hold
	groupID id.ID
	fixture apiFixture
	session string // an enrolled session that is NOT one of the group's leaves
	// clk is the DELIVERY SERVICE's clock, which is not deps.Clock: the guest validates the
	// fixture's KeyPackage lifetimes against it, and a test that needs a group old enough to have
	// been swept advances this one and leaves the session clock alone.
	clk *clock.Fake
}

// newGroupsAPI mounts the delivery-service routes on the same mux, repository and sessions the
// rest of internal/api's tests use, over a real delivery service and the real wasm core.
func newGroupsAPI(t *testing.T) *groupsAPI {
	t.Helper()
	handler, deps := newTestAPI(t)
	mux, ok := handler.(*server.Mux)
	if !ok {
		t.Fatalf("newTestAPI returned %T, want *server.Mux", handler)
	}
	f := apiFixtureData(t)

	// The guest validates every leaf's KeyPackage lifetime against the clock it is given, so the
	// harness clock must sit inside the committed fixture's validity window.
	clk := clock.NewFake(time.Unix(time.Now().Unix(), 0))
	ctx := context.Background()
	wasm, err := mlswasi.New(ctx, f.wasm, mlswasi.Options{
		PoolSize: 2, CacheDir: apiWasmCacheDir(t), Now: clk.Now,
	})
	if err != nil {
		t.Fatalf("mlswasi.New: %v", err)
	}
	t.Cleanup(func() { _ = wasm.Close(context.Background()) })

	gw := gateway.New(gateway.Options{Clock: clk, Store: apiGatewayStore{deps.Repo}, Generation: 1})
	t.Cleanup(func() { _ = gw.Shutdown(context.Background()) })

	d, err := ds.New(ds.Options{
		Store: deps.Repo, Wasm: wasm, Gateway: gw, Clock: clk,
		Policy: ds.DefaultPolicy(),
	})
	if err != nil {
		t.Fatalf("ds.New: %v", err)
	}
	t.Cleanup(func() { _ = d.Shutdown(context.Background()) })

	groups := &api.Groups{DS: d, MaxBody: 1 << 21}
	groups.Register(mux, deps.Sessions)
	groups.RegisterSequencer(mux, deps.Sessions)
	// Task 25's two recovery routes, endpoints 8 and 9.
	groups.RegisterRecovery(mux, deps.Sessions)

	// Endpoints 7, 12, 17 and 18 ride on the same mux, sessions and delivery service; the caps are
	// left at their zero values on purpose in one test of messages_test.go, so they are set here.
	msgs := &api.Messages{DS: d, MaxCiphertextBytes: 131072, MaxBody: 1 << 16}
	msgs.Register(mux, deps.Sessions)

	// Task 24's four directory routes ride on the same mux, sessions and delivery service. They are
	// mounted from the same `*api.Groups` value, so the body cap set above is theirs too — a
	// KeyPackage refill and a Welcome list are both far over §5.3's 64 KiB.
	groups.RegisterDirectory(mux, deps.Sessions)
	// Task 27's two heal routes, endpoints 13 and 14.
	groups.RegisterHeal(mux, deps.Sessions)

	_, _, token := seedAPISession(t, deps)
	return &groupsAPI{
		mux: mux, deps: deps, ds: d, groupID: f.groupID, fixture: f, session: token, clk: clk,
	}
}

func (h *groupsAPI) createBody(t *testing.T) []byte {
	t.Helper()
	return mustCBOR(t, []any{h.groupID, h.fixture.binding, h.fixture.groupInfo, h.fixture.ratchetTree})
}

func (h *groupsAPI) mustCreate(t *testing.T) {
	t.Helper()
	if res := h.do(t, http.MethodPost, "/v1/groups", h.session, h.createBody(t)); res.Code != http.StatusCreated {
		t.Fatalf("create: %d %s", res.Code, res.Body.String())
	}
}

// memberToken seeds the account and device of the group's leaf 0 — the identity the fixture's own
// credential carries — and establishes a real session for it through the ordinary
// challenge-and-signature path.
func (h *groupsAPI) memberToken(t *testing.T) string {
	t.Helper()
	ctx := context.Background()
	members, err := h.deps.Repo.ListMembers(ctx, h.groupID)
	if err != nil {
		t.Fatalf("ListMembers: %v", err)
	}
	if len(members) == 0 {
		t.Fatal("the registered group has no member rows")
	}
	m := members[0]
	now := h.deps.Clock.Now().Unix()
	if err := h.deps.Repo.CreateUser(ctx, store.UserRow{
		ID: m.UserID, Username: "leaf" + m.UserID.String()[:8], Display: "Leaf",
		UMKPub: make([]byte, 32), SSKPub: make([]byte, 32), SigUMKSSK: make([]byte, 64),
		Created: now,
	}); err != nil {
		t.Fatalf("CreateUser: %v", err)
	}
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("GenerateKey: %v", err)
	}
	verified := now
	if err := h.deps.Repo.CreateDevice(ctx, store.DeviceRow{
		ID: m.DeviceID, UserID: m.UserID, DSKPub: pub, CredentialBlob: []byte{1},
		VerifiedAt: &verified, LastSeen: now, Created: now,
	}); err != nil {
		t.Fatalf("CreateDevice: %v", err)
	}
	nonce, _, err := h.deps.Sessions.Challenge(ctx, m.DeviceID)
	if err != nil {
		t.Fatalf("Challenge: %v", err)
	}
	pre := auth.SessionPreimage(h.deps.Sessions.InstanceID(), m.DeviceID, nonce, auth.PurposeSession)
	tok, err := h.deps.Sessions.Establish(ctx, auth.EstablishRequest{
		DeviceID: m.DeviceID, Nonce: nonce, Purpose: auth.PurposeSession,
		Sig: ed25519.Sign(priv, pre),
	})
	if err != nil {
		t.Fatalf("Establish: %v", err)
	}
	return tok.Token
}

func (h *groupsAPI) do(t *testing.T, method, path, token string, body []byte) *httptest.ResponseRecorder {
	t.Helper()
	var req *http.Request
	if body == nil {
		req = httptest.NewRequest(method, path, nil)
	} else {
		req = httptest.NewRequest(method, path, bytes.NewReader(body))
		req.Header.Set("Content-Type", "application/cbor")
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	rec := httptest.NewRecorder()
	h.mux.ServeHTTP(rec, req)
	return rec
}

// apiGatewayStore is the repository plus the one method `store.Cursors` owns: `Cursors` does not
// join `store.Repository` until task 23.
type apiGatewayStore struct{ store.Repository }

func (apiGatewayStore) GetCursor(_ context.Context, _, _ id.ID) (store.CursorRow, error) {
	return store.CursorRow{}, store.ErrNotFound
}

func mustCBOR(t *testing.T, v any) []byte {
	t.Helper()
	b, err := cborx.Marshal(v)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	return b
}

// errorCode is oidc_test.go's helper: element 0 of protocol/02's error array.

// ------------------------------------------------------------------ fixture

type apiFixture struct {
	groupID     id.ID
	binding     []byte
	groupInfo   []byte
	ratchetTree []byte
	wasm        []byte
}

var (
	apiFixtureOnce sync.Once
	apiFixtureVal  apiFixture
	apiFixtureErr  error

	apiCacheOnce sync.Once
	apiCacheDir  string
)

const apiFixtureDir = "../../testkit/fixtures/ds-1500"

// apiFixtureData reads the committed 1,500-leaf public group and the wasi module once per
// `go test` run. An absent module is a hard failure, not a skip: CI downloads it from the
// rust-wasi job, so its absence means the cross-target leg did not run.
func apiFixtureData(t *testing.T) apiFixture {
	t.Helper()
	apiFixtureOnce.Do(func() { apiFixtureVal, apiFixtureErr = loadAPIFixture() })
	if apiFixtureErr != nil {
		t.Fatalf("%v\nregenerate the fixture with\n"+
			"  cargo run -p dilla-testkit --bin dilla-testkit -- gen-public-group --leaves 1500 "+
			"--out testkit/fixtures/ds-1500/\nand build the module with\n"+
			"  cargo build -p dilla-core-wasi --target wasm32-wasip1 --release --locked",
			apiFixtureErr)
	}
	return apiFixtureVal
}

func loadAPIFixture() (apiFixture, error) {
	raw, err := os.ReadFile(filepath.Join(apiFixtureDir, "manifest.json"))
	if err != nil {
		return apiFixture{}, err
	}
	var m struct {
		GroupIDHex string `json:"group_id_hex"`
	}
	if err := json.Unmarshal(raw, &m); err != nil {
		return apiFixture{}, err
	}
	var out apiFixture
	if out.groupID, err = id.Parse(m.GroupIDHex); err != nil {
		return apiFixture{}, err
	}
	if out.groupInfo, err = os.ReadFile(filepath.Join(apiFixtureDir, "group_info.mls")); err != nil {
		return apiFixture{}, err
	}
	if out.ratchetTree, err = os.ReadFile(filepath.Join(apiFixtureDir, "ratchet_tree.mls")); err != nil {
		return apiFixture{}, err
	}
	if out.wasm, err = os.ReadFile(filepath.Join("..", "mlswasi", "testdata", "dilla_core_wasi.wasm")); err != nil {
		return apiFixture{}, err
	}
	// testkit/src/fixtures.rs:96-104, verbatim. The binding is encoded here, in Go, and the
	// delivery service checks it against the one the Rust core put in the group context — so a
	// successful create is a cross-language assertion that the two encoders agree byte for byte.
	var instance id.ID
	for i := range instance {
		instance[i] = 0x11
	}
	out.binding, err = cborx.Marshal(ds.Binding{
		V: 1, InstanceID: instance, CommunityID: nil, TargetID: out.groupID,
		Kind: 0, PolicyVersion: 1, E2EEVersion: 1, MediaVersion: 0,
	})
	if err != nil {
		return apiFixture{}, err
	}
	return out, nil
}

// apiFixtureFile reads one file of the committed 1,500-leaf fixture.
func apiFixtureFile(t *testing.T, rel string) []byte {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join(apiFixtureDir, rel))
	if err != nil {
		t.Fatalf("read %s: %v", rel, err)
	}
	return raw
}

// apiWasmCacheDir compiles the large OpenMLS module once per `go test` run rather than once per
// harness.
func apiWasmCacheDir(t *testing.T) string {
	t.Helper()
	apiCacheOnce.Do(func() {
		apiCacheDir, _ = os.MkdirTemp("", "api-wasm-cache-")
		t.Cleanup(func() { _ = os.RemoveAll(apiCacheDir) })
	})
	return apiCacheDir
}

// ------------------------------------------ endpoints 8 and 9: resync and fork-report (task 25)

// Endpoint 9: `[epoch, seq, reason]` -> 202 with an empty CBOR array body.
func TestForkReportIsAcceptedWithAnEmptyArrayBody(t *testing.T) {
	h := newGroupsAPI(t)
	h.mustCreate(t)
	token := h.memberToken(t)
	seq := h.seedHandshake(t)
	res := h.do(t, http.MethodPost, "/v1/groups/"+h.groupID.String()+"/fork-report", token,
		mustCBOR(t, []any{uint64(6), seq, "cannot process"}))
	if res.Code != http.StatusAccepted {
		t.Fatalf("status = %d, want 202: %s", res.Code, res.Body.String())
	}
	if got := res.Body.Bytes(); len(got) != 1 || got[0] != 0x80 {
		t.Fatalf("body = %x, want the empty CBOR array 80", got)
	}
}

// A report for a seq beyond the group's own log is 404 — the same code, over the wire, that a
// report about a group the device is not in gets. The bound is what keeps `fork_reports`, which
// nothing prunes, from growing one row per uint64 a member cares to name.
func TestForkReportBeyondTheLogsHeadIsFourZeroFour(t *testing.T) {
	h := newGroupsAPI(t)
	h.mustCreate(t)
	token := h.memberToken(t)
	res := h.do(t, http.MethodPost, "/v1/groups/"+h.groupID.String()+"/fork-report", token,
		mustCBOR(t, []any{uint64(6), uint64(9999), "cannot process"}))
	if res.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404: %s", res.Code, res.Body.String())
	}
	if got := errorCode(t, res); got != string(server.CodeNotFound) {
		t.Fatalf("code = %s, want %s", got, server.CodeNotFound)
	}
}

// seedHandshake appends one commit handshake at the group's own next seq, so that a fork report
// has a real entry of the log to name. `DS.Commit` cannot supply one: no commit in this repository
// can be ACCEPTED (the fixture ships one GroupInfo at epoch 6 where invariant 4 wants epoch n+1).
func (h *groupsAPI) seedHandshake(t *testing.T) uint64 {
	t.Helper()
	ctx := context.Background()
	seq, err := h.deps.Repo.NextSeq(ctx, h.groupID)
	if err != nil {
		t.Fatalf("NextSeq: %v", err)
	}
	if err := h.deps.Repo.AppendHandshake(ctx, store.HandshakeRow{
		GroupID: h.groupID,
		Seq:     seq,
		Epoch:   6,
		Kind:    1, // commit
		Blob:    []byte{0x01},
		Created: h.clk.Now().Unix(),
	}); err != nil {
		t.Fatalf("AppendHandshake: %v", err)
	}
	return seq
}

// A fork report about a group the device is not in is 404, never 403: the code protocol/02's row
// for this endpoint names, and a 403 would tell any authenticated device which groups exist.
func TestForkReportByANonMemberIsFourZeroFour(t *testing.T) {
	h := newGroupsAPI(t)
	h.mustCreate(t)
	res := h.do(t, http.MethodPost, "/v1/groups/"+h.groupID.String()+"/fork-report", h.session,
		mustCBOR(t, []any{uint64(6), uint64(1), "cannot process"}))
	if res.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404: %s", res.Code, res.Body.String())
	}
	if got := errorCode(t, res); got != string(server.CodeNotFound) {
		t.Fatalf("code = %s, want %s", got, server.CodeNotFound)
	}
}

// Endpoint 8: `[external_commit, group_info]` reaches the delivery service, and its refusal is
// protocol/02's CBOR error array — not a 404 from an unmounted route.
func TestResyncCarriesTheDeliveryServicesRefusal(t *testing.T) {
	h := newGroupsAPI(t)
	h.mustCreate(t)
	token := h.memberToken(t)
	res := h.do(t, http.MethodPost, "/v1/groups/"+h.groupID.String()+"/resync", token,
		mustCBOR(t, []any{[]byte{0x00, 0x01, 0x02}, []byte{0x03}}))
	if res.Code != http.StatusUnprocessableEntity {
		t.Fatalf("status = %d, want 422: %s", res.Code, res.Body.String())
	}
	if got := errorCode(t, res); got != string(server.CodeCommitInvalid) {
		t.Fatalf("code = %s, want %s", got, server.CodeCommitInvalid)
	}
}
