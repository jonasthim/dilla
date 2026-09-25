package ds

import (
	"context"

	"github.com/jonasthim/dilla/internal/id"
)

// SweepReport is what one sweeper run did. Every field is a count, never an error budget: a sweep
// that cannot prune reports zero and logs, it does not fail a request path.
type SweepReport struct {
	ProposalsVoided  int
	HandshakesPruned int64
	MessagesPruned   int64
	WelcomesPruned   int64
}

// Sweep voids expired proposals and applies both halves of retention.
//
// Delivery retention is how long the instance keeps an object so a device that was away can still
// fetch it: handshakes 30 days, Welcomes 30 days, application ciphertext until every eligible
// cursor has passed it or 30 days, whichever comes first.
//
// Archival retention is the community's own policy for ciphertext (default indefinite), recorded
// per message in `expires`, where NULL means retained. It is compared against NOW, never against
// the delivery floor, and it never deletes a row that set no expiry: the two halves are
// independent triggers and either one alone deletes. Nothing in Plan 1 writes `expires` — `Upload`
// writes NULL — so this half fires only once Plan 2's community policy fills the column.
//
// The sweep PAGES: `sweepPage` (task 21) is how many groups one query reads, and the loop runs
// until a short page. A fixed batch from the zero id would mean only the first N groups are ever
// swept — on an instance with more groups than the batch, the tail's ciphertext never prunes, and
// nothing else does that work.
//
// The loop ends with `d.closeUnhealedGroups(ctx)`, invariant 11's terminal path: a group nobody
// healed inside the 24-hour window is closed and re-created by the channel owner's device. Task 26
// recorded the call as owed to task 27 (`internal/ds/heal.go`), which now owns the method; it runs
// AFTER both retention passes so a group closed on this tick has already had its ciphertext swept
// by the same run.
func (d *DS) Sweep(ctx context.Context) (SweepReport, error) {
	var report SweepReport

	voided, err := d.sweepProposals(ctx)
	if err != nil {
		return report, err
	}
	report.ProposalsVoided = voided

	now := d.opts.Clock.Now()
	handshakeFloor := now.Add(-d.opts.Policy.HandshakeRetention).Unix()
	messageFloor := now.Add(-d.opts.Policy.MessageRetention).Unix()

	n, err := d.opts.Store.PruneHandshakes(ctx, handshakeFloor)
	if err != nil {
		return report, err
	}
	report.HandshakesPruned = n

	// A Welcome carries its own expiry, so the cutoff here is `now` rather than a retention
	// window: `PruneWelcomes` deletes the rows whose `expires` has passed.
	n, err = d.opts.Store.PruneWelcomes(ctx, now.Unix())
	if err != nil {
		return report, err
	}
	report.WelcomesPruned = n

	// activeSince is the eligibility horizon: a device that is revoked, disabled or unseen for
	// 90 days does not hold the floor. MinCursor applies all three, which is why it takes the
	// timestamp rather than the DS filtering rows afterwards.
	activeSince := now.Add(-d.opts.Policy.InactivityRemove).Unix()
	// The walk is over EVERY group, not only the open ones (`ListGroupsForRetention`, not
	// `ListOpenGroups`). Invariant 10 caps application ciphertext at thirty days, and a group
	// invariant 11 closed is still ciphertext on the disk: skipping closed groups would mean
	// neither half of retention ever touches their blobs again, and nothing else reclaims them,
	// so the invariant would invert into "kept forever" exactly when a group stops being useful.
	after := id.ID{}
	for {
		groups, err := d.opts.Store.ListGroupsForRetention(ctx, after, sweepPage)
		if err != nil {
			return report, err
		}
		if len(groups) == 0 {
			break
		}
		for _, g := range groups {
			floor, err := d.opts.Store.MinCursor(ctx, g.GroupID, activeSince)
			if err != nil {
				return report, err
			}
			pruned, err := d.opts.Store.PruneAppMessages(ctx, g.GroupID, floor, messageFloor, now.Unix())
			if err != nil {
				return report, err
			}
			report.MessagesPruned += pruned
			// Record the floor that was in force for the deletion that just happened, BEFORE any
			// cursor can move. This is the only moment the number exists: `MinCursor` read again
			// later aggregates rows that come and go — a device has no cursor row at all until
			// its first POST /cursor, and a returning 90-day-idle device re-enters the aggregate
			// at whatever low seq it left — so a catch-up checked against a recomputed floor is
			// told "nothing is gone" about the rows this call has just deleted.
			//
			// It is recorded whenever the floor is above 0, deleted rows or not: over-stating
			// what MAY be gone costs a catch-up an unnecessary resync, understating it costs a
			// member a silently short list, and the predicate is one-directional for that reason
			// (ruling 41, deviation B20). `RaisePrunedBelow` is monotone, so the order of sweeps
			// and the 0 the floor falls back to when every cursor goes ineligible cannot walk it
			// backwards.
			if floor > 0 {
				if err := d.opts.Store.RaisePrunedBelow(ctx, g.GroupID, floor); err != nil {
					return report, err
				}
			}
			after = g.GroupID
		}
		if len(groups) < sweepPage {
			break
		}
	}
	if err := d.closeUnhealedGroups(ctx); err != nil {
		return report, err
	}
	return report, nil
}
