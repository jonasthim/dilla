package ds_test

import (
	"bytes"
	"context"
	"errors"
	"testing"
	"time"

	"github.com/jonasthim/dilla/internal/ds"
	"github.com/jonasthim/dilla/internal/id"
	"github.com/jonasthim/dilla/internal/mlswasi"
	"github.com/jonasthim/dilla/internal/store"
)

// The security fix to dilla-media task 9 (task-9-security-fix-report.md): a member-originated
// proposal never cancels, voids, blocks or stands in for an instance proposal. A member being
// kicked, banned or evicted who keeps a self-Remove outstanding must not keep the instance's Remove
// from being issued, from being mandatory, or from freezing the group — a member Remove is not
// mandatory for a commit (invariant 4 clause 1 covers instance proposals only), freezes nothing and
// triggers no election, so standing in for the instance's is staying in the group.

// instanceRemovesOf is every non-void instance Remove of leaf at the fixture epoch.
func (h *dsHarness) instanceRemovesOf(t *testing.T, groupID id.ID, leaf uint32) []store.ProposalRow {
	t.Helper()
	var out []store.ProposalRow
	for _, r := range h.proposals(t, groupID, false) {
		if r.Origin == 0 && r.VoidAt == nil && mlswasi.ProposalKind(r.Kind) == mlswasi.ProposalRemove &&
			r.TargetLeaf != nil && *r.TargetLeaf == leaf {
			out = append(out, r)
		}
	}
	return out
}

// D(i): with an instance Remove of leaf L outstanding, the member at L posting its own Remove of L
// is refused — E_INVALID_REQUEST, "a removal of this leaf is already pending" — and taken back out of
// the guest's queue; the instance's Remove is still non-void and the group still frozen. Proposal's
// leaf check refuses every committed proposal (the fixture's one is the instance's own Remove of
// leaf 0), so the shape decision is driven through the seam with leaf 0's own session: to the
// decision it is leaf 0's Remove of leaf 0. The real member-signed refusal runs end to end in
// call_remove_refused_leave.scn.
func TestAMembersOwnRemoveOfALeafTheInstanceIsRemovingIsRefused(t *testing.T) {
	h := newDSHarness(t)
	ctx := context.Background()
	reg, session := h.mustRegister(t)
	// The instance's Remove of leaf 0, in SQL only: the guest's queue must stay free for the
	// fixture's bytes, which are that same Remove's.
	ref, leaf, device := id.New(), uint32(0), session.DeviceID
	instance := ref[:]
	if err := h.repo.PutProposal(ctx, store.ProposalRow{
		GroupID: reg.GroupID, Ref: instance, Epoch: 6, Kind: uint8(mlswasi.ProposalRemove),
		TargetLeaf: &leaf, TargetDevice: &device, Origin: 0, ActionID: id.New(),
		IssuedAt: h.clk.Now().Unix(), TTL: 30,
	}); err != nil {
		t.Fatalf("PutProposal: %v", err)
	}

	if err := ds.WithGroupForTest(h.ds, ctx, reg.GroupID, func(g *mlswasi.PublicGroup) error {
		_, _, err := ds.QueueMemberProposalForTest(h.ds, ctx, g, session, reg.GroupID, fixtureFile(t, "remove_leaf0.mls"))
		var dsErr *ds.Error
		if !errors.As(err, &dsErr) || dsErr.Code != "E_INVALID_REQUEST" || dsErr.Detail != "a removal of this leaf is already pending" {
			t.Errorf("leaf 0's own Remove while the instance removes leaf 0: got %v, want E_INVALID_REQUEST (already pending)", err)
		}
		queued, err := g.ProposalList(ctx)
		if err != nil {
			return err
		}
		if len(queued) != 0 {
			t.Errorf("the guest holds %d queued proposals after the refusal, want 0", len(queued))
		}
		return nil
	}); err != nil {
		t.Fatalf("withGroup: %v", err)
	}
	if got := h.instanceRemovesOf(t, reg.GroupID, 0); len(got) != 1 || !bytes.Equal(got[0].Ref, instance) {
		t.Fatalf("instance Removes of leaf 0 after the refusal: %+v, want the one still non-void", got)
	}
	// Still frozen: an application message is 425 E_COMMIT_REQUIRED.
	err := ds.RequireNoFreezeForTest(h.ds, ctx, reg.GroupID, 6)
	var dsErr *ds.Error
	if !errors.As(err, &dsErr) || dsErr.Code != "E_COMMIT_REQUIRED" || dsErr.Status != 425 {
		t.Fatalf("a message after the refusal: got %v, want 425 E_COMMIT_REQUIRED", err)
	}
}

