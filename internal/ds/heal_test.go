package ds_test

// heal_test.go is invariant 11: `dillad restore` bumps the generation and marks every group
// epoch-unknown, a member heals a group by uploading its member-signed GroupInfo and its handshake
// tail, and a group nobody heals inside the window is closed.
//
// WHAT THE COMMITTED FIXTURE GIVES, AND WHAT IT WITHHOLDS, shapes three of these tests, exactly as
// it shapes commit_test.go, proposal_test.go and directory_harness_test.go before them:
//
//   - `testkit/fixtures/ds-1500` ships ONE GroupInfo, at epoch 6 and signed by leaf 0. Invariant
//     4 wants epoch n+1, so no commit in this repository can be ACCEPTED (commit_test.go:670).
//     Every test here that the brief drives through `DS.Commit` is therefore driven through the
//     same state transition written straight into SQL — the epoch column IS what `Heal` compares
//     against — or, where the assertion is about the tail replaying, through the fixture's one
//     PROPOSAL, which a PublicGroup processes without moving the epoch or the tree hash.
//   - The one KeyPackage the fixture ships carries no `last_resort` extension and cannot be
//     minted a second time (directory_harness_test.go's header), so the directory a restore
//     purges is seeded through the store, which is where the purge rule lives anyway.

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/jonasthim/dilla/internal/cborx"
	"github.com/jonasthim/dilla/internal/ds"
	"github.com/jonasthim/dilla/internal/gateway"
	"github.com/jonasthim/dilla/internal/id"
	"github.com/jonasthim/dilla/internal/store"
	"github.com/jonasthim/dilla/internal/store/sqlite"
)

func TestOnRestoreBumpsTheGenerationMarksEveryGroupUnknownAndPurgesKeyPackages(t *testing.T) {
	h := newDSHarness(t)
	g := h.group(t)
	device := g.device
	// DEVIATION from the brief, which publishes four packages and a last-resort one through
	// `PublishKeyPackages`. The fixture ships ONE KeyPackage and it is not a last-resort one, and
	// nothing in this repository can mint another (directory_harness_test.go's header), so the
	// directory is seeded through the store — which is where the purge rule lives.
	h.seedKeyPackages(t, device, 4, 30*24*time.Hour)
	h.seedLastResort(t, device, 90*24*time.Hour)
	call := h.liveCallGroup(t)
	before := h.generation(t)

	if err := h.ds.OnRestore(context.Background(), before+1); err != nil {
		t.Fatalf("OnRestore: %v", err)
	}
	if got := h.generation(t); got != before+1 {
		t.Fatalf("generation = %d, want %d", got, before+1)
	}
	if !h.epochUnknown(t, g.id) {
		t.Error("every group becomes epoch-unknown on restore")
	}
	if got := h.countKeyPackages(t, device); got != 1 {
		t.Errorf("%d KeyPackages survive, want the 1 last-resort", got)
	}
	if h.liveCalls(t) != 0 {
		t.Error("live calls end on restore")
	}
	if !h.isClosed(t, call) {
		t.Error("the call group is still open after a restore")
	}
	status, err := h.ds.HealStatus(context.Background(), g.id)
	if err != nil {
		t.Fatalf("HealStatus: %v", err)
	}
	if status.Generation != before+1 {
		t.Errorf("HealStatus generation = %d, want %d", status.Generation, before+1)
	}
	if status.Epoch != g.Epoch() || status.NeedFromSeq != status.NextSeq {
		t.Errorf("HealStatus = %+v, want epoch %d and need_from_seq == next_seq",
			status, g.Epoch())
	}
}

