package ds_test

// withdraw_test.go: UP6b (R-UP12), the withdrawal of an absence Remove, on the committed fixture
// (protocol/02 invariant 6, "Withdrawal"). The halves that need an accepted commit — the 409
// `withdrawn`, a commit that omits the withdrawn ref, the cross-epoch re-drive, the all-dropped
// call — run against a real instance with real clients in internal/testkit/withdrawn_test.go.

import (
	"bytes"
	"context"
	"errors"
	"testing"
	"time"

	"github.com/fxamacker/cbor/v2"

	"github.com/jonasthim/dilla/internal/cborx"
	"github.com/jonasthim/dilla/internal/ds"
	"github.com/jonasthim/dilla/internal/id"
	"github.com/jonasthim/dilla/internal/mlswasi"
	"github.com/jonasthim/dilla/internal/store"
)

// callGroupWithMembers is groupWithMembers as a call group: the 30 s call TTL and the call sweeper.
func (h *dsHarness) callGroupWithMembers(t *testing.T, n int) *dsGroup {
	t.Helper()
	g := h.groupWithMembers(t, n)
	h.repo.markCall(g.id)
	ds.MarkCallWorkForTest(h.ds, g.id)
	return g
}

// membershipOf is the (leaf, added epoch) member i of g holds now.
func (h *dsHarness) membershipOf(t *testing.T, g *dsGroup, i int) (uint32, uint64) {
	t.Helper()
	members, err := h.repo.ListMembers(context.Background(), g.id)
	if err != nil {
		t.Fatalf("ListMembers: %v", err)
	}
	for _, m := range members {
		if m.DeviceID == g.members[i] && m.RemovedEpoch == nil {
			return m.LeafIndex, m.AddedEpoch
		}
	}
	t.Fatalf("member %d holds no leaf", i)
	return 0, 0
}

// absent issues the room sweep's Remove of member i (ds.ProposeAbsenceRemove) and returns its row.
func (h *dsHarness) absent(t *testing.T, g *dsGroup, i int) store.ProposalRow {
	t.Helper()
	leaf, added := h.membershipOf(t, g, i)
	if err := h.ds.ProposeAbsenceRemove(context.Background(), g.id, leaf, g.members[i], added, id.New()); err != nil {
		t.Fatalf("ProposeAbsenceRemove(member %d): %v", i, err)
	}
	row, ok := h.instanceRemoveOf(t, g, leaf, true)
	if !ok {
		t.Fatalf("no instance Remove of member %d's leaf after ProposeAbsenceRemove", i)
	}
	return row
}

// resume runs member i's own withdrawal (the call start's last step before the mint).
func (h *dsHarness) resume(t *testing.T, g *dsGroup, i int) (int, error) {
	t.Helper()
	leaf, added := h.membershipOf(t, g, i)
	return h.ds.WithdrawAbsenceRemoves(context.Background(), g.id, g.members[i], leaf, added)
}

// instanceRemoveOf is the unwithdrawn instance Remove of leaf at the group's epoch.
func (h *dsHarness) instanceRemoveOf(t *testing.T, g *dsGroup, leaf uint32, includeVoid bool) (store.ProposalRow, bool) {
	t.Helper()
	ctx := context.Background()
	row, err := h.repo.GetGroup(ctx, g.id)
	if err != nil {
		t.Fatalf("GetGroup: %v", err)
	}
	rows, err := h.repo.ListProposals(ctx, g.id, row.Epoch, includeVoid)
	if err != nil {
		t.Fatalf("ListProposals: %v", err)
	}
	for _, r := range rows {
		if r.Origin == 0 && mlswasi.ProposalKind(r.Kind) == mlswasi.ProposalRemove && r.TargetLeaf != nil && *r.TargetLeaf == leaf {
			return r, true
		}
	}
	return store.ProposalRow{}, false
}

func (h *dsHarness) withdrawnRows(t *testing.T, g *dsGroup) []store.ProposalRow {
	t.Helper()
	ctx := context.Background()
	row, err := h.repo.GetGroup(ctx, g.id)
	if err != nil {
		t.Fatalf("GetGroup: %v", err)
	}
	rows, err := h.repo.ListWithdrawnProposals(ctx, g.id, row.Epoch)
	if err != nil {
		t.Fatalf("ListWithdrawnProposals: %v", err)
	}
	return rows
}

