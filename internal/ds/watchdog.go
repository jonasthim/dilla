package ds

import (
	"context"
	"time"

	"github.com/jonasthim/dilla/internal/id"
)

// watchdogInterval is the tick, and never a non-positive duration: time.NewTicker panics on one,
// inside a goroutine Start cannot recover from. New already fills every unset Policy field from
// DefaultPolicy (normalisePolicy), so this is the second belt rather than the first.
func (d *DS) watchdogInterval() time.Duration {
	if d.opts.Policy.WatchdogInterval <= 0 {
		return DefaultPolicy().WatchdogInterval
	}
	return d.opts.Policy.WatchdogInterval
}

// runWatchdog ticks every WatchdogInterval (2 s) and advances every overdue election.
func (d *DS) runWatchdog(ctx context.Context) {
	ticker := time.NewTicker(d.watchdogInterval())
	defer ticker.Stop()
	for {
		select {
		case <-d.stop:
			return
		case <-ctx.Done():
			return
		case <-ticker.C:
			d.RunWatchdogOnce(ctx)
		}
	}
}

// RunWatchdogOnce advances every election whose deadline has passed. It is exported so a test
// driving a clock.Fake can run exactly one tick rather than waiting on wall time.
func (d *DS) RunWatchdogOnce(ctx context.Context) {
	now := d.opts.Clock.Now()
	type overdue struct {
		groupID   id.ID
		candidate id.ID
		acked     bool
		round     uint64
		epoch     uint64
	}
	var due []overdue

	d.elections.mu.Lock()
	for groupID, e := range d.elections.m {
		if e.candidate == (id.ID{}) || now.Sub(e.sentAt) < d.watchdogInterval() {
			continue
		}
		due = append(due, overdue{
			groupID: groupID, candidate: e.candidate, acked: e.acked,
			round: e.round, epoch: e.epoch,
		})
	}
	d.elections.mu.Unlock()

	for _, o := range due {
		// A ROUND THAT WAS WON is not a round that was lost. The election is charged nowhere else,
		// so this is the one place that distinction is made: an accepted Commit clears the group's
		// election (commit step (8b)), and where the watchdog's tick beats that clear — the window
		// between the next proposal's row and its own RequestCommit, which spans DeliverGroup's
		// fan-out to every member — the group's epoch has already moved past the one the round was
		// elected for. Either way the candidate committed exactly what it was told to commit, and
		// three such charges would remove it from the group by an instance Remove.
		row, err := d.opts.Store.GetGroup(ctx, o.groupID)
		if err != nil {
			d.log().Error("reading the group of an overdue election failed",
				"group", o.groupID.String()[:8], "err", err)
			continue
		}
		if row.Epoch != o.epoch {
			d.clearElection(o.groupID)
			if d.opts.Metrics != nil {
				d.opts.Metrics.ElectionRounds.WithLabelValues("won").Inc()
			}
			// Whatever is outstanding at the NEW epoch gets a fresh election, from round one of a
			// fresh rotation.
			if err := d.RequestCommit(ctx, o.groupID); err != nil {
				d.log().Error("re-electing after a won round failed",
					"group", o.groupID.String()[:8], "err", err)
			}
			continue
		}
		lost := 0
		if o.acked {
			lost = d.chargeLostRound(o.groupID, o.candidate, o.round)
		}
		if o.acked && lost >= d.opts.Policy.MaxLostRounds {
			// Three acknowledged-and-lost rounds: the device is removed by an instance Remove.
			// ProposeRemove, not proposeRemoveLocked: the watchdog runs on its own goroutine and
			// holds no group lock, so it is the locking form that is correct here.
			if leaf, err := d.leafOf(ctx, o.groupID, o.candidate); err == nil {
				if err := d.ProposeRemove(ctx, o.groupID, leaf, id.New()); err != nil {
					d.log().Error("watchdog remove failed",
						"group", o.groupID.String()[:8], "err", err)
				}
			}
			d.resetLost(o.groupID, o.candidate)
			if d.opts.Metrics != nil {
				d.opts.Metrics.ElectionRounds.WithLabelValues("removed").Inc()
			}
			continue
		}
		if d.opts.Metrics != nil {
			label := "unacked"
			if o.acked {
				label = "lost"
			}
			d.opts.Metrics.ElectionRounds.WithLabelValues(label).Inc()
		}
		if err := d.RequestCommit(ctx, o.groupID); err != nil {
			d.log().Error("watchdog re-election failed",
				"group", o.groupID.String()[:8], "err", err)
		}
	}
}

// chargeLostRound charges one ACKNOWLEDGED-and-lost round and returns the running count. The
// round is named, so a round that has already been superseded between the two passes of
// RunWatchdogOnce — by a proposal's own RequestCommit, say — is not charged twice and is not
// charged to a candidate that is no longer the one that acknowledged.
func (d *DS) chargeLostRound(groupID, deviceID id.ID, round uint64) int {
	d.elections.mu.Lock()
	defer d.elections.mu.Unlock()
	e, ok := d.elections.m[groupID]
	if !ok || e.round != round || e.candidate != deviceID || !e.acked {
		return 0
	}
	e.lost[deviceID]++
	return e.lost[deviceID]
}

func (d *DS) lostRounds(groupID, deviceID id.ID) int {
	d.elections.mu.Lock()
	defer d.elections.mu.Unlock()
	if e, ok := d.elections.m[groupID]; ok {
		return e.lost[deviceID]
	}
	return 0
}

func (d *DS) resetLost(groupID, deviceID id.ID) {
	d.elections.mu.Lock()
	defer d.elections.mu.Unlock()
	if e, ok := d.elections.m[groupID]; ok {
		delete(e.lost, deviceID)
	}
}

// runSweeper voids expired proposals and prunes retention on one ticker: both are lazy evaluations
// at decision points, so one minute of granularity is enough and a test can call the sweep
// directly.
//
// Task 26 replaced the bare `sweepProposals` call with `Sweep`, which runs invariant 6's TTL sweep
// and then both halves of invariant 10's retention on the same tick. A test drives it by calling
// `Sweep` against a clock.Fake rather than by waiting on this wall-clock ticker.
func (d *DS) runSweeper(ctx context.Context) {
	ticker := time.NewTicker(time.Minute)
	defer ticker.Stop()
	for {
		select {
		case <-d.stop:
			return
		case <-ctx.Done():
			return
		case <-ticker.C:
			if _, err := d.Sweep(ctx); err != nil {
				d.log().Error("sweep failed", "err", err)
			}
		}
	}
}