// The instance adopts a heal only when its own stored epoch is <= the uploaded GroupInfo's.
//
// DEVIATION from the brief, which advances the epoch with `h.ds.Commit`. No commit in this
// repository can be accepted, so the epoch moves through `advanceGroupEpoch` — the same UPDATE
// `persistState` makes, which is what leaves the column `Heal` reads.
func TestAHealBelowTheStoredEpochIsRefused(t *testing.T) {
	h := newDSHarness(t)
	g := h.group(t)
	ahead := h.advanceGroupEpoch(t, g.id)
	if ahead <= g.Epoch() {
		t.Fatalf("the stored epoch is %d, want it ahead of the fixture's %d", ahead, g.Epoch())
	}
	if err := h.ds.OnRestore(context.Background(), h.generation(t)+1); err != nil {
		t.Fatalf("OnRestore: %v", err)
	}
	_, err := h.ds.Heal(context.Background(), g.session, g.id, h.healAtEpoch(t, g, g.Epoch()))
	var dsErr *ds.Error
	if !errors.As(err, &dsErr) || dsErr.Code != "E_COMMIT_INVALID" {
		t.Fatalf("got %v, want E_COMMIT_INVALID", err)
	}
	if dsErr.Rule != "heal_epoch" {
		t.Errorf("rule = %q, want heal_epoch", dsErr.Rule)
	}
	if !h.epochUnknown(t, g.id) {
		t.Error("a refused heal must leave the group epoch-unknown")
	}
}

// The happy path: the tail replays cleanly through the restored blob and the rebuilt tree's hash
// equals the GroupInfo's.
//
// DEVIATION from the brief, whose tail is a COMMIT and whose GroupInfo is the one that commit
// produced. The fixture ships no GroupInfo at epoch 7, so a commit in the tail would leave the
// rebuilt tree at a hash no uploadable GroupInfo names, and the adoption could never be asserted.
// The tail here is the fixture's one PROPOSAL, which is the other half of the same loop —
// `Process` returns it with no staged handle, so it is queued and not merged — and it exercises
// everything the adoption turns on: the import from the restored blob, the replay, the signature,
// epoch and tree-hash checks, the appended handshake rows, the new high-water and the cleared
// epoch_unknown.
func TestAHealWhoseTailReplaysCleanlyIsAdopted(t *testing.T) {
	h := newDSHarness(t)
	g := h.group(t)
	tail := h.tailFrom(t, g, 0)
	if err := h.ds.OnRestore(context.Background(), h.generation(t)+1); err != nil {
		t.Fatalf("OnRestore: %v", err)
	}

	out, err := h.ds.Heal(context.Background(), g.session, g.id, ds.HealRequest{
		GroupInfo: h.groupInfoAt(t, g, g.Epoch()),
		Tail:      tail,
	})
	if err != nil {
		t.Fatalf("Heal: %v", err)
	}
	if out.Epoch != g.Epoch() {
		t.Fatalf("healed to epoch %d, want %d", out.Epoch, g.Epoch())
	}
	if h.epochUnknown(t, g.id) {
		t.Error("an adopted heal clears epoch_unknown")
	}
	// The replayed tail is APPENDED and the high-water advances with it: without that, every other
	// member's `GET /handshakes?from=<its cursor>` would receive nothing for what the instance
	// just adopted.
	if out.Seq != uint64(len(tail)) {
		t.Errorf("next high-water = %d, want %d", out.Seq, len(tail))
	}
	if got := h.handshakeCount(t, g.id); got != int64(len(tail)) {
		t.Errorf("%d handshake rows, want %d", got, len(tail))
	}
	if got := h.storedSeq(t, g.id); got != out.Seq {
		t.Errorf("the group's seq column is %d, want %d", got, out.Seq)
	}
}

