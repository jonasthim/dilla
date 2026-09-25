package ds_test

// Store-and-forward Welcomes: protocol/02's endpoints 15 (`GET /v1/welcomes`) and 16
// (`DELETE /v1/welcomes/{welcome_id}`), and the writer the commit's transaction calls.
//
// Every test here drives `storeWelcomesTx` through `StoreWelcomesForTest` rather than through
// `Commit`, because no commit can be ACCEPTED against the committed fixture: there is no GroupInfo
// at epoch 7 (commit_test.go's header, task 20's report). The writer is the delivery service's
// own, called where the commit's transaction calls it.

import (
	"bytes"
	"context"
	"errors"
	"testing"
	"time"

	"github.com/jonasthim/dilla/internal/auth"
	"github.com/jonasthim/dilla/internal/cborx"
	"github.com/jonasthim/dilla/internal/ds"
	"github.com/jonasthim/dilla/internal/id"
	"github.com/jonasthim/dilla/internal/store"
)

// gap-13: a Welcome is NOT consumed by the fetch. `StagedWelcome::new_from_welcome` consumes the
// key material inside the client even when the client then fails, so only the explicit DELETE
// marks it delivered.
func TestAWelcomeIsNotConsumedByTheFetchAndOnlyTheDeleteMarksItDelivered(t *testing.T) {
	h := newDSHarness(t)
	ctx := context.Background()
	g := h.group(t)
	joiner := h.device(t)
	h.storeWelcomes(t, g.id, g.epoch, 1, welcomeBlob(0x41, 96), joiner)
	session := h.sessionOf(t, joiner)

	first, err := h.ds.Welcomes(ctx, session, 0, 16)
	if err != nil {
		t.Fatalf("Welcomes: %v", err)
	}
	if len(first) != 1 {
		t.Fatalf("got %d welcomes, want 1", len(first))
	}
	second, err := h.ds.Welcomes(ctx, session, 0, 16)
	if err != nil {
		t.Fatalf("Welcomes again: %v", err)
	}
	if len(second) != 1 {
		t.Fatal("a fetch must not consume the Welcome")
	}
	if err := h.ds.AckWelcome(ctx, session, first[0].WelcomeID); err != nil {
		t.Fatalf("AckWelcome: %v", err)
	}
	third, err := h.ds.Welcomes(ctx, session, 0, 16)
	if err != nil {
		t.Fatalf("Welcomes after ack: %v", err)
	}
	if len(third) != 0 {
		t.Fatal("the DELETE marks it delivered")
	}
	// The row survives the acknowledgement: it is marked, not removed, so the retention sweep
	// rather than the client decides when the payload goes.
	if n := h.countRows(t, "mls_welcomes"); n != 1 {
		t.Fatalf("%d welcome rows after the ack, want the marked one", n)
	}
}

// Acknowledging a Welcome that is not this device's, or is already delivered, is E_NOT_FOUND —
// the code protocol/02 fixes for row 16.
func TestAcknowledgingAnotherDevicesWelcomeIsNotFound(t *testing.T) {
	h := newDSHarness(t)
	ctx := context.Background()
	g := h.group(t)
	joiner := h.device(t)
	h.storeWelcomes(t, g.id, g.epoch, 1, welcomeBlob(0x42, 96), joiner)
	welcomeID := h.welcomeIDOf(t, joiner, g.id)

	stranger := h.sessionOf(t, h.device(t))
	err := h.ds.AckWelcome(ctx, stranger, welcomeID)
	var dsErr *ds.Error
	if !errors.As(err, &dsErr) || dsErr.Code != "E_NOT_FOUND" {
		t.Fatalf("got %v, want E_NOT_FOUND", err)
	}
	// And the Welcome is still queued for the device it belongs to.
	rows, err := h.ds.Welcomes(ctx, h.sessionOf(t, joiner), 0, 16)
	if err != nil || len(rows) != 1 {
		t.Fatalf("the owner's Welcome was consumed by a stranger's ack: %d rows, %v", len(rows), err)
	}
}

