package ds

import (
	"context"

	"github.com/jonasthim/dilla/internal/id"
	"github.com/jonasthim/dilla/internal/mlswasi"
	"github.com/jonasthim/dilla/internal/store"
)

// nextSeq allocates the next number in the group's ONE seq space. Handshakes and application
// messages share it, so a device's cursor is a single number and the stream is dense.
//
// The allocation runs inside the caller's transaction: `UPDATE mls_groups SET seq = seq + 1 …
// RETURNING seq` is atomic on both engines, and the per-group lock above it makes the
// read-modify cycle observable only to one goroutine at a time.
func nextSeq(ctx context.Context, tx store.Repository, groupID id.ID) (uint64, error) {
	return tx.NextSeq(ctx, groupID)
}

// Handshakes serves the catch-up stream. A `from` below the retention floor is E_PRUNED, which
// tells the client to resync rather than to retry.
func (d *DS) Handshakes(ctx context.Context, groupID id.ID, session Session, from uint64, limit int32) ([]store.HandshakeRow, error) {
	// Member-only: the handshake log names every leaf that ever committed and every epoch
	// transition of the group. A non-member is E_NOT_FOUND, never E_FORBIDDEN.
	if err := d.requireMember(ctx, groupID, session); err != nil {
		return nil, err
	}
	if limit <= 0 || limit > 512 {
		limit = 512
	}
	floor, err := d.opts.Store.OldestHandshakeSeq(ctx, groupID)
	if err != nil {
		return nil, err
	}
	if floor == 0 {
		// An EMPTY log. The floor below is the oldest SURVIVING seq, and a log the sweep has
		// emptied has none, so without this the predicate reads 0 and serves an empty page —
		// "nothing new" — to a device that missed everything the sweep took. Nothing survives,
		// so every seq the group ever issued at or above `from` is a hole unless no handshake
		// can have been swept; one past the head has lost nothing.
		row, err := d.opts.Store.GetGroup(ctx, groupID)
		if err != nil {
			return nil, err
		}
		if from <= row.Seq {
			gone, err := d.mayHavePrunedHandshakes(ctx, groupID)
			if err != nil {
				return nil, err
			}
			if gone {
				return nil, errPruned(from, row.Seq+1)
			}
		}
	}
	// `from` is the first seq the caller still wants. A cursor at floor-1 is contiguous with the
	// log; below that the log MAY have a hole the instance cannot fill, which is a resync, not a
	// retry.
	//
	// MAY, because `floor` is the oldest surviving HANDSHAKE while `from` is a cursor in the ONE
	// seq space handshakes and application messages share: a group whose seqs 1-19 carry messages
	// and whose first handshake sits at 20 is below its floor from seq 0 with nothing ever
	// deleted. Refusing that is not a harmless over-refusal — protocol/02's error table makes
	// E_PRUNED mean "resync by external commit", so it sends a healthy member through a full
	// rejoin. So the floor alone does not refuse: `mayHavePrunedHandshakes` has to agree that a
	// handshake CAN already be gone.
	if floor > 0 && from+1 < floor {
		gone, err := d.mayHavePrunedHandshakes(ctx, groupID)
		if err != nil {
			return nil, err
		}
		if gone {
			return nil, errPruned(from, floor)
		}
	}
	return d.opts.Store.ListHandshakes(ctx, groupID, from, limit)
}

