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
// DEVIATION from the task brief, which ends the loop with `d.closeUnhealedGroups(ctx)`. Invariant
// 11's close-and-recreate is task 27's (`internal/ds/heal.go`); no such method exists in this
// tree, and inventing one here would put the terminal path of a group's life inside the retention
// task. Task 27 adds the call on this tick.
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
	after := id.ID{}
	for {
		groups, err := d.opts.Store.ListOpenGroups(ctx, after, sweepPage)
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
			after = g.GroupID
		}
		if len(groups) < sweepPage {
			break
		}
	}
	return report, nil
}