// A heal with no usable blob AND a supplied ratchet tree reseeds through from_external — the one
// upload where the tree is allowed, because the instance has none, and RFC 9420 §12.4.3.3's
// signed tree_hash is what makes that source safe.
func TestAHealWithNoBlobReseedsFromTheSuppliedTree(t *testing.T) {
	h := newDSHarness(t)
	g := h.group(t)
	tree := h.currentTree(t, g)
	groupInfo := h.groupInfoAt(t, g, g.Epoch())
	if err := h.ds.OnRestore(context.Background(), h.generation(t)+1); err != nil {
		t.Fatalf("OnRestore: %v", err)
	}
	h.destroyStateBlob(t, g)

	if _, err := h.ds.Heal(context.Background(), g.session, g.id, ds.HealRequest{
		GroupInfo:   groupInfo,
		RatchetTree: tree,
	}); err != nil {
		t.Fatalf("reseeding heal: %v", err)
	}
	if h.epochUnknown(t, g.id) {
		t.Error("a reseeding heal clears epoch_unknown")
	}

	// Without the tree there is nothing to reseed from, and the heal is refused rather than
	// accepted on the member's word.
	h.destroyStateBlob(t, g)
	_, err := h.ds.Heal(context.Background(), g.session, g.id, ds.HealRequest{GroupInfo: groupInfo})
	var dsErr *ds.Error
	if !errors.As(err, &dsErr) || dsErr.Code != "E_COMMIT_INVALID" {
		t.Fatalf("got %v, want E_COMMIT_INVALID", err)
	}
}

func TestATailLongerThanSixtyFourItemsIsRefused(t *testing.T) {
	h := newDSHarness(t)
	g := h.group(t)
	req := ds.HealRequest{GroupInfo: h.groupInfoAt(t, g, g.Epoch()), Tail: h.syntheticTail(65)}
	_, err := h.ds.Heal(context.Background(), g.session, g.id, req)
	var dsErr *ds.Error
	if !errors.As(err, &dsErr) || dsErr.Code != "E_INVALID_REQUEST" {
		t.Fatalf("got %v, want E_INVALID_REQUEST", err)
	}
}

func TestAGroupThatIsNotHealedWithinTheWindowIsClosed(t *testing.T) {
	h := newDSHarness(t)
	g := h.group(t)
	if err := h.ds.OnRestore(context.Background(), h.generation(t)+1); err != nil {
		t.Fatalf("OnRestore: %v", err)
	}
	// Inside the window nothing happens: the sweep that ran before the deadline must not close a
	// group a member is still on its way to healing.
	if _, err := h.ds.Sweep(context.Background()); err != nil {
		t.Fatalf("Sweep inside the window: %v", err)
	}
	if h.isClosed(t, g.id) {
		t.Fatal("the group was closed before the heal window elapsed")
	}

	h.clk.Advance(25 * time.Hour)
	if _, err := h.ds.Sweep(context.Background()); err != nil {
		t.Fatalf("Sweep: %v", err)
	}
	if !h.isClosed(t, g.id) {
		t.Fatal("after the 24-hour heal window with no successful heal the group is closed")
	}
}

// A group that WAS healed is not closed when the deadline passes: the adoption cleared both the
// flag and the deadline, which is the pair closeUnhealedGroups reads.
func TestAHealedGroupSurvivesTheWindow(t *testing.T) {
	h := newDSHarness(t)
	g := h.group(t)
	if err := h.ds.OnRestore(context.Background(), h.generation(t)+1); err != nil {
		t.Fatalf("OnRestore: %v", err)
	}
	if _, err := h.ds.Heal(context.Background(), g.session, g.id,
		h.healAtEpoch(t, g, g.Epoch())); err != nil {
		t.Fatalf("Heal: %v", err)
	}
	h.clk.Advance(25 * time.Hour)
	if _, err := h.ds.Sweep(context.Background()); err != nil {
		t.Fatalf("Sweep: %v", err)
	}
	if h.isClosed(t, g.id) {
		t.Fatal("a healed group was closed by the heal-window sweep anyway")
	}
}

