package ds_test

import (
	"context"
	"testing"

	"github.com/jonasthim/dilla/internal/ds"
	"github.com/jonasthim/dilla/internal/id"
	"github.com/jonasthim/dilla/internal/mlswasi"
)

// C3 (fix wave): a kick, ban or leave issues its Removes after the change commits, and a Remove
// that never got issued (a crash, a fault in the middle of the loop) has nothing else to re-drive
// it: the ACL only gates Adds and joins, and the inactivity sweep skips active devices. So the
// sweeper reconciles: every live leaf of an open text or call group whose user the ACL no longer
// admits gets an instance Remove, once, and an eligible user's leaves are left alone.
func TestTheSweeperRemovesTheLeavesOfAUserWhoLostAccess(t *testing.T) {
	h := newDSHarness(t)
	ctx := context.Background()
	reg, _ := h.mustRegister(t)
	banned := h.memberSession(t, reg.GroupID, 5).UserID
	h.acl.forbid(banned)

	members, err := h.repo.ListMembers(ctx, reg.GroupID)
	if err != nil {
		t.Fatalf("ListMembers: %v", err)
	}
	want := map[uint32]bool{}
	for _, m := range members {
		if m.UserID == banned && m.RemovedEpoch == nil {
			want[m.LeafIndex] = true
		}
	}

	n, err := ds.ReconcileLeavesForTest(h.ds, ctx)
	if err != nil {
		t.Fatalf("reconcile: %v", err)
	}
	if n != len(want) {
		t.Fatalf("reconcile proposed %d Removes, want %d (one per live leaf of the banned user)", n, len(want))
	}
	rows, err := h.repo.ListProposals(ctx, reg.GroupID, 6, false)
	if err != nil {
		t.Fatalf("ListProposals: %v", err)
	}
	got := map[uint32]bool{}
	for _, r := range rows {
		if mlswasi.ProposalKind(r.Kind) != mlswasi.ProposalRemove || r.TargetLeaf == nil {
			t.Fatalf("reconcile proposed something other than a Remove: %+v", r)
		}
		if !want[*r.TargetLeaf] {
			t.Fatalf("reconcile removed leaf %d, which is not the banned user's", *r.TargetLeaf)
		}
		got[*r.TargetLeaf] = true
	}
	if len(got) != len(want) {
		t.Fatalf("Removes for leaves %v, want %v", got, want)
	}

	// A second pass finds the Removes outstanding and issues nothing more.
	if n, err := ds.ReconcileLeavesForTest(h.ds, ctx); err != nil || n != 0 {
		t.Fatalf("a second reconcile proposed %d (%v), want 0", n, err)
	}
}

// A group in which the ACL admits nobody at all (the leftover of a deleted channel whose Close was
// lost) is not emptied leaf by leaf: nobody could commit those Removes.
func TestTheSweeperLeavesAGroupWithNoEligibleMemberAlone(t *testing.T) {
	h := newDSHarness(t)
	ctx := context.Background()
	reg, _ := h.mustRegister(t)
	members, err := h.repo.ListMembers(ctx, reg.GroupID)
	if err != nil {
		t.Fatalf("ListMembers: %v", err)
	}
	seen := map[id.ID]bool{}
	for _, m := range members {
		if !seen[m.UserID] {
			seen[m.UserID] = true
			h.acl.forbid(m.UserID)
		}
	}
	if n, err := ds.ReconcileLeavesForTest(h.ds, ctx); err != nil || n != 0 {
		t.Fatalf("reconcile over a group nobody may be in proposed %d (%v), want 0", n, err)
	}
}