// handshakesOfKind is every row of kind in the group's log.
func (h *dsHarness) handshakesOfKind(t *testing.T, g *dsGroup, kind uint8) []store.HandshakeRow {
	t.Helper()
	rows, err := h.repo.ListHandshakes(context.Background(), g.id, 0, 512)
	if err != nil {
		t.Fatalf("ListHandshakes: %v", err)
	}
	var out []store.HandshakeRow
	for _, r := range rows {
		if r.Kind == kind {
			out = append(out, r)
		}
	}
	return out
}

// withdrawnRef decodes a kind-3 row's blob, [proposal_ref(bstr)].
func withdrawnRef(t *testing.T, blob []byte) []byte {
	t.Helper()
	var arr []cbor.RawMessage
	if err := cborx.Unmarshal(blob, &arr); err != nil || len(arr) != 1 {
		t.Fatalf("the withdrawn blob %x is not a one-element array: %v", blob, err)
	}
	var ref []byte
	if err := cborx.Unmarshal(arr[0], &ref); err != nil {
		t.Fatalf("the withdrawn blob's element: %v", err)
	}
	return ref
}

// The resume withdraws the device's own absence Remove: it leaves every listing (the freeze, the
// count the election reads), is marked with the kind-3 row's seq, and the row names its ref.
func TestAResumeWithdrawsItsOwnAbsenceRemove(t *testing.T) {
	h := newDSHarness(t)
	g := h.callGroupWithMembers(t, 3)
	removed := h.absent(t, g, 1)
	if !removed.Withdrawable {
		t.Fatal("the absence Remove is not withdrawable")
	}
	n, err := h.resume(t, g, 1)
	if err != nil || n != 1 {
		t.Fatalf("WithdrawAbsenceRemoves = %d, %v; want 1", n, err)
	}
	if _, ok := h.instanceRemoveOf(t, g, *removed.TargetLeaf, true); ok {
		t.Fatal("the withdrawn Remove is still listed")
	}
	w := h.withdrawnRows(t, g)
	rows := h.handshakesOfKind(t, g, 3)
	if len(w) != 1 || len(rows) != 1 || !bytes.Equal(w[0].Ref, removed.Ref) || w[0].WithdrawnSeq == nil || *w[0].WithdrawnSeq != rows[0].Seq {
		t.Fatalf("withdrawn %+v, kind-3 rows %+v; want one, marked with the row's seq", w, rows)
	}
	if rows[0].SenderLeaf != nil || rows[0].SenderDevice != nil || !bytes.Equal(withdrawnRef(t, rows[0].Blob), removed.Ref) {
		t.Fatalf("the kind-3 row %+v: want sender null and the blob [ref %x]", rows[0], removed.Ref)
	}
	// A second resume finds nothing left to withdraw.
	if n, err := h.resume(t, g, 1); err != nil || n != 0 {
		t.Fatalf("a second resume = %d, %v; want 0", n, err)
	}
}

// A resume withdraws only its own Remove: another member's outstanding absence Remove stays
// outstanding ("Only its own").
func TestAResumeWithdrawsOnlyItsOwnRemove(t *testing.T) {
	h := newDSHarness(t)
	g := h.callGroupWithMembers(t, 3)
	own := h.absent(t, g, 1)
	other := h.absent(t, g, 2)
	if n, err := h.resume(t, g, 1); err != nil || n != 1 {
		t.Fatalf("resume = %d, %v; want 1", n, err)
	}
	if _, ok := h.instanceRemoveOf(t, g, *own.TargetLeaf, true); ok {
		t.Fatal("the resumer's own Remove is still outstanding")
	}
	if r, ok := h.instanceRemoveOf(t, g, *other.TargetLeaf, false); !ok || !bytes.Equal(r.Ref, other.Ref) {
		t.Fatal("another member's Remove is no longer outstanding: a resume withdrew it")
	}
}