// Every response and every gateway hello carries the new generation, which invalidates
// outstanding resume tokens.
func TestTheNewGenerationInvalidatesResumeTokens(t *testing.T) {
	h := newDSHarness(t)
	g := h.group(t)
	conn := h.connectDevice(t, g.device)
	token := conn.ResumeToken(t)

	// The same token IS accepted while the generation stands, so what the restore changes is the
	// generation and not merely the socket.
	if !h.resumeAccepted(t, conn, token) {
		t.Fatal("a resume under the current generation must be accepted")
	}

	conn = h.connectDevice(t, g.device)
	token = conn.ResumeToken(t)
	if err := h.ds.OnRestore(context.Background(), h.generation(t)+1); err != nil {
		t.Fatalf("OnRestore: %v", err)
	}
	if h.resumeAccepted(t, conn, token) {
		t.Fatal("a resume under the old generation must be refused after a restore")
	}
}

// ---------------------------------------------------------------- the helpers

// generation is the instance generation SQL holds.
func (h *dsHarness) generation(t *testing.T) uint64 {
	t.Helper()
	row, err := h.repo.GetInstance(context.Background())
	if err != nil {
		t.Fatalf("GetInstance: %v", err)
	}
	return row.Generation
}

func (h *dsHarness) groupRow(t *testing.T, groupID id.ID) store.GroupRow {
	t.Helper()
	row, err := h.repo.GetGroup(context.Background(), groupID)
	if err != nil {
		t.Fatalf("GetGroup: %v", err)
	}
	return row
}

func (h *dsHarness) epochUnknown(t *testing.T, groupID id.ID) bool {
	t.Helper()
	return h.groupRow(t, groupID).EpochUnknown
}

func (h *dsHarness) isClosed(t *testing.T, groupID id.ID) bool {
	t.Helper()
	return h.groupRow(t, groupID).ClosedAt != nil
}

func (h *dsHarness) storedSeq(t *testing.T, groupID id.ID) uint64 {
	t.Helper()
	return h.groupRow(t, groupID).Seq
}

// countKeyPackages is EVERY row the device still holds, the last-resort one included —
// `CountKeyPackages` deliberately excludes it, and the purge rule is precisely about which of the
// two kinds survives.
func (h *dsHarness) countKeyPackages(t *testing.T, device id.ID) int64 {
	t.Helper()
	db, err := sqlite.OpenRead(h.path)
	if err != nil {
		t.Fatalf("sqlite.OpenRead: %v", err)
	}
	defer func() { _ = db.Close() }()
	var n int64
	if err := db.QueryRow(
		"SELECT count(*) FROM key_packages WHERE device_id = ?", device[:]).Scan(&n); err != nil {
		t.Fatalf("count key_packages: %v", err)
	}
	return n
}

func (h *dsHarness) handshakeCount(t *testing.T, groupID id.ID) int64 {
	t.Helper()
	db, err := sqlite.OpenRead(h.path)
	if err != nil {
		t.Fatalf("sqlite.OpenRead: %v", err)
	}
	defer func() { _ = db.Close() }()
	var n int64
	if err := db.QueryRow(
		"SELECT count(*) FROM mls_handshakes WHERE group_id = ?", groupID[:]).Scan(&n); err != nil {
		t.Fatalf("count mls_handshakes: %v", err)
	}
	return n
}

// liveCalls counts the OPEN call groups. A live call is its call group: R9 puts the call id in a
// companion column and `voice_sessions` is Plan 2's table, so on a Plan-1 database this is the
// whole of "live calls".
func (h *dsHarness) liveCalls(t *testing.T) int64 {
	t.Helper()
	db, err := sqlite.OpenRead(h.path)
	if err != nil {
		t.Fatalf("sqlite.OpenRead: %v", err)
	}
	defer func() { _ = db.Close() }()
	var n int64
	if err := db.QueryRow(
		"SELECT count(*) FROM mls_groups WHERE call_id IS NOT NULL AND closed_at IS NULL",
	).Scan(&n); err != nil {
		t.Fatalf("count call groups: %v", err)
	}
	return n
}

