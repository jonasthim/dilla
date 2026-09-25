package ds_test

// resync_test.go is R25: the own-leaf external commit that brings a device which has fallen out of
// the epoch back, exempt from invariant 5's freeze under two guards.
//
// DEVIATION FROM THE BRIEF'S STEP 1 (recorded in the task-25 report). The brief's first and third
// tests drive an ACCEPTED external commit through `h.resyncOf` / `h.resyncRemovingLeaf`. Neither
// fixture nor ABI can produce one:
//
//   - `testkit/fixtures/ds-1500` ships exactly one GroupInfo, at epoch 6, and invariant 4's step
//     (6) wants epoch n+1 — the blocker `commit_test.go` records in two skips and the plan in
//     deviations B21 and B24.
//   - the fixture holds no external commit at all, and `internal/mlswasi.Processed` carries no
//     field naming the joiner's NEW leaf, so commit step (6) — which needs the signer leaf to
//     validate the GroupInfo, because `VerifiableGroupInfo::signer()` is `pub(crate)` (D17) —
//     cannot be satisfied on the external path by any material this repository holds.
//
// So the happy path is one honest skip naming both blockers, and everything R25 states that IS
// reachable is asserted for real against the real store and the real guest: guard 1 in full, the
// freeze exemption in full, and guard 2 over the applied list its own clause is defined on.

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/jonasthim/dilla/internal/ds"
	"github.com/jonasthim/dilla/internal/id"
	"github.com/jonasthim/dilla/internal/mlswasi"
)

// R25: a resync succeeds DURING a freeze, and the outstanding proposals are re-issued for the new
// epoch afterwards. Making the one device that cannot act wait on a membership commit deadlocks
// exactly that device.
func TestAResyncSucceedsDuringAFreezeAndReissuesTheProposals(t *testing.T) {
	t.Skip("needs an ACCEPTED external commit, which nothing in this repository can produce: " +
		"testkit/fixtures/ds-1500 ships one GroupInfo (group_info.mls, epoch 6) where invariant 4 " +
		"wants epoch n+1 (the blocker commit_test.go and proposal_test.go already record in three " +
		"skips), it holds no external commit, and mlswasi.Processed names no NEW leaf for the " +
		"joiner, so commit step (6) cannot check the GroupInfo's signer on the external path at " +
		"all. TestAResyncIsExemptFromTheFreeze below asserts the half of this test that does not " +
		"need the commit to be accepted")
}

// The freeze exemption itself, without an acceptable commit: a resync during a live freeze is NOT
// refused with E_COMMIT_REQUIRED. It is refused later, by the parse, and that is the whole point —
// `commitOptions.skipFreeze` carried R25 past invariant 5's clause. `Frozen` is asserted true
// first, so a green run cannot be a group that was never frozen.
func TestAResyncIsExemptFromTheFreeze(t *testing.T) {
	h := newDSHarness(t)
	g := h.groupWithMembers(t, 2)
	h.online(g.members[0], g.members[1])
	if frozen, err := h.ds.Frozen(context.Background(), g.id); err != nil || !frozen {
		t.Fatalf("Frozen = %v, %v; the group must be frozen for this test to mean anything", frozen, err)
	}

	_, err := h.ds.Resync(context.Background(), g.sessionOf(0), g.id, ds.ResyncRequest{
		ExternalCommit: []byte{0x00, 0x01, 0x02},
		GroupInfo:      []byte{0x03},
	})
	var dsErr *ds.Error
	if !errors.As(err, &dsErr) {
		t.Fatalf("got %v, want a *ds.Error", err)
	}
	if dsErr.Code == "E_COMMIT_REQUIRED" {
		t.Fatal("a resync must be exempt from the freeze, not refused by it")
	}
	if dsErr.Code != "E_COMMIT_INVALID" {
		t.Fatalf("got %s, want E_COMMIT_INVALID from the parse", dsErr.Code)
	}
}

// Guard 1: a resync by the target of an outstanding non-void Remove is E_FORBIDDEN.
func TestAResyncByTheTargetOfAnOutstandingRemoveIsForbidden(t *testing.T) {
	h := newDSHarness(t)
	g := h.groupWithMembers(t, 2)
	if err := h.ds.ProposeRemove(context.Background(), g.id, g.leafOf(1), id.New()); err != nil {
		t.Fatalf("ProposeRemove: %v", err)
	}
	_, err := h.ds.Resync(context.Background(), g.sessionOf(1), g.id, ds.ResyncRequest{
		ExternalCommit: []byte{0x00},
		GroupInfo:      []byte{0x01},
	})
	var dsErr *ds.Error
	if !errors.As(err, &dsErr) || dsErr.Code != "E_FORBIDDEN" {
		t.Fatalf("got %v, want E_FORBIDDEN", err)
	}
}