// gap-13: dilla Welcomes carry no tree, and the live tree has moved on, so the response carries
// the tree of the WELCOMING epoch.
func TestTheWelcomeResponseCarriesTheTreeOfTheWelcomingEpoch(t *testing.T) {
	h := newDSHarness(t)
	ctx := context.Background()
	g := h.group(t)
	joiner := h.device(t)
	h.storeWelcomes(t, g.id, g.epoch, 1, welcomeBlob(0x43, 96), joiner)

	live, err := h.ds.Tree(ctx, g.id, g.session)
	if err != nil {
		t.Fatalf("Tree: %v", err)
	}

	// The group moves on before the joiner collects: a later epoch, with a tree of its own.
	later := welcomeBlob(0x5A, 128)
	if err := h.repo.PutEpochTree(ctx, store.EpochTreeRow{
		GroupID: g.id, Epoch: g.epoch + 1, RatchetTree: later,
		TreeHash: bytes.Repeat([]byte{0x5B}, 32), Created: h.clk.Now().Unix(),
	}); err != nil {
		t.Fatalf("PutEpochTree: %v", err)
	}

	got, err := h.ds.Welcomes(ctx, h.sessionOf(t, joiner), 0, 16)
	if err != nil {
		t.Fatalf("Welcomes: %v", err)
	}
	if len(got) != 1 {
		t.Fatalf("got %d welcomes, want 1", len(got))
	}
	if got[0].Epoch != g.epoch {
		t.Fatalf("welcome epoch = %d, want %d", got[0].Epoch, g.epoch)
	}
	if bytes.Equal(got[0].RatchetTree, later) {
		t.Fatal("the Welcome must carry the tree of its own epoch, not the live one")
	}
	if !bytes.Equal(got[0].RatchetTree, live.RatchetTree) {
		t.Fatal("the Welcome's tree is not the one the welcoming epoch's PublicGroup exported")
	}
	if len(got[0].TreeHash) != 32 {
		t.Fatalf("tree_hash is %d bytes, want 32", len(got[0].TreeHash))
	}
	if !bytes.Equal(got[0].TreeHash, live.TreeHash) {
		t.Fatal("the Welcome's tree_hash is not the welcoming epoch's")
	}
}

// One 256-device commit stores ONE payload row and 256 welcome rows: the Welcome blob is
// identical for every joiner of one commit, and storing it 256 times is how a join storm fills a
// disk.
func TestA256DeviceCommitStoresOnePayloadAnd256WelcomeRows(t *testing.T) {
	h := newDSHarness(t)
	g := h.group(t)
	joiners := make([]id.ID, 256)
	for i := range joiners {
		joiners[i] = h.device(t)
	}
	h.storeWelcomes(t, g.id, g.epoch, 1, welcomeBlob(0x44, 1024), joiners...)

	if got := h.countRows(t, "mls_welcome_payloads"); got != 1 {
		t.Fatalf("%d payload rows, want 1", got)
	}
	if got := h.countRows(t, "mls_welcomes"); got != 256 {
		t.Fatalf("%d welcome rows, want 256", got)
	}
	// And one epoch tree, not one per joiner.
	if got := h.countRows(t, "mls_epoch_trees"); got != 1 {
		t.Fatalf("%d epoch trees, want 1", got)
	}
	// Every joiner gets the whole body back, from the one row.
	rows, err := h.ds.Welcomes(context.Background(), h.sessionOf(t, joiners[255]), 0, 16)
	if err != nil {
		t.Fatalf("Welcomes: %v", err)
	}
	if len(rows) != 1 || len(rows[0].Blob) != 1024 {
		t.Fatalf("the last joiner got %d rows; blob is %d bytes, want 1024", len(rows), len(rows[0].Blob))
	}
}