// liveCallGroup writes one open call group. It goes through the store rather than through
// `Register`, because the committed fixture's binding is a TEXT group's (kind 0, fixtures.rs:106)
// and nothing in this repository can mint a call group's GroupInfo — while what is under test is
// what a restore does to a row that has a call id.
func (h *dsHarness) liveCallGroup(t *testing.T) id.ID {
	t.Helper()
	groupID := id.New()
	callID := id.New()
	if err := h.repo.CreateGroup(context.Background(), store.GroupRow{
		GroupID:             groupID,
		Binding:             []byte{0x80},
		Kind:                1, // call
		TargetID:            callID,
		CallID:              &callID,
		Ciphersuite:         1,
		ExternalSenderKeyID: testInstanceKeys(t).ExternalSenderKeyID,
		E2EEVersion:         1,
		MediaVersion:        1,
		PolicyVersion:       1,
		Created:             h.clk.Now().Unix(),
	}); err != nil {
		t.Fatalf("CreateGroup(call): %v", err)
	}
	return groupID
}

// groupInfoAt is the member-signed GroupInfo for that epoch. The fixture ships exactly one, at
// epoch 6 and signed by leaf 0 — which is the leaf `h.group` hands the test its session for — so
// any other epoch is a test asking for material that does not exist.
func (h *dsHarness) groupInfoAt(t *testing.T, g *dsMessageGroup, epoch uint64) []byte {
	t.Helper()
	if epoch != g.Epoch() {
		t.Fatalf("the fixture ships one GroupInfo, at epoch %d; epoch %d is not available",
			g.Epoch(), epoch)
	}
	return dsFixture(t).groupInfo
}

// currentTree is the ratchet tree of the group's current epoch, as a healing member would upload
// it when the instance holds no blob of its own.
func (h *dsHarness) currentTree(t *testing.T, _ *dsMessageGroup) []byte {
	t.Helper()
	return dsFixture(t).ratchetTree
}

// healAtEpoch is a bare heal: the GroupInfo alone, no tail and no tree.
func (h *dsHarness) healAtEpoch(t *testing.T, g *dsMessageGroup, epoch uint64) ds.HealRequest {
	t.Helper()
	return ds.HealRequest{GroupInfo: h.groupInfoAt(t, g, epoch)}
}

// tailFrom is the handshake tail a healing member uploads: the fixture's one proposal, numbered
// from the seq the caller is behind at.
func (h *dsHarness) tailFrom(t *testing.T, g *dsMessageGroup, from uint64) []ds.HealTailItem {
	t.Helper()
	leaf := uint32(0)
	return []ds.HealTailItem{{
		Seq:    from + 1,
		Epoch:  g.Epoch(),
		Kind:   0, // proposal
		Sender: &leaf,
		Blob:   fixtureFile(t, "remove_leaf0.mls"),
	}}
}

// syntheticTail is n items of nothing in particular: the length cap is checked before a single
// blob is parsed, which is the point of checking it first.
func (h *dsHarness) syntheticTail(n int) []ds.HealTailItem {
	out := make([]ds.HealTailItem, 0, n)
	for i := range n {
		out = append(out, ds.HealTailItem{Seq: uint64(i) + 1, Kind: 0, Blob: []byte{0x01}})
	}
	return out
}

// destroyStateBlob empties `public_group_state`, which is what a restore from a backup that
// predates the group leaves behind: the row exists and the blob does not.
func (h *dsHarness) destroyStateBlob(t *testing.T, g *dsMessageGroup) {
	t.Helper()
	row := h.groupRow(t, g.id)
	if err := h.repo.PutGroupState(context.Background(), g.id, row.Epoch,
		nil, row.GroupInfoBlob, row.TreeHash); err != nil {
		t.Fatalf("PutGroupState: %v", err)
	}
	// PutGroupState clears epoch_unknown, which the restore had set; put it back so the test is
	// still healing a group the restore marked.
	if err := h.repo.MarkAllGroupsEpochUnknown(context.Background(),
		h.clk.Now().Add(h.policy().HealWindow).Unix()); err != nil {
		t.Fatalf("MarkAllGroupsEpochUnknown: %v", err)
	}
	// The cached handle still describes the blob that is now gone.
	if err := ds.EvictStateForTest(h.ds, context.Background(), g.id); err != nil {
		t.Fatalf("evict: %v", err)
	}
}

