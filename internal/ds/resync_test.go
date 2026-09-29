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
//   - the fixture holds no external commit at all. (Task 27a closed the ABI half, deviation
//     B33: `mlswasi.Processed.NewLeaf` names the joiner's leaf and `ValidateStagedGroupInfo`
//     checks its GroupInfo under the key its commit brings, so commit step (6) is satisfiable
//     on the external path; `core/dilla-core-wasi`'s
//     `an_external_commit_reports_the_leaf_the_joiner_lands_on` drives a real external commit
//     through both. What is still missing is external-commit material a Go test can hold,
//     which Ruling C assigns to task 29's harness.)
//
// So everything R25 states that IS reachable from here is asserted for real against the real store
// and the real guest: guard 1 in full, the freeze exemption in full, and guard 2 over the applied
// list its own clause is defined on. The happy path — an accepted resync during a freeze, and the
// re-issue after it — shipped here as a skip and is now task 29's harness-driven
// TestAResyncSucceedsDuringAFreezeAndReissuesTheProposals in internal/testkit/accepted_test.go,
// where real dilla-core clients produce the external commit (Ruling C(5)).

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/jonasthim/dilla/internal/ds"
	"github.com/jonasthim/dilla/internal/id"
	"github.com/jonasthim/dilla/internal/mlswasi"
)

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

// `reissueAll` elects a committer only when it actually re-issued something.
//
// On the resync path `commitLocked` step (9) has already run `reissueOmitted`, which replaces the
// outstanding rows at the NEW epoch and whose every re-issue goes through `storeInstanceProposal`
// -> `RequestCommit`. `reissueAll` then lists at `epoch-1`, finds nothing — and an unconditional
// `RequestCommit` at that point is not a no-op: `beginRound` ADVANCES the round and picks the next
// untried candidate, so the resync fires one extra election round that skips past the lowest-index
// online device invariant 7 names and invalidates the round the just-elected candidate was told to
// ack.
func TestAResyncsReissueDoesNotFireAnElectionRoundForWorkItDidNotReissue(t *testing.T) {
	h := newDSHarness(t)
	g := h.groupWithMembers(t, 2)
	h.online(g.members[0], g.members[1])
	if err := h.ds.ProposeRemove(context.Background(), g.id, g.leafOf(1), id.New()); err != nil {
		t.Fatalf("ProposeRemove: %v", err)
	}
	round := h.ds.CurrentRound(g.id)
	if round == 0 {
		t.Fatal("the instance Remove must have armed an election for this test to mean anything")
	}

	// The epoch BELOW the group's own holds no outstanding proposal, which is the shape step (9)
	// leaves behind on every ordinary resync.
	if err := ds.ReissueAllUnderLockForTest(h.ds, context.Background(), g.id, g.epoch(t)); err != nil {
		t.Fatalf("reissueAll: %v", err)
	}
	if got := h.ds.CurrentRound(g.id); got != round {
		t.Fatalf("round = %d after re-issuing nothing, want %d: the resync fired a spurious election round", got, round)
	}
}

// …and when it DOES re-issue, the new epoch's work gets a committer: the belt-and-braces half of
// the loop is still wired to an election.
func TestAResyncsReissueElectsACommitterForWhatItReissued(t *testing.T) {
	h := newDSHarness(t)
	g := h.groupWithMembers(t, 2)
	h.online(g.members[0], g.members[1])
	if err := h.ds.ProposeRemove(context.Background(), g.id, g.leafOf(1), id.New()); err != nil {
		t.Fatalf("ProposeRemove: %v", err)
	}
	round := h.ds.CurrentRound(g.id)

	// One epoch ABOVE the group's own, so the list at `epoch-1` is the outstanding work itself.
	if err := ds.ReissueAllUnderLockForTest(h.ds, context.Background(), g.id, g.epoch(t)+1); err != nil {
		t.Fatalf("reissueAll: %v", err)
	}
	if got := h.ds.CurrentRound(g.id); got <= round {
		t.Fatalf("round = %d after re-issuing, want above %d", got, round)
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