// Correction I3: the resumer's own Remove, voided by its TTL and not yet re-driven, is withdrawn,
// so the call sweeper's re-drive does not resurrect it.
func TestWithdrawVoidedNotRedriven(t *testing.T) {
	h := newDSHarness(t)
	ctx := context.Background()
	g := h.callGroupWithMembers(t, 3)
	removed := h.absent(t, g, 1)
	if err := h.ds.Void(ctx, g.id, removed.Ref); err != nil {
		t.Fatalf("Void: %v", err)
	}
	if r, ok := h.instanceRemoveOf(t, g, *removed.TargetLeaf, true); !ok || r.VoidAt == nil {
		t.Fatal("the Remove is not voided")
	}
	if n, err := h.resume(t, g, 1); err != nil || n != 1 {
		t.Fatalf("resume = %d, %v; want the voided Remove withdrawn", n, err)
	}
	for range 3 {
		h.clk.Advance(31 * time.Second)
		if _, err := ds.SweepCallProposalsForTest(h.ds, ctx); err != nil {
			t.Fatalf("SweepCallProposals: %v", err)
		}
	}
	if r, ok := h.instanceRemoveOf(t, g, *removed.TargetLeaf, true); ok {
		t.Fatalf("the re-drive resurrected the withdrawn Remove: %+v", r)
	}
	if w := h.withdrawnRows(t, g); len(w) != 1 {
		t.Fatalf("%d withdrawn rows, want the one", len(w))
	}
}

// Correction I1: a sweep Remove flushed just after the withdrawal, inside admissionJoinWindow, is a
// no-op (the same deterministic ref), and the device stays in.
func TestFlushRaceAfterWithdrawal(t *testing.T) {
	h := newDSHarness(t)
	g := h.callGroupWithMembers(t, 3)
	removed := h.absent(t, g, 1)
	if _, err := h.resume(t, g, 1); err != nil {
		t.Fatalf("resume: %v", err)
	}
	h.clk.Advance(ds.WithdrawnStandWindow - time.Second)
	before := len(h.handshakesOfKind(t, g, 0))
	leaf, added := h.membershipOf(t, g, 1)
	if err := h.ds.ProposeAbsenceRemove(context.Background(), g.id, leaf, g.members[1], added, id.New()); err != nil {
		t.Fatalf("the late flush: %v", err)
	}
	if _, ok := h.instanceRemoveOf(t, g, *removed.TargetLeaf, true); ok {
		t.Fatal("the late flush re-armed the Remove inside the window")
	}
	if after := len(h.handshakesOfKind(t, g, 0)); after != before {
		t.Fatalf("the late flush appended %d kind-0 rows, want none", after-before)
	}
	if w := h.withdrawnRows(t, g); len(w) != 1 {
		t.Fatalf("%d withdrawn rows, want the one still standing", len(w))
	}
	if l, _ := h.membershipOf(t, g, 1); l != leaf {
		t.Fatal("the device lost its leaf")
	}
}

// Correction I1: after the window, the re-proposal re-arms the row — no longer withdrawn, still
// withdrawable, issued now — and appends a kind-0 row with the same proposal; a second resume
// withdraws it again. (TestResumeThenLeaveIsRemoved commits it against a real instance.)
func TestSecondResumeWithdrawsAgain(t *testing.T) {
	h := newDSHarness(t)
	ctx := context.Background()
	g := h.callGroupWithMembers(t, 3)
	removed := h.absent(t, g, 1)
	if _, err := h.resume(t, g, 1); err != nil {
		t.Fatalf("resume: %v", err)
	}
	h.clk.Advance(ds.WithdrawnStandWindow + time.Second)
	before := h.handshakesOfKind(t, g, 0)
	leaf, added := h.membershipOf(t, g, 1)
	if err := h.ds.ProposeAbsenceRemove(ctx, g.id, leaf, g.members[1], added, id.New()); err != nil {
		t.Fatalf("the re-proposal: %v", err)
	}
	rearmed, ok := h.instanceRemoveOf(t, g, leaf, false)
	if !ok || !bytes.Equal(rearmed.Ref, removed.Ref) || !rearmed.Withdrawable || rearmed.WithdrawnAt != nil ||
		rearmed.IssuedAt != h.clk.Now().Unix() || rearmed.ActionID != removed.ActionID {
		t.Fatalf("re-armed %+v: want live, the same ref and action, withdrawable, unmarked, issued now", rearmed)
	}
	if w := h.withdrawnRows(t, g); len(w) != 0 {
		t.Fatalf("%d withdrawn rows after the re-arm, want none", len(w))
	}
	after := h.handshakesOfKind(t, g, 0)
	if len(after) != len(before)+1 {
		t.Fatalf("%d kind-0 rows after the re-arm, want one more than %d", len(after), len(before))
	}
	if !h.guestHolds(t, g.id, removed.Ref, false) {
		t.Fatal("the guest no longer holds the re-armed proposal")
	}
	if n, err := h.resume(t, g, 1); err != nil || n != 1 {
		t.Fatalf("the second resume = %d, %v; want the re-armed Remove withdrawn again", n, err)
	}
	if rows := h.handshakesOfKind(t, g, 3); len(rows) != 2 {
		t.Fatalf("%d kind-3 rows, want 2", len(rows))
	}
}