// A Welcome past its 30-day delivery retention is gone from the fetch, whether or not the
// retention sweep has run yet: `expires` is stored on the row and the read honours it.
func TestAWelcomeIsGoneAfterItsExpiry(t *testing.T) {
	h := newDSHarness(t)
	g := h.group(t)
	joiner := h.device(t)
	h.storeWelcomes(t, g.id, g.epoch, 1, welcomeBlob(0x45, 96), joiner)

	h.clk.Advance(31 * 24 * time.Hour)

	got, err := h.ds.Welcomes(context.Background(), h.sessionOf(t, joiner), 0, 16)
	if err != nil {
		t.Fatalf("Welcomes: %v", err)
	}
	if len(got) != 0 {
		t.Fatal("a Welcome past its 30-day delivery retention is gone")
	}
}

// Rows 15 and 16 accept a provisional session, and the restriction that makes that safe is
// enforced, not assumed: a provisional session is bound to ONE pairing group and collects that
// group's Welcome, nothing else. Without the check a session issued before enrolment can harvest
// the Welcomes of every group its device was ever added to — the escalation interfaces §2.2
// point 4 forbids.
func TestAProvisionalSessionCannotReachAnotherGroupsWelcome(t *testing.T) {
	h := newDSHarness(t)
	ctx := context.Background()
	pairing := h.group(t)
	joiner := h.device(t)

	// The device is added to BOTH groups, so a Welcome exists for each. The second group is
	// written directly: `Register` is bound to the committed fixture's one group id, so a harness
	// cannot register a second group at all.
	h.storeWelcomes(t, pairing.id, pairing.epoch, 1, welcomeBlob(0x46, 96), joiner)
	other := id.New()
	h.putWelcomeRow(t, joiner, other, 3, welcomeBlob(0x47, 96))

	// An enrolled session sees both.
	if rows, err := h.ds.Welcomes(ctx, h.sessionOf(t, joiner), 0, 64); err != nil || len(rows) != 2 {
		t.Fatalf("an enrolled session saw %d Welcomes (%v), want both", len(rows), err)
	}

	provisional := h.provisionalSessionOf(t, joiner, pairing.id)
	rows, err := h.ds.Welcomes(ctx, provisional, 0, 64)
	if err != nil {
		t.Fatalf("Welcomes: %v", err)
	}
	for _, row := range rows {
		if row.GroupID != pairing.id {
			t.Fatalf("a provisional session was served the Welcome of group %s, outside its pairing group %s",
				row.GroupID, pairing.id)
		}
	}
	if len(rows) != 1 {
		t.Fatalf("a provisional session saw %d Welcomes, want exactly its pairing group's", len(rows))
	}

	// And acknowledging another group's Welcome is refused by code, not merely absent.
	err = h.ds.AckWelcome(ctx, provisional, h.welcomeIDOf(t, joiner, other))
	var dsErr *ds.Error
	if !errors.As(err, &dsErr) || dsErr.Code != "E_PROVISIONAL_OUTSIDE_PAIRING" {
		t.Fatalf("got %v, want E_PROVISIONAL_OUTSIDE_PAIRING", err)
	}
	// Its own pairing group's Welcome it may acknowledge.
	if err := h.ds.AckWelcome(ctx, provisional, h.welcomeIDOf(t, joiner, pairing.id)); err != nil {
		t.Fatalf("a provisional session must be able to acknowledge its pairing Welcome: %v", err)
	}

	// A provisional session bound to no pairing group at all reaches nothing.
	unbound := provisional
	unbound.PairingGroup = nil
	if _, err := h.ds.Welcomes(ctx, unbound, 0, 64); !errors.As(err, &dsErr) ||
		dsErr.Code != "E_PROVISIONAL_OUTSIDE_PAIRING" {
		t.Fatalf("got %v, want E_PROVISIONAL_OUTSIDE_PAIRING for a session bound to no group", err)
	}
}

