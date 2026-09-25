package ds_test

// fork_test.go is invariant 9: a member that cannot process an accepted commit reports it, and
// three DISTINCT reporter devices against one commit quarantine its committer.
//
// DEVIATION FROM THE BRIEF'S STEP 1 (recorded in the task-25 report). The brief's test obtains the
// commit it reports against with
//
//	commit, err := h.ds.Commit(ctx, g.sessionOf(0), g.id, h.commitFor(t, g, g.Epoch()))
//
// and no commit in this repository can be ACCEPTED: `testkit/fixtures/ds-1500` ships exactly one
// GroupInfo, at epoch 6, and invariant 4's step (6) wants epoch n+1 — the blocker
// `commit_test.go` records in two skips, `proposal_test.go` in a third and the plan in deviations
// B21/B24. Writing the test the brief's way would have produced a fourth skip and left invariant 9
// — which is entirely about the fork_reports rows and the quarantine, not about how the commit got
// into the log — completely unexercised.
//
// So the accepted commit is SEEDED into the handshake log, exactly as `appendHandshake` already
// seeds the winner `E_COMMIT_CONFLICT` names, with the one thing invariant 9 reads that
// `appendHandshake` does not write: the committer's device and leaf. Everything else — the store,
// the quorum, the distinctness, the quarantine flag and the instance Remove — is the real thing.

import (
	"context"
	"testing"

	"github.com/jonasthim/dilla/internal/auth"
	"github.com/jonasthim/dilla/internal/id"
	"github.com/jonasthim/dilla/internal/mlswasi"
	"github.com/jonasthim/dilla/internal/store"
)

// Invariant 9: three DISTINCT reporter devices against one commit quarantine the committer.
func TestThreeDistinctReportersQuarantineTheCommitterAndOneDeviceDoesNot(t *testing.T) {
	h := newDSHarness(t)
	g := h.groupWithMembers(t, 4)
	commit := h.acceptedCommitBy(t, g, 0)

	// Three reports from ONE device must not quarantine anybody.
	for range 3 {
		if err := h.ds.ForkReport(context.Background(), g.sessionOf(1), g.id, commit.Epoch, commit.Seq, "cannot process"); err != nil {
			t.Fatalf("ForkReport: %v", err)
		}
	}
	if h.isQuarantined(t, g.members[0]) {
		t.Fatal("three reports from one device must not quarantine the committer")
	}

	for _, reporter := range []int{1, 2, 3} {
		if err := h.ds.ForkReport(context.Background(), g.sessionOf(reporter), g.id, commit.Epoch, commit.Seq, "cannot process"); err != nil {
			t.Fatalf("ForkReport from %d: %v", reporter, err)
		}
	}
	if !h.isQuarantined(t, g.members[0]) {
		t.Fatal("three distinct reporters must quarantine the committer")
	}
	if !h.hasOutstandingRemoveOfLeaf(t, g, g.leafOf(0)) {
		t.Fatal("quarantine must also Remove the committer's leaf by an instance proposal")
	}
}

// A quorum against the instance's OWN handshake — one with no sender device, which is what an
// external-sender proposal leaves in the log — quarantines nobody. Without the guard the
// committer lookup dereferences a nil device id.
func TestAForkQuorumAgainstAnInstanceHandshakeQuarantinesNobody(t *testing.T) {
	h := newDSHarness(t)
	g := h.groupWithMembers(t, 4)
	seq := h.seedHandshake(t, g, nil, nil)

	for _, reporter := range []int{1, 2, 3} {
		if err := h.ds.ForkReport(context.Background(), g.sessionOf(reporter), g.id, g.epoch(t), seq, "cannot process"); err != nil {
			t.Fatalf("ForkReport from %d: %v", reporter, err)
		}
	}
	if h.hasOutstandingRemoveOfLeaf(t, g, g.leafOf(0)) {
		t.Fatal("a quorum against an instance handshake must remove nobody")
	}
}

// A report against a seq the log does not hold is recorded and quarantines nobody: the client's
// view of the log is not the instance's, and a fork report is a bug report, not an accusation the
// instance must be able to resolve.
func TestAForkQuorumAgainstAnUnknownSeqQuarantinesNobody(t *testing.T) {
	h := newDSHarness(t)
	g := h.groupWithMembers(t, 4)

	for _, reporter := range []int{1, 2, 3} {
		if err := h.ds.ForkReport(context.Background(), g.sessionOf(reporter), g.id, g.epoch(t), 9999, "cannot process"); err != nil {
			t.Fatalf("ForkReport from %d: %v", reporter, err)
		}
	}
	if n := h.countForkReporters(t, g, 9999); n != 3 {
		t.Fatalf("fork reporters = %d, want 3", n)
	}
}