// ---------------------------------------------------------------- resume over the wire

// connectDevice puts the device on a live gateway connection and hands back the connection the
// resume test dials again.
func (h *dsHarness) connectDevice(t *testing.T, device id.ID) *deviceConn {
	t.Helper()
	return h.connect(device)
}

// ResumeToken is element 3 of the `ready` frame this connection was greeted with.
func (c *deviceConn) ResumeToken(t *testing.T) []byte {
	t.Helper()
	if len(c.ready.payload) < 4 {
		t.Fatalf("ready carries %d elements, want at least 4", len(c.ready.payload))
	}
	var token []byte
	if err := cborx.Unmarshal(c.ready.payload[3], &token); err != nil {
		t.Fatalf("decode the resume token: %v", err)
	}
	return token
}

// readyGeneration is element 2 of `ready`: the generation the client learned, and the one its
// `resume` frame must carry back.
func (c *deviceConn) readyGeneration(t *testing.T) uint64 {
	t.Helper()
	var generation uint64
	if err := cborx.Unmarshal(c.ready.payload[2], &generation); err != nil {
		t.Fatalf("decode the generation: %v", err)
	}
	return generation
}

// resumeAccepted drops the socket, waits for the gateway to park the connection in its resume
// window, and dials again with the token. It answers what the instance answered: `resumed`, or
// `invalid_session`.
//
// It is driven over a real WebSocket rather than against the gateway's internals because
// internal/ds is an external test package — and because the refusal invariant 11 promises is one
// a client observes on the wire, not one a field holds.
func (h *dsHarness) resumeAccepted(t *testing.T, c *deviceConn, token []byte) bool {
	t.Helper()
	generation := c.readyGeneration(t)
	_ = c.ws.CloseNow()
	delete(h.conns, c.deviceID)
	deadline := time.Now().Add(15 * time.Second)
	for h.gw.Online(c.deviceID) {
		if time.Now().After(deadline) {
			t.Fatalf("device %s is still online after its socket closed", c.deviceID.String()[:8])
		}
		time.Sleep(time.Millisecond)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	ws, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(c.url, "http"),
		&websocket.DialOptions{
			HTTPHeader:   http.Header{"Authorization": []string{"Bearer " + c.bearer}},
			Subprotocols: []string{"dilla.v1"},
		})
	if err != nil {
		t.Fatalf("re-dial the gateway: %v", err)
	}
	defer func() { _ = ws.CloseNow() }()
	if hello := readRecordedFrame(t, ctx, ws); hello.op != gateway.OpHello {
		t.Fatalf("the first frame is %s, want hello", hello.name)
	}
	payload, err := cborx.Marshal([]any{"", token, generation, uint64(0)})
	if err != nil {
		t.Fatalf("encode resume: %v", err)
	}
	frame, err := gateway.Encode(
		gateway.Frame{Op: gateway.OpResume, Payload: cborx.Raw(payload)}, 2)
	if err != nil {
		t.Fatalf("Encode: %v", err)
	}
	if err := ws.Write(ctx, websocket.MessageBinary, frame); err != nil {
		t.Fatalf("write resume: %v", err)
	}
	switch got := readRecordedFrame(t, ctx, ws); got.op {
	case gateway.OpResumed:
		return true
	case gateway.OpInvalidSession:
		return false
	default:
		t.Fatalf("the answer to resume is op %d, want resumed or invalid_session", got.op)
		return false
	}
}