// Attack: only a withdrawable Remove can be withdrawn. A revocation's, a kick's (ProposeRemoveDevice)
// or any other instance Remove of the same leaf stays outstanding through the device's resume.
func TestANonAbsenceRemoveCannotBeWithdrawn(t *testing.T) {
	h := newDSHarness(t)
	ctx := context.Background()
	g := h.callGroupWithMembers(t, 3)
	if err := h.ds.ProposeRemoveDevice(ctx, g.id, g.members[1], id.New()); err != nil {
		t.Fatalf("ProposeRemoveDevice: %v", err)
	}
	leaf, _ := h.membershipOf(t, g, 1)
	kick, ok := h.instanceRemoveOf(t, g, leaf, false)
	if !ok || kick.Withdrawable {
		t.Fatalf("the kick's Remove %+v: want outstanding and not withdrawable", kick)
	}
	if n, err := h.resume(t, g, 1); err != nil || n != 0 {
		t.Fatalf("resume = %d, %v; want nothing withdrawn", n, err)
	}
	if _, ok := h.instanceRemoveOf(t, g, leaf, false); !ok {
		t.Fatal("the kick's Remove was withdrawn")
	}
	// The kick re-arming a withdrawn absence Remove of the same leaf (the same deterministic ref)
	// makes it a Remove no resume can withdraw.
	h2 := newDSHarness(t)
	g2 := h2.callGroupWithMembers(t, 3)
	h2.absent(t, g2, 1)
	if _, err := h2.resume(t, g2, 1); err != nil {
		t.Fatalf("resume: %v", err)
	}
	if err := h2.ds.ProposeRemoveDevice(ctx, g2.id, g2.members[1], id.New()); err != nil {
		t.Fatalf("ProposeRemoveDevice: %v", err)
	}
	leaf2, _ := h2.membershipOf(t, g2, 1)
	if r, ok := h2.instanceRemoveOf(t, g2, leaf2, false); !ok || r.Withdrawable {
		t.Fatalf("the kick over a withdrawn absence Remove %+v: want live and not withdrawable", r)
	}
	if n, err := h2.resume(t, g2, 1); err != nil || n != 0 {
		t.Fatalf("resume after the kick = %d, %v; want nothing withdrawn", n, err)
	}
}

// A resume from a device whose membership is gone withdraws nothing: ErrMembershipGone (the start
// answers E_LEAF_NOT_CURRENT), for a device that never held the leaf and for a stale added epoch.
func TestAResumeOfAGoneMembershipWithdrawsNothing(t *testing.T) {
	h := newDSHarness(t)
	ctx := context.Background()
	g := h.callGroupWithMembers(t, 3)
	h.absent(t, g, 1)
	leaf, added := h.membershipOf(t, g, 1)
	for name, call := range map[string]func() (int, error){
		"another device": func() (int, error) { return h.ds.WithdrawAbsenceRemoves(ctx, g.id, id.New(), leaf, added) },
		"a later epoch":  func() (int, error) { return h.ds.WithdrawAbsenceRemoves(ctx, g.id, g.members[1], leaf, added+1) },
		"another leaf":   func() (int, error) { return h.ds.WithdrawAbsenceRemoves(ctx, g.id, g.members[1], leaf+1000, added) },
	} {
		if n, err := call(); !errors.Is(err, ds.ErrMembershipGone) || n != 0 {
			t.Fatalf("%s: %d, %v; want ErrMembershipGone", name, n, err)
		}
	}
	if _, ok := h.instanceRemoveOf(t, g, leaf, false); !ok {
		t.Fatal("a refused resume withdrew the Remove")
	}
	if rows := h.handshakesOfKind(t, g, 3); len(rows) != 0 {
		t.Fatalf("%d kind-3 rows, want none", len(rows))
	}
}

