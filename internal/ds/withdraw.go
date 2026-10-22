package ds

// withdraw.go: UP6b (R-UP12, protocol/02 invariant 6 "Withdrawal"). The instance may withdraw an
// absence Remove of its own — one it issued because a device stayed out of, or left, its call's
// room — and only when that device itself resumes, and only the Remove of its own membership.
//
// When every member of a call drops at once, each one's OpenMLS queue holds the instance's Remove
// of its own leaf, and OpenMLS refuses to commit a self-removal: nobody can commit, an external
// join is refused while the Removes are outstanding, and a resumed leaf stays doomed. A withdrawal
// on the delivery service alone cannot fix that, because the members already hold the proposal; so
// the withdrawal is published as a kind-3 handshake row, which members apply by taking the proposal
// out of their queues.

import (
	"context"
	"errors"
	"net/http"
	"time"

	"github.com/jonasthim/dilla/internal/cborx"
	"github.com/jonasthim/dilla/internal/gateway"
	"github.com/jonasthim/dilla/internal/id"
	"github.com/jonasthim/dilla/internal/mlswasi"
	"github.com/jonasthim/dilla/internal/store"
)

// handshakeWithdrawn is handshake kind 3, `withdrawn` (protocol/02 § Handshake records).
const handshakeWithdrawn uint8 = 3

// WithdrawnStandWindow is how long a withdrawn absence Remove still counts as standing for a
// re-proposal of the same membership (correction I1). The room sweep runs outside the group lock
// and its queued Remove carries the same deterministic ref, so one flushed just after the
// withdrawal must be a no-op; the window equals the call path's admissionJoinWindow (30 s), in which
// the resumed device is admitted and then seen present. After it, a re-proposal re-arms the row.
const WithdrawnStandWindow = 30 * time.Second

// ErrMembershipGone is WithdrawAbsenceRemoves' refusal: the resuming device no longer holds the
// membership it was admitted with (a commit removed it first). The call start answers
// E_LEAF_NOT_CURRENT, and the device forgets the group and joins afresh; that cannot deadlock,
// because the Remove is committed.
var ErrMembershipGone = errors.New("ds: the resuming device no longer holds that membership")

// errCommitWithdrawn is invariant 6's refusal of a commit that applies a withdrawn proposal: 409
// E_COMMIT_CONFLICT, detail `withdrawn`, an empty winning_commit and the current listing. The
// committer catches up (which applies the kind-3 row and drops the ref) and builds again.
func errCommitWithdrawn(proposals [][]byte) *Error {
	return &Error{
		Code:          "E_COMMIT_CONFLICT",
		Detail:        "withdrawn",
		Status:        http.StatusConflict,
		WinningCommit: []byte{},
		Proposals:     proposals,
	}
}

// ProposeAbsenceRemove is ProposeRemoveOfMember for the two absence paths, and only for them: the
// room sweep's Remove of a device that stayed out of its call (flushLeafRemovals) and the Remove of
// a device that left it (proposeLeave). The Remove is marked withdrawable, which no other path ever
// sets: not a revocation, a kick or ban, an eviction, a barred device's cut, the election's removal
// of a candidate or a member's own proposal.
//
// A withdrawn Remove of the same membership at the current epoch counts as standing within
// WithdrawnStandWindow of its withdrawal (the call is a no-op); after it, the re-proposal re-arms the
// row — no longer withdrawn, still withdrawable, issued now — and fans it out again as a kind-0 row,
// which the members queue again (correction I1).
func (d *DS) ProposeAbsenceRemove(ctx context.Context, groupID id.ID, leaf uint32, deviceID id.ID, addedEpoch uint64, actionID id.ID) error {
	unlock := d.lock(groupID)
	defer unlock()
	row, err := d.opts.Store.GetGroup(ctx, groupID)
	if errors.Is(err, store.ErrNotFound) {
		return errNotFound("group")
	}
	if err != nil {
		return err
	}
	if same, err := d.holdsMembership(ctx, groupID, leaf, deviceID, addedEpoch); err != nil {
		return err
	} else if !same {
		gone := errInvalid("the Remove target no longer holds that membership; the action is dropped")
		gone.cause = ErrRemoveTargetGone
		return gone
	}
	standing, err := d.instanceRemoveOutstanding(ctx, groupID, row.Epoch, leaf)
	if err != nil || standing {
		return err
	}
	withdrawn, err := d.opts.Store.ListWithdrawnProposals(ctx, groupID, row.Epoch)
	if err != nil {
		return err
	}
	for _, w := range withdrawn {
		if !isAbsenceRemoveOf(w, leaf, deviceID) || w.WithdrawnAt == nil {
			continue
		}
		if d.opts.Clock.Now().Sub(time.Unix(*w.WithdrawnAt, 0)) < WithdrawnStandWindow {
			d.log().Info("an absence Remove withdrawn moments ago stands for its re-proposal",
				"group", groupID.String()[:8], "device", deviceID.String()[:8])
			return nil
		}
	}
	return d.proposeRemoveOfLockedAs(ctx, groupID, leaf, &deviceID, actionID, true)
}

