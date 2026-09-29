package ds

import (
	"context"

	"github.com/jonasthim/dilla/internal/id"
	"github.com/jonasthim/dilla/internal/mlswasi"
)

// freezeState reports whether the group is frozen and, if so, the refs a committer must reference.
//
// Invariant 5 as amended (R10): the freeze holds while a non-void instance proposal is outstanding
// AND some member device is online. When every instance proposal has gone void, the freeze lifts
// even if no member device is online — otherwise a group whose members are all away is frozen
// forever, and invariant 11's close-and-recreate becomes the only exit.
//
// The refs are returned whether or not the freeze holds: the caller that accepts an external
// commit because nobody is online still has to re-issue everything the commit omitted, and that is
// the same list.
func (d *DS) freezeState(ctx context.Context, groupID id.ID, epoch uint64) (bool, [][]byte, error) {
	refs, err := d.outstandingRefs(ctx, groupID, epoch)
	if err != nil {
		return false, nil, err
	}
	if len(refs) == 0 {
		return false, nil, nil
	}
	// A nil gateway is "nobody is online": the composition root always supplies one, and a DS
	// built without it (the seam tests) must not report a freeze it has no way to lift.
	if d.opts.Gateway == nil {
		return false, refs, nil
	}
	if len(d.opts.Gateway.OnlineIn(groupID)) > 0 {
		return true, refs, nil
	}
	return false, refs, nil
}

// Frozen is the freeze predicate the API and the tests read, at the group's own epoch.
func (d *DS) Frozen(ctx context.Context, groupID id.ID) (bool, error) {
	row, err := d.opts.Store.GetGroup(ctx, groupID)
	if err != nil {
		return false, err
	}
	frozen, _, err := d.freezeState(ctx, groupID, row.Epoch)
	return frozen, err
}

// outstandingRefs is the freeze predicate WITHOUT the online clause: the refs of every non-void
// INSTANCE proposal at this epoch.
//
// The online clause belongs to the external-commit path alone. protocol/02 invariant 5 reads
// "application messages get 425 commit_required, and external commits get 425 commit_required too
// — unless no member device is online, in which case the EXTERNAL COMMIT is accepted". A device
// holding an HTTP session but no gateway connection is not online under R10, so sharing
// freezeState with the message path would let it upload ciphertext straight through a live freeze.
//
// It is a different answer from `refsOf`, which the two conflict bodies use: that one lists every
// non-void proposal whatever its origin, because a committer has to reference member proposals
// too. This one is the freeze's own input and counts only origin 0.
func (d *DS) outstandingRefs(ctx context.Context, groupID id.ID, epoch uint64) ([][]byte, error) {
	rows, err := d.opts.Store.ListProposals(ctx, groupID, epoch, false)
	if err != nil {
		return nil, err
	}
	refs := make([][]byte, 0, len(rows))
	for _, r := range rows {
		if r.Origin != 0 || r.VoidAt != nil {
			continue
		}
		refs = append(refs, r.Ref)
	}
	return refs, nil
}

// requireNoFreeze is the guard on the message path: a message during a freeze is
// E_COMMIT_REQUIRED carrying the refs, and the client commits them (or waits for
// mls.commit_needed) and resends. It does NOT consult the online predicate — see outstandingRefs.
func (d *DS) requireNoFreeze(ctx context.Context, groupID id.ID, epoch uint64) error {
	refs, err := d.outstandingRefs(ctx, groupID, epoch)
	if err != nil {
		return err
	}
	if len(refs) > 0 {
		return errCommitRequired(refs, uint64(d.opts.Policy.CommitDeadline.Milliseconds())) //nolint:gosec // G115: a non-negative duration in milliseconds
	}
	return nil
}

// reissueOmitted re-issues every non-void instance proposal the commit did not reference, for the
// new epoch, and keeps the freeze. A proposal can only be omitted through invariant 5's
// nobody-online exception, so this runs exactly on that path.
//
// IT CANNOT FIRE UNTIL TASK 25 (deviation B21, ruling 42). It is wired at commit step (9), and
// `checkAppliedProposals`' clause 1 — step (4) — already refuses every commit that omits a
// non-void origin-0 proposal at the current epoch, with no exemption for the external commit
// invariant 5 accepts when nobody is online. Task 25 owes clause 1 that exemption as well as the
// `commitOptions.external` flag; the comment at clause 1 in commit.go states the exact shape.
//
// It runs with the group lock held but OUTSIDE withGroup: everything it reaches calls withGroup
// again to queue the re-signed proposal in the guest, and the handle lock withGroup takes is a
// plain sync.Mutex. Calling it from inside the commit's own withGroup closure would deadlock that
// group's request goroutine for the life of the process.
//
// THE REGRESSION GUARD FOR THAT DEADLOCK IS CARRIED TO TASK 25 (deviation B24, ruling 45). Task
// 22's `TestACommitThatReissuesAnOmittedRemoveDoesNotDeadlock` — the timeout is its assertion —
// cannot be written until a commit can be ACCEPTED here, which is the same blocker as B21's. The
// property holds today (`ProposeRemove` is a thin locking wrapper over `proposeRemoveLocked`,
// `reissue` calls only the lock-free form, and `RequestCommit`, which task 22 added to this path,
// takes `elections.mu`, the store and the gateway — never `d.lock(groupID)`), but nothing FAILS if
// a later task makes anything reachable from `storeInstanceProposal` take the group lock. Task 25
// must land that test in the same commit that exempts clause 1.
func (d *DS) reissueOmitted(ctx context.Context, groupID id.ID, oldEpoch uint64, applied []mlswasi.AppliedProposal) error {
	rows, err := d.opts.Store.ListProposals(ctx, groupID, oldEpoch, false)
	if err != nil {
		return err
	}
	referenced := map[string]struct{}{}
	for _, a := range applied {
		referenced[string(a.ProposalRef)] = struct{}{}
	}
	for _, r := range rows {
		if r.Origin != 0 || r.VoidAt != nil {
			continue
		}
		if _, ok := referenced[string(r.Ref)]; ok {
			continue
		}
		if err := d.reissue(ctx, groupID, r); err != nil {
			return err
		}
	}
	return nil
}