// D(ii): a member with a standing self-Remove is kicked. The instance's Remove IS issued on top of
// it — OpenMLS keeps the later of two Removes of one leaf, so the commit that applies the instance's
// leaves the member's unreferenced, which clause 1 allows — it records the device it was issued
// for, and a commit that omits it is refused.
func TestAKickIsIssuedOnTopOfTheMembersOwnRemoveAndIsMandatory(t *testing.T) {
	h := newDSHarness(t)
	ctx := context.Background()
	reg, session := h.mustRegister(t)
	h.repo.markCall(reg.GroupID)
	target := h.memberSession(t, reg.GroupID, 2).DeviceID
	h.putMemberRemove(t, reg.GroupID, 2, 3600)

	if err := h.ds.ProposeRemoveDevice(ctx, reg.GroupID, target, id.New()); err != nil {
		t.Fatalf("ProposeRemoveDevice: %v", err)
	}
	got := h.instanceRemovesOf(t, reg.GroupID, 2)
	if len(got) != 1 {
		t.Fatalf("%d instance Removes of leaf 2, want 1: the member's own Remove stood in for the kick", len(got))
	}
	if got[0].TargetDevice == nil || *got[0].TargetDevice != target {
		t.Errorf("the instance Remove records device %v, want %s", got[0].TargetDevice, target)
	}

	// Mandatory: a member commit that does not reference it is refused by clause 1.
	_, err := h.ds.Commit(ctx, session, reg.GroupID, ds.CommitRequest{
		Epoch: 6, Commit: fixtureFile(t, "commits/09.mls"), GroupInfo: dsFixture(t).groupInfo,
	})
	var dsErr *ds.Error
	if !errors.As(err, &dsErr) || dsErr.Rule != "outstanding_proposals" {
		t.Fatalf("a commit omitting the kick: got %v, want E_COMMIT_INVALID outstanding_proposals", err)
	}

	// The leaf-addressed path is the same: a member's own Remove does not count, the instance's does.
	h.putMemberRemove(t, reg.GroupID, 3, 3600)
	for range 2 {
		if err := h.ds.ProposeRemove(ctx, reg.GroupID, 3, id.New()); err != nil {
			t.Fatalf("ProposeRemove(3): %v", err)
		}
	}
	if n := len(h.instanceRemovesOf(t, reg.GroupID, 3)); n != 1 {
		t.Fatalf("%d instance Removes of leaf 3, want exactly 1 (issued over the member's, deduped against its own)", n)
	}
}

// D(iv): a voided instance Remove is re-driven across an epoch only when the device now at its
// leaf is the device it was issued for. MLS reuses blank leaves, so after the original device left
// and another joined at the same index, a re-drive by leaf would remove a different member. A
// voided row with no recorded device is never re-driven across epochs.
func TestAReDriveNeverRemovesADifferentDeviceAtAReusedLeaf(t *testing.T) {
	h := newDSHarness(t)
	ctx := context.Background()
	reg, _ := h.mustRegister(t)
	h.repo.markCall(reg.GroupID)

	voidedAt5 := func(leaf uint32, device *id.ID) id.ID {
		t.Helper()
		ref, action := id.New(), id.New()
		if err := h.repo.PutProposal(ctx, store.ProposalRow{
			GroupID: reg.GroupID, Ref: ref[:], Epoch: 5, Kind: uint8(mlswasi.ProposalRemove),
			TargetLeaf: &leaf, TargetDevice: device, Origin: 0, ActionID: action,
			IssuedAt: h.clk.Now().Add(-time.Minute).Unix(), TTL: 30,
		}); err != nil {
			t.Fatalf("PutProposal: %v", err)
		}
		if err := h.repo.VoidProposal(ctx, reg.GroupID, ref[:], h.clk.Now().Unix()); err != nil {
			t.Fatalf("VoidProposal: %v", err)
		}
		return action
	}
	left := id.New() // held leaf 1 at epoch 5; leaf 1 now holds another device
	voidedAt5(1, &left)
	voidedAt5(2, nil) // no recorded device
	stillThere := h.memberSession(t, reg.GroupID, 3).DeviceID
	action := voidedAt5(3, &stillThere)

	if err := ds.RedriveCallRemovesForTest(h.ds, ctx, reg.GroupID, 5, 6); err != nil {
		t.Fatalf("re-drive: %v", err)
	}
	for _, leaf := range []uint32{1, 2} {
		if n := len(h.instanceRemovesOf(t, reg.GroupID, leaf)); n != 0 {
			t.Errorf("leaf %d: %d Removes re-driven onto the device now holding it, want 0", leaf, n)
		}
	}
	got := h.instanceRemovesOf(t, reg.GroupID, 3)
	if len(got) != 1 || got[0].ActionID != action || got[0].TargetDevice == nil || *got[0].TargetDevice != stillThere {
		t.Fatalf("leaf 3: %+v, want one re-driven Remove with its action id and device", got)
	}
}