// holdsMembership reports whether deviceID holds leaf from addedEpoch in the current member set.
func (d *DS) holdsMembership(ctx context.Context, groupID id.ID, leaf uint32, deviceID id.ID, addedEpoch uint64) (bool, error) {
	members, err := d.opts.Store.ListMembers(ctx, groupID)
	if err != nil {
		return false, err
	}
	for _, m := range members {
		if m.LeafIndex == leaf && m.RemovedEpoch == nil {
			return m.DeviceID == deviceID && m.AddedEpoch == addedEpoch, nil
		}
	}
	return false, nil
}

// isAbsenceRemoveOf is a withdrawable instance Remove of deviceID's leaf.
func isAbsenceRemoveOf(r store.ProposalRow, leaf uint32, deviceID id.ID) bool {
	return r.Origin == 0 && r.Withdrawable && mlswasi.ProposalKind(r.Kind) == mlswasi.ProposalRemove &&
		r.TargetLeaf != nil && *r.TargetLeaf == leaf && r.TargetDevice != nil && *r.TargetDevice == deviceID
}

// WithdrawAbsenceRemoves is the resume's half of the withdrawal: the call start runs it immediately
// before it mints the device's token (correction I2), after every other check passed. Under the
// group lock, in one store transaction, it
//
//  1. checks that deviceID still holds leaf from addedEpoch, else ErrMembershipGone;
//  2. finds every withdrawable, unwithdrawn instance Remove of THAT membership at the current
//     epoch, outstanding or voided by its TTL and not yet re-driven (correction I3) — the resuming
//     device's own, never another member's ("Only its own");
//  3. marks each withdrawn and appends one kind-3 handshake row per proposal, fanned out as op 16 to
//     the connections that set caps bit 0 only.
//
// It does NOT unqueue the proposal from the PublicGroup (correction C3): unqueueProposal refuses a
// ref SQL still holds, and a client that drops the ref would otherwise make g.Process fail with 422.
// The commit path refuses a commit that applies it instead (409 `withdrawn`). It answers how many
// Removes it withdrew.
func (d *DS) WithdrawAbsenceRemoves(ctx context.Context, groupID, deviceID id.ID, leaf uint32, addedEpoch uint64) (int, error) {
	unlock := d.lock(groupID)
	defer unlock()
	row, err := d.opts.Store.GetGroup(ctx, groupID)
	if errors.Is(err, store.ErrNotFound) {
		return 0, ErrMembershipGone
	}
	if err != nil {
		return 0, err
	}
	if row.ClosedAt != nil {
		return 0, ErrMembershipGone
	}
	type withdrawal struct {
		row  store.ProposalRow
		seq  uint64
		blob []byte
	}
	var done []withdrawal
	err = d.opts.Store.Tx(ctx, func(tx store.Repository) error {
		done = nil
		members, err := tx.ListMembers(ctx, groupID)
		if err != nil {
			return err
		}
		same := false
		for _, m := range members {
			if m.LeafIndex == leaf && m.RemovedEpoch == nil {
				same = m.DeviceID == deviceID && m.AddedEpoch == addedEpoch
			}
		}
		if !same {
			return ErrMembershipGone
		}
		rows, err := tx.ListProposals(ctx, groupID, row.Epoch, true)
		if err != nil {
			return err
		}
		now := d.now()
		for _, r := range rows {
			if !isAbsenceRemoveOf(r, leaf, deviceID) {
				continue
			}
			seq, err := nextSeq(ctx, tx, groupID)
			if err != nil {
				return err
			}
			blob, err := withdrawnBlob(r.Ref)
			if err != nil {
				return err
			}
			if err := tx.AppendHandshake(ctx, store.HandshakeRow{
				GroupID: groupID, Seq: seq, Epoch: r.Epoch, Kind: handshakeWithdrawn,
				SenderLeaf: nil, SenderDevice: nil, Blob: blob, Created: now,
			}); err != nil {
				return err
			}
			marked, err := tx.WithdrawProposal(ctx, groupID, r.Ref, now, seq)
			if err != nil {
				return err
			}
			if !marked {
				return errors.New("ds: an absence Remove changed under the group lock")
			}
			done = append(done, withdrawal{row: r, seq: seq, blob: blob})
		}
		return nil
	})
	if err != nil {
		return 0, err
	}
	for _, w := range done {
		if d.opts.Metrics != nil && w.row.VoidAt == nil {
			d.opts.Metrics.DSProposals.WithLabelValues(proposalLabel(w.row.Kind)).Dec()
		}
		if d.opts.Gateway != nil {
			payload, perr := gateway.HandshakePayload(w.seq, w.row.Epoch, handshakeWithdrawn, nil, w.blob)
			if perr == nil {
				d.opts.Gateway.DeliverGroup(groupID, gateway.Frame{
					Op: gateway.OpMLSHandshake, GroupID: &groupID, Payload: payload, Replay: true,
					Caps: gateway.CapWithdrawnRows,
				})
			}
		}
		d.log().Info("a resuming device's own absence Remove was withdrawn",
			"group", groupID.String()[:8], "device", deviceID.String()[:8], "seq", w.seq)
	}
	if len(done) > 0 {
		// The resumer is no longer being removed, so it may be elected now: in the all-dropped case
		// it is the only device that can commit the other members' Removes. A failure is logged; the
		// watchdog and the next proposal re-elect.
		if err := d.RequestCommit(ctx, groupID); err != nil {
			d.log().Error("electing a committer after a withdrawal failed", "group", groupID.String()[:8], "err", err)
		}
	}
	return len(done), nil
}

