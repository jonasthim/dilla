package ds

import (
	"context"
	"time"

	"github.com/jonasthim/dilla/internal/id"
)

// runWatchdog ticks every WatchdogInterval (2 s) and advances every overdue election.
func (d *DS) runWatchdog(ctx context.Context) {
	ticker := time.NewTicker(d.opts.Policy.WatchdogInterval)
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
	}
	var due []overdue

	d.elections.mu.Lock()
	for groupID, e := range d.elections.m {
		if e.candidate == (id.ID{}) || now.Sub(e.sentAt) < d.opts.Policy.WatchdogInterval {
			continue
		}
		due = append(due, overdue{groupID: groupID, candidate: e.candidate, acked: e.acked})
		if e.acked {
			e.lost[e.candidate]++
		}
	}
	d.elections.mu.Unlock()

	for _, o := range due {
		if o.acked && d.lostRounds(o.groupID, o.candidate) >= d.opts.Policy.MaxLostRounds {
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
// DEVIATION from the task brief, which writes `d.Sweep(ctx)`: there is no `Sweep`. Invariant 6's
// TTL sweep is `sweepProposals`, landed by task 21 and exported to the tests as
// `SweepProposalsForTest`; retention pruning is task 26's and joins this tick when it lands. The
// brief's name is the one task 26 introduces, not one this tree holds.
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
			if _, err := d.sweepProposals(ctx); err != nil {
				d.log().Error("sweep failed", "err", err)
			}
		}
	}
}