// mayHavePrunedHandshakes answers whether ANY handshake of this group can already have been
// deleted.
//
// The retention sweep has exactly one deletion rule for handshakes — `DELETE FROM mls_handshakes
// WHERE created < now - HandshakeRetention` — and every row of a group is younger than the group
// itself. A group younger than the retention window has therefore lost nothing, whatever its
// floor looks like, and the gap below the floor belongs to the other stream in the shared space.
// The cutoff only ever moves forward with the clock, so an earlier sweep cannot have deleted what
// this one would keep.
//
// It is deliberately one-directional: it can say "a handshake MAY be gone" for a group that has
// in fact lost nothing (an OLD group whose first handshake is recent and whose earlier seqs are
// all messages), and it never says "nothing is gone" about a group that has lost something. An
// unnecessary rejoin is expensive; serving a log with a silent hole in it forks the client.
//
// That residual over-refusal is a KNOWN, ACCEPTED deviation for this wave — ruling 41, plan
// deviation B20 — not an oversight. The exact test is `min(OldestHandshakeSeq, oldest live
// app-message seq)`, which needs `mls_app_messages`: that table and `store.Messages` are TASK
// 23's, and task 23 owes both the replacement of this predicate and the flip of
// `TestAnOldGroupWithNothingSweptIsStillRefusedUntilTask23` from asserting the refusal to
// asserting the rows. A `pruned_through_seq` high-water column instead would have to be added to
// task 19's migration and written by task 26's sweep, so until task 26 it would read 0 on every
// group and this predicate would serve a silently holed log — the one failure this exists to
// prevent. The interface contract (ID1) fixes the store's method set for the same reason.
//
// The one case this cannot see is an operator LENGTHENING HandshakeRetention after a sweep has
// already run under a shorter one; protocol/02 fixes the window at 30 days and the DS has no
// knob for it.
func (d *DS) mayHavePrunedHandshakes(ctx context.Context, groupID id.ID) (bool, error) {
	row, err := d.opts.Store.GetGroup(ctx, groupID)
	if err != nil {
		return false, err
	}
	cutoff := d.opts.Clock.Now().Add(-d.opts.Policy.HandshakeRetention).Unix()
	return row.Created < cutoff, nil
}

// Outstanding is every non-void proposal of the group's current epoch. It is the list both
// E_COMMIT_CONFLICT and E_COMMIT_REQUIRED carry, so a void or stale ref in here would send a
// client to commit something the instance has already withdrawn.
func (d *DS) Outstanding(ctx context.Context, groupID id.ID) ([]store.ProposalRow, error) {
	row, err := d.opts.Store.GetGroup(ctx, groupID)
	if err != nil {
		return nil, err
	}
	return d.opts.Store.ListProposals(ctx, groupID, row.Epoch, false)
}

// Proposal is one row of endpoint 19's answer: the SQL row plus the queued proposal blob the
// guest holds. protocol/02 fixes the shape as `[ref, kind, target_leaf|null, blob, void]`, and
// `mls_pending_proposals` has no blob column — the bytes live in the guest's proposal queue,
// which is also where `PublicGroup::queued_proposals` reads them for the two conflict bodies.
type Proposal struct {
	Row  store.ProposalRow
	Blob []byte
}

// Proposals is endpoint 19: the outstanding proposals of the group's current epoch, void ones
// included and flagged, for a member of the group only. A non-member is E_NOT_FOUND for the same
// reason Info, Tree and Handshakes are: the list names leaves and the devices they belong to.
func (d *DS) Proposals(ctx context.Context, groupID id.ID, session Session) ([]Proposal, error) {
	unlock := d.lock(groupID)
	defer unlock()
	if err := d.requireMember(ctx, groupID, session); err != nil {
		return nil, err
	}
	row, err := d.opts.Store.GetGroup(ctx, groupID)
	if err != nil {
		return nil, err
	}
	rows, err := d.opts.Store.ListProposals(ctx, groupID, row.Epoch, true)
	if err != nil {
		return nil, err
	}
	blobs, err := d.queuedProposals(ctx, groupID)
	if err != nil {
		return nil, err
	}
	out := make([]Proposal, 0, len(rows))
	for _, r := range rows {
		out = append(out, Proposal{Row: r, Blob: blobs[string(r.Ref)]})
	}
	return out, nil
}

// queuedProposals is the guest's own proposal queue, keyed by ref. The blob a client needs is the
// one the guest stored, not a re-serialised Proposal: protocol/02's `blob` is the framed message
// the committer includes by reference.
func (d *DS) queuedProposals(ctx context.Context, groupID id.ID) (map[string][]byte, error) {
	out := map[string][]byte{}
	err := d.withGroup(ctx, groupID, func(g *mlswasi.PublicGroup) error {
		pairs, err := g.ProposalList(ctx)
		if err != nil {
			return err
		}
		for _, p := range pairs {
			out[string(p[0])] = p[1]
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return out, nil
}
