package ds_test

// withdraw_taint_test.go: the security fixes to UP6b's withdrawable flag. Only an absence-only
// Remove is withdrawable; a deliberate Remove of the same leaf (a kick, a ban, a revocation, a device
// removal) taints it for good, whichever came first, and no re-arm, re-issue or re-drive makes a
// non-withdrawable Remove withdrawable.

import (
	"bytes"
	"context"
	"testing"
	"time"

	"github.com/jonasthim/dilla/internal/ds"
	"github.com/jonasthim/dilla/internal/id"
)

// Security fix 1: a deliberate Remove of a leaf whose absence Remove already stands is folded into
// it, and the standing row loses its withdrawable flag for good, by every deliberate path. The
// device's resume then withdraws nothing. (TestAKickAbsorbedByAnAbsenceRemoveIsCommitted commits it
// against a real instance.)
func TestADeliberateRemoveTaintsAStandingAbsenceRemove(t *testing.T) {
	for name, deliberate := range map[string]func(h *dsHarness, g *dsGroup, leaf uint32, added uint64) error{
		"ProposeRemove": func(h *dsHarness, g *dsGroup, leaf uint32, _ uint64) error {
			return h.ds.ProposeRemove(context.Background(), g.id, leaf, id.New())
		},
		"ProposeRemoveOf": func(h *dsHarness, g *dsGroup, leaf uint32, _ uint64) error {
			return h.ds.ProposeRemoveOf(context.Background(), g.id, leaf, g.members[1], id.New())
		},
		"ProposeRemoveOfMember": func(h *dsHarness, g *dsGroup, leaf uint32, added uint64) error {
			return h.ds.ProposeRemoveOfMember(context.Background(), g.id, leaf, g.members[1], added, id.New())
		},
		"ProposeRemoveDevice": func(h *dsHarness, g *dsGroup, _ uint32, _ uint64) error {
			return h.ds.ProposeRemoveDevice(context.Background(), g.id, g.members[1], id.New())
		},
	} {
		t.Run(name, func(t *testing.T) {
			h := newDSHarness(t)
			g := h.callGroupWithMembers(t, 3)
			removed := h.absent(t, g, 1)
			leaf, added := h.membershipOf(t, g, 1)
			if err := deliberate(h, g, leaf, added); err != nil {
				t.Fatalf("%s: %v", name, err)
			}
			r, ok := h.instanceRemoveOf(t, g, leaf, false)
			if !ok || !bytes.Equal(r.Ref, removed.Ref) || r.Withdrawable {
				t.Fatalf("after %s the standing Remove is %+v: want the same row, no longer withdrawable", name, r)
			}
			if n, err := h.resume(t, g, 1); err != nil || n != 0 {
				t.Fatalf("the device's resume after %s = %d, %v; want nothing withdrawn", name, n, err)
			}
			if _, ok := h.instanceRemoveOf(t, g, leaf, false); !ok {
				t.Fatalf("the resume withdrew the Remove %s stood behind", name)
			}
		})
	}
	t.Run("reconcile", func(t *testing.T) {
		h := newDSHarness(t)
		ctx := context.Background()
		g := h.callGroupWithMembers(t, 3)
		h.absent(t, g, 1)
		s := h.sessions[g.members[1]]
		h.account(t, s.UserID, s.DeviceID)
		if err := h.repo.RevokeDevice(ctx, g.members[1], h.clk.Now().Unix()); err != nil {
			t.Fatalf("RevokeDevice: %v", err)
		}
		if _, err := ds.ReconcileLeavesForTest(h.ds, ctx); err != nil {
			t.Fatalf("reconcile: %v", err)
		}
		leaf, _ := h.membershipOf(t, g, 1)
		if r, ok := h.instanceRemoveOf(t, g, leaf, false); !ok || r.Withdrawable {
			t.Fatalf("after the reconcile of a revoked device the Remove is %+v: want it standing and not withdrawable", r)
		}
	})
}

// Security fix 2: the re-armed flag is existing.Withdrawable && p.Withdrawable. A voided kick that
// the sweep's absence re-proposal re-arms stays non-withdrawable, and so does a tainted Remove
// through the call sweeper's void and re-drive; a voided absence Remove a kick re-arms is tainted.
func TestAVoidedKickReArmedByTheSweepStaysNonWithdrawable(t *testing.T) {
	h := newDSHarness(t)
	ctx := context.Background()
	g := h.callGroupWithMembers(t, 3)
	if err := h.ds.ProposeRemoveDevice(ctx, g.id, g.members[1], id.New()); err != nil {
		t.Fatalf("the kick: %v", err)
	}
	leaf, added := h.membershipOf(t, g, 1)
	kick, ok := h.instanceRemoveOf(t, g, leaf, false)
	if !ok || kick.Withdrawable {
		t.Fatalf("the kick %+v", kick)
	}
	if err := h.ds.Void(ctx, g.id, kick.Ref); err != nil {
		t.Fatalf("Void: %v", err)
	}
	if err := h.ds.ProposeAbsenceRemove(ctx, g.id, leaf, g.members[1], added, id.New()); err != nil {
		t.Fatalf("the sweep's re-proposal: %v", err)
	}
	r, ok := h.instanceRemoveOf(t, g, leaf, false)
	if !ok || !bytes.Equal(r.Ref, kick.Ref) || r.Withdrawable || r.VoidAt != nil {
		t.Fatalf("re-armed %+v: want the kick's row live and still not withdrawable", r)
	}
	for range 2 {
		h.clk.Advance(31 * time.Second)
		if _, err := ds.SweepCallProposalsForTest(h.ds, ctx); err != nil {
			t.Fatalf("SweepCallProposals: %v", err)
		}
		if r, ok := h.instanceRemoveOf(t, g, leaf, true); !ok || r.Withdrawable {
			t.Fatalf("after a void and re-drive the Remove is %+v: want it still not withdrawable", r)
		}
	}
	if n, err := h.resume(t, g, 1); err != nil || n != 0 {
		t.Fatalf("resume = %d, %v; want nothing withdrawn", n, err)
	}

	h2 := newDSHarness(t)
	g2 := h2.callGroupWithMembers(t, 3)
	absence := h2.absent(t, g2, 1)
	if err := h2.ds.Void(ctx, g2.id, absence.Ref); err != nil {
		t.Fatalf("Void: %v", err)
	}
	if err := h2.ds.ProposeRemoveDevice(ctx, g2.id, g2.members[1], id.New()); err != nil {
		t.Fatalf("the kick: %v", err)
	}
	if r, ok := h2.instanceRemoveOf(t, g2, *absence.TargetLeaf, false); !ok || r.Withdrawable {
		t.Fatalf("a voided absence Remove re-armed by a kick is %+v: want live and not withdrawable", r)
	}
	if n, err := h2.resume(t, g2, 1); err != nil || n != 0 {
		t.Fatalf("resume = %d, %v; want nothing withdrawn", n, err)
	}
}