// The capability filter (M2): only a connection that set caps bit 0 receives the kind-3 row on the
// op 16 fan-out, and GET …/handshakes serves it only with kinds=3; every other client sees the gap.
func TestTheWithdrawnRowReachesOnlyBitZero(t *testing.T) {
	h := newDSHarness(t)
	ctx := context.Background()
	g := h.callGroupWithMembers(t, 4)
	h.connectCaps(g.members[0], 1)
	h.connectCaps(g.members[2], 0)
	h.absent(t, g, 1)
	// Both see the kind-0 row of the Remove.
	for _, d := range []id.ID{g.members[0], g.members[2]} {
		if f := h.waitDeviceFrame(t, d, "mls.handshake"); handshakeKind(t, f) != 0 {
			t.Fatalf("the first handshake frame is kind %d, want the Remove's kind 0", handshakeKind(t, f))
		}
	}
	if _, err := h.resume(t, g, 1); err != nil {
		t.Fatalf("resume: %v", err)
	}
	if f := h.waitDeviceFrame(t, g.members[0], "mls.handshake"); handshakeKind(t, f) != 3 {
		t.Fatalf("the bit-0 connection got kind %d, want 3", handshakeKind(t, f))
	}
	h.expectNoHandshakeOfKind(t, g.members[2], 3)

	session := h.sessions[g.members[0]]
	without, err := h.ds.Handshakes(ctx, g.id, session, 0, 512)
	if err != nil {
		t.Fatalf("Handshakes: %v", err)
	}
	with, err := h.ds.HandshakesFor(ctx, g.id, session, 0, 512, true)
	if err != nil {
		t.Fatalf("HandshakesFor: %v", err)
	}
	if len(with) != len(without)+1 {
		t.Fatalf("%d rows with kinds=3 and %d without; want exactly the kind-3 row more", len(with), len(without))
	}
	for _, r := range without {
		if r.Kind == 3 {
			t.Fatal("the catch-up without kinds=3 served a kind-3 row")
		}
	}
}

// Invariant 7: in an epoch that holds a withdrawal, a device without caps bit 0 is never elected; one
// with it is.
func TestTheElectionSkipsADeviceWithoutBitZeroAfterAWithdrawal(t *testing.T) {
	h := newDSHarness(t)
	g := h.callGroupWithMembers(t, 4)
	h.setLeaves(g, map[int]uint32{0: 0, 2: 2, 3: 3})
	h.connectCaps(g.members[0], 0) // the lowest leaf, an old tab
	h.connectCaps(g.members[2], 1)
	h.absent(t, g, 1)
	h.absent(t, g, 3)
	// Before the withdrawal the lowest leaf online is elected, whatever its caps.
	h.waitDeviceFrame(t, g.members[0], "mls.commit_needed")
	h.expectNoCommitNeeded(t, g.members[0])
	if _, err := h.resume(t, g, 1); err != nil {
		t.Fatalf("resume: %v", err)
	}
	h.waitDeviceFrame(t, g.members[2], "mls.commit_needed")
	if err := h.ds.RequestCommit(context.Background(), g.id); err != nil {
		t.Fatalf("RequestCommit: %v", err)
	}
	h.expectNoCommitNeeded(t, g.members[0])
}

// handshakeKind reads element 2 of an op 16 payload.
func handshakeKind(t *testing.T, f recordedFrame) uint64 {
	t.Helper()
	if len(f.payload) != 5 {
		t.Fatalf("op 16 payload has %d elements", len(f.payload))
	}
	var kind uint64
	if err := cborx.Unmarshal(f.payload[2], &kind); err != nil {
		t.Fatalf("kind: %v", err)
	}
	return kind
}

// expectNoHandshakeOfKind drains what device has received and fails on any op 16 of kind.
func (h *dsHarness) expectNoHandshakeOfKind(t *testing.T, device id.ID, kind uint64) {
	t.Helper()
	c := h.connOf(t, device)
	deadline := time.After(300 * time.Millisecond)
	for {
		select {
		case f := <-c.frames:
			if f.op == 16 && handshakeKind(t, f) == kind {
				t.Fatalf("device %s received a kind-%d handshake", device.String()[:8], kind)
			}
		case <-deadline:
			return
		}
	}
}

// expectNoCommitNeeded drains what device has received and fails on any mls.commit_needed.
func (h *dsHarness) expectNoCommitNeeded(t *testing.T, device id.ID) {
	t.Helper()
	c := h.connOf(t, device)
	deadline := time.After(300 * time.Millisecond)
	for {
		select {
		case f := <-c.frames:
			if f.name == "mls.commit_needed" {
				t.Fatalf("device %s was elected", device.String()[:8])
			}
		case <-deadline:
			return
		}
	}
}
