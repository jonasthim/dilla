package ds

import (
	"context"

	"github.com/jonasthim/dilla/internal/id"
	"github.com/jonasthim/dilla/internal/store"
)

// forkQuorum is how many DISTINCT reporter devices quarantine a committer. The distinctness is the
// whole point: one device reporting three times is one opinion, and the primary key
// (group_id, seq, reporter_device) is what makes a repeat report idempotent rather than a vote.
const forkQuorum = 3

// maxForkReason bounds the free-text reason a client may attach. It is truncated rather than
// refused: a fork report is a bug report, and losing the tail of a stack trace is better than
// losing the report.
const maxForkReason = 256

// ForkReport records that a member could not process an accepted commit. Three distinct reports
// against one commit quarantine its committer: an instance Remove of its leaf and a flag on the
// device (invariant 9).
func (d *DS) ForkReport(ctx context.Context, s Session, groupID id.ID, epoch, seq uint64, reason string) error {
	// Member-only. protocol/02's row for `POST /v1/groups/{id}/fork-report` names E_NOT_FOUND as
	// its one refusal, and `requireMember` is what answers it: a device that is not in the group
	// learns nothing about it, and cannot spend the instance's fork_reports rows on a group it
	// was never in.
	if err := d.requireMember(ctx, groupID, s); err != nil {
		return err
	}
	if len(reason) > maxForkReason {
		reason = reason[:maxForkReason]
	}
	if err := d.opts.Store.PutForkReport(ctx, store.ForkReportRow{
		GroupID:        groupID,
		Seq:            seq,
		ReporterDevice: s.DeviceID,
		Epoch:          epoch,
		Reason:         reason,
		Created:        d.now(),
	}); err != nil {
		return err
	}
	n, err := d.opts.Store.CountForkReporters(ctx, groupID, seq)
	if err != nil {
		return err
	}
	if n < forkQuorum {
		return nil
	}
	return d.quarantineCommitterOf(ctx, groupID, seq)
}

// quarantineCommitterOf is invariant 9's second half: the device that committed handshake `seq` is
// flagged and its leaf is Removed by an instance proposal.
func (d *DS) quarantineCommitterOf(ctx context.Context, groupID id.ID, seq uint64) error {
	if seq == 0 {
		// Seq 0 is not a handshake: the first one a group ever appends is 1. Reporting it is a
		// malformed request, not a quorum against anybody.
		return errInvalid("seq 0 is not a handshake")
	}
	// `ListHandshakes`' `fromSeq` is INCLUSIVE — `seq >= ?` in
	// internal/store/sqlite/queries/mls.sql:34, and `Handshakes` documents `from` as "the first
	// seq the caller still wants" — so the row for `seq` is the first of a one-row page from
	// `seq`, not from `seq-1`. The identity is checked rather than assumed: a pruned `seq` makes
	// the page start at the next surviving handshake, and quarantining whoever committed THAT
	// would punish a device nobody reported.
	rows, err := d.opts.Store.ListHandshakes(ctx, groupID, seq, 1)
	if err != nil {
		return err
	}
	if len(rows) == 0 || rows[0].Seq != seq {
		// The reported handshake is not in the log — pruned, or a seq this instance never
		// appended. The reports stand; there is nobody to quarantine.
		return nil
	}
	committer := rows[0].SenderDevice
	if committer == nil {
		// The instance's own external sender cannot be quarantined; a quorum against an instance
		// handshake is a bug report, not a moderation event.
		d.log().Error("fork quorum against an instance handshake",
			"group", groupID.String()[:8], "seq", seq)
		return nil
	}
	if err := d.opts.Store.QuarantineDevice(ctx, *committer, d.now(), "fork quorum"); err != nil {
		return err
	}
	if rows[0].SenderLeaf == nil {
		return nil
	}
	return d.ProposeRemove(ctx, groupID, *rows[0].SenderLeaf, id.New())
}