// withdrawnBlob is a kind-3 row's blob: the deterministic CBOR [proposal_ref(bstr)].
func withdrawnBlob(ref []byte) ([]byte, error) {
	return cborx.Marshal([]any{ref})
}

// withdrawnInEpoch reports whether the group's epoch holds a withdrawn proposal: invariant 7 then
// elects no device without caps bit 0, which still holds the withdrawn ref.
func (d *DS) withdrawnInEpoch(ctx context.Context, groupID id.ID, epoch uint64) (bool, error) {
	rows, err := d.opts.Store.ListWithdrawnProposals(ctx, groupID, epoch)
	return len(rows) > 0, err
}

// appliesWithdrawn is the commit's check (correction C3), run right after g.Process: a commit that
// applies a withdrawn proposal is refused with 409 `withdrawn` before the clause checks and the
// merge.
func (d *DS) appliesWithdrawn(ctx context.Context, groupID id.ID, epoch uint64, applied []mlswasi.AppliedProposal) error {
	for _, a := range applied {
		withdrawn, err := d.opts.Store.IsWithdrawn(ctx, groupID, epoch, a.ProposalRef)
		if err != nil {
			return err
		}
		if !withdrawn {
			continue
		}
		refs, err := d.refsOf(ctx, groupID, epoch)
		if err != nil {
			return err
		}
		return errCommitWithdrawn(refs)
	}
	return nil
}