// ---------------------------------------------------------------- the helpers

// acceptedCommitBy seeds the handshake log with the commit member `i` committed, and returns the
// same [seq, epoch] pair an accepted `DS.Commit` would have. It also writes the committer's
// `users` and `devices` rows: `QuarantineDevice` is an UPDATE on `devices`, and the fixture's
// members exist only as MLS leaves replayed into `mls_members` by Register, so without them the
// quarantine would be a silent no-op.
func (h *dsHarness) acceptedCommitBy(t *testing.T, g *dsGroup, i int) commitLogEntry {
	t.Helper()
	session := g.sessionOf(i)
	h.account(t, session.UserID, session.DeviceID)
	device := g.members[i]
	leaf := g.leaves[i]
	return commitLogEntry{Seq: h.seedHandshake(t, g, &device, &leaf), Epoch: g.epoch(t)}
}

type commitLogEntry struct {
	Seq   uint64
	Epoch uint64
}

// seedHandshake appends one commit handshake at the group's own next seq. A nil device is the
// instance's own external sender, which names no leaf either.
func (h *dsHarness) seedHandshake(t *testing.T, g *dsGroup, device *id.ID, leaf *uint32) uint64 {
	t.Helper()
	ctx := context.Background()
	seq, err := h.repo.NextSeq(ctx, g.id)
	if err != nil {
		t.Fatalf("NextSeq: %v", err)
	}
	if err := h.repo.AppendHandshake(ctx, store.HandshakeRow{
		GroupID:      g.id,
		Seq:          seq,
		Epoch:        g.epoch(t),
		Kind:         1, // commit
		SenderLeaf:   leaf,
		SenderDevice: device,
		Blob:         []byte{0x01},
		Created:      h.clk.Now().Unix(),
	}); err != nil {
		t.Fatalf("AppendHandshake: %v", err)
	}
	return seq
}

// isQuarantined reads the device's own row: invariant 9's "a flag on the device".
func (h *dsHarness) isQuarantined(t *testing.T, device id.ID) bool {
	t.Helper()
	row, err := h.repo.GetDevice(context.Background(), device)
	if err != nil {
		t.Fatalf("GetDevice: %v", err)
	}
	return row.QuarantinedAt != nil
}

// hasOutstandingRemoveOfLeaf is invariant 9's other half: the instance Remove of the quarantined
// committer's leaf.
func (h *dsHarness) hasOutstandingRemoveOfLeaf(t *testing.T, g *dsGroup, leaf uint32) bool {
	t.Helper()
	rows, err := h.ds.Outstanding(context.Background(), g.id)
	if err != nil {
		t.Fatalf("Outstanding: %v", err)
	}
	for _, r := range rows {
		if r.Origin != 0 || r.VoidAt != nil || r.Kind != uint8(mlswasi.ProposalRemove) {
			continue
		}
		if r.TargetLeaf != nil && *r.TargetLeaf == leaf {
			return true
		}
	}
	return false
}

func (h *dsHarness) countForkReporters(t *testing.T, g *dsGroup, seq uint64) int64 {
	t.Helper()
	n, err := h.repo.CountForkReporters(context.Background(), g.id, seq)
	if err != nil {
		t.Fatalf("CountForkReporters: %v", err)
	}
	return n
}

// sessionOf is the enrolled session of the group's i-th exposed member device, as
// `groupWithMembers` recorded it.
func (g *dsGroup) sessionOf(i int) auth.Session { return g.h.sessions[g.members[i]] }

// leafOf is the MLS leaf the i-th exposed member sits at.
func (g *dsGroup) leafOf(i int) uint32 { return g.leaves[i] }

// epoch is the group's current epoch, read back from SQL — R12's record.
func (g *dsGroup) epoch(t *testing.T) uint64 {
	t.Helper()
	row, err := g.h.repo.GetGroup(context.Background(), g.id)
	if err != nil {
		t.Fatalf("GetGroup: %v", err)
	}
	return row.Epoch
}