// …and a device that is NOT the target is not refused by guard 1: the same group, the same
// outstanding Remove, a different session.
func TestAResyncByADeviceThatIsNotTheRemoveTargetPassesTheGuard(t *testing.T) {
	h := newDSHarness(t)
	g := h.groupWithMembers(t, 2)
	if err := h.ds.ProposeRemove(context.Background(), g.id, g.leafOf(1), id.New()); err != nil {
		t.Fatalf("ProposeRemove: %v", err)
	}
	_, err := h.ds.Resync(context.Background(), g.sessionOf(0), g.id, ds.ResyncRequest{
		ExternalCommit: []byte{0x00},
		GroupInfo:      []byte{0x01},
	})
	var dsErr *ds.Error
	if !errors.As(err, &dsErr) || dsErr.Code != "E_COMMIT_INVALID" {
		t.Fatalf("got %v, want the parse's E_COMMIT_INVALID, not guard 1's refusal", err)
	}
}

// Guard 2: an external commit whose inner Remove targets a leaf that is not the joiner's own
// device is refused.
//
// The clause is asserted over the applied list it is defined on rather than over an accepted
// external commit, for the reason this file's header gives.
func TestAnExternalCommitRemovingSomebodyElseIsRefused(t *testing.T) {
	h := newDSHarness(t)
	g := h.groupWithMembers(t, 2)
	other := g.leafOf(1)
	err := ds.CheckExternalCommitScopeForTest(h.ds, context.Background(), g.id, g.sessionOf(0),
		[]mlswasi.AppliedProposal{{Kind: mlswasi.ProposalRemove, TargetLeaf: &other}})
	var dsErr *ds.Error
	if !errors.As(err, &dsErr) || dsErr.Code != "E_COMMIT_INVALID" {
		t.Fatalf("got %v, want E_COMMIT_INVALID", err)
	}
	if dsErr.Rule != "external_commit_remove_scope" {
		t.Fatalf("rule = %q, want external_commit_remove_scope", dsErr.Rule)
	}
}

// …and the joiner's OWN previous leaf is exactly what R25 allows it to remove.
func TestAnExternalCommitRemovingTheJoinersOwnLeafIsAccepted(t *testing.T) {
	h := newDSHarness(t)
	g := h.groupWithMembers(t, 2)
	own := g.leafOf(0)
	if err := ds.CheckExternalCommitScopeForTest(h.ds, context.Background(), g.id, g.sessionOf(0),
		[]mlswasi.AppliedProposal{{Kind: mlswasi.ProposalRemove, TargetLeaf: &own}}); err != nil {
		t.Fatalf("an external commit may remove the joiner's own previous leaf: %v", err)
	}
}

// Deviation B24 / ruling 45, carried here from task 22: `reissueOmitted` runs with the group lock
// HELD and outside `withGroup`, and everything it reaches must therefore be lock-free. The timeout
// is the assertion — if any path from `reissue` through `storeInstanceProposal` to
// `RequestCommit` ever takes `d.lock(groupID)` again, this hangs.
//
// It is driven through the same lock-held entry the commit path uses rather than through an
// accepted commit, for the reason this file's header gives: no commit in this repository can be
// accepted, which is exactly why task 22 could not write it.
func TestACommitThatReissuesAnOmittedRemoveDoesNotDeadlock(t *testing.T) {
	h := newDSHarness(t)
	g := h.groupWithMembers(t, 2)
	if err := h.ds.ProposeRemove(context.Background(), g.id, g.leafOf(1), id.New()); err != nil {
		t.Fatalf("ProposeRemove: %v", err)
	}

	done := make(chan error, 1)
	go func() {
		// Nothing applied: every outstanding instance proposal was omitted, which is the shape
		// invariant 5's nobody-online exception leaves behind.
		done <- ds.ReissueOmittedUnderLockForTest(h.ds, context.Background(), g.id, g.epoch(t), nil)
	}()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("reissueOmitted under the group lock: %v", err)
		}
	case <-time.After(20 * time.Second):
		t.Fatal("re-issuing an omitted Remove under the group lock deadlocked")
	}
}