// The addressed fan-out: every joiner of a commit is sent its own `mls.welcome`, carrying the
// welcome_id the DELETE names. A client that is online when the commit lands must not have to poll
// row 15 to discover it.
func TestEveryJoinerIsSentItsOwnWelcomeFrame(t *testing.T) {
	h := newDSHarness(t)
	ctx := context.Background()
	joiners := []id.ID{h.device(t), h.device(t)}
	if h.sessions == nil {
		h.sessions = map[id.ID]auth.Session{}
	}
	for _, j := range joiners {
		h.sessions[j] = h.sessionOf(t, j)
	}
	h.online(joiners...)

	// A group whose epoch tree FITS the gateway's frame budget. The committed fixture's is 620 KiB
	// against a budget of 131 584 — the case the next test covers; this one is the group a handful
	// of devices actually make.
	groupID := id.New()
	blob := welcomeBlob(0x48, 96)
	welcomes := make([]ds.WelcomeFor, 0, len(joiners))
	for _, j := range joiners {
		h.putWelcomeRow(t, j, groupID, 3, blob)
		welcomes = append(welcomes, ds.WelcomeFor{DeviceID: j, Blob: blob})
	}
	ds.FanOutWelcomesForTest(h.ds, ctx, groupID, 3, welcomes)

	for _, j := range joiners {
		f := h.waitDeviceFrame(t, j, "mls.welcome")
		if len(f.payload) != 6 {
			t.Fatalf("the welcome payload has %d elements, want 6: "+
				"[welcome_id, epoch, commit_seq, blob, ratchet_tree, tree_hash]", len(f.payload))
		}
		var welcomeID uint64
		if err := cborx.Unmarshal(f.payload[0], &welcomeID); err != nil {
			t.Fatalf("decode welcome_id: %v", err)
		}
		if int64(welcomeID) != h.welcomeIDOf(t, j, groupID) {
			t.Fatalf("the frame names welcome_id %d, not the row the DELETE addresses", welcomeID)
		}
		var treeHash []byte
		if err := cborx.Unmarshal(f.payload[5], &treeHash); err != nil {
			t.Fatalf("decode tree_hash: %v", err)
		}
		if len(treeHash) != 32 {
			t.Fatalf("tree_hash is %d bytes, want 32", len(treeHash))
		}
	}
}

// A Welcome whose ratchet tree is larger than the gateway's own `max_frame_bytes` is NOT sent as a
// frame, and the row stays queued for `GET /v1/welcomes`.
//
// This is not a nicety. A client sizes its websocket read limit from the `max_frame_bytes` the
// same gateway advertised in `hello`, so an oversize frame closes the joiner's connection rather
// than reaching it — and the joiner reconnects to be closed by it again. The committed 1,500-leaf
// fixture's tree is 620 KiB against a budget of 131 584, so this is the ordinary case for a group
// of real size, not a corner. See the CONCERN in fanOutWelcomes.
func TestAWelcomeTooLargeForTheFrameBudgetIsLeftToTheQueue(t *testing.T) {
	h := newDSHarness(t)
	ctx := context.Background()
	g := h.group(t)
	joiner := h.device(t)
	if h.sessions == nil {
		h.sessions = map[id.ID]auth.Session{}
	}
	h.sessions[joiner] = h.sessionOf(t, joiner)
	h.online(joiner)

	blob := welcomeBlob(0x49, 96)
	h.storeWelcomes(t, g.id, g.epoch, 9, blob, joiner)
	ds.FanOutWelcomesForTest(h.ds, ctx, g.id, g.epoch, []ds.WelcomeFor{{DeviceID: joiner, Blob: blob}})

	// No frame, and the connection is still up: the oversize frame was never enqueued.
	h.expectNoWelcomeFrame(t, joiner)

	// And the Welcome is still there to be collected over HTTP, tree and all.
	rows, err := h.ds.Welcomes(ctx, h.sessionOf(t, joiner), 0, 16)
	if err != nil {
		t.Fatalf("Welcomes: %v", err)
	}
	if len(rows) != 1 {
		t.Fatalf("got %d welcomes, want the one the frame could not carry", len(rows))
	}
	if len(rows[0].RatchetTree) <= 131584 {
		t.Fatalf("the fixture's tree is %d bytes; this test needs one over the frame budget",
			len(rows[0].RatchetTree))
	}
}
