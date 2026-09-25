package ds

import (
	"context"
	"sync"
	"time"

	"github.com/jonasthim/dilla/internal/gateway"
	"github.com/jonasthim/dilla/internal/id"
)

// election is one group's in-flight committer round. It lives in memory: an election that was
// decided while everybody was away is stale by definition, and the instance re-elects.
type election struct {
	round     uint64
	candidate id.ID
	sentAt    time.Time
	acked     bool
	// lost counts ACKNOWLEDGED rounds this device failed to commit. An unacknowledged round only
	// advances the election — the frame reaching the connection's writer is not an
	// acknowledgement (protocol/02 invariant 7 as amended).
	lost  map[id.ID]int
	tried map[id.ID]struct{}
}

type elections struct {
	mu sync.Mutex
	m  map[id.ID]*election
}

// RequestCommit elects a committer and sends mls.commit_needed. It is called whenever an instance
// proposal is issued and whenever the watchdog advances a round.
func (d *DS) RequestCommit(ctx context.Context, groupID id.ID) error {
	row, err := d.opts.Store.GetGroup(ctx, groupID)
	if err != nil {
		return err
	}
	refs, err := d.refsOf(ctx, groupID, row.Epoch)
	if err != nil {
		return err
	}
	if len(refs) == 0 {
		d.clearElection(groupID)
		return nil
	}

	// A DS built without a gateway (the seam tests) can elect nobody: there is no candidate list
	// and no way to address the frame.
	if d.opts.Gateway == nil {
		d.clearElection(groupID)
		return nil
	}
	candidates := d.opts.Gateway.OnlineIn(groupID) // already bots-first, then by leaf index
	if len(candidates) == 0 {
		// No candidate: arm nothing. The next ready re-elects, which is what the online predicate
		// is for.
		d.clearElection(groupID)
		return nil
	}

	// The whole mutate-and-choose block runs under d.elections.mu, inside beginRound. Writing
	// e.tried, e.candidate, e.acked and e.sentAt out here with no lock held would race
	// RunWatchdogOnce, which reads exactly those fields under the mutex from its own goroutine —
	// a map write against a map read, which `go test -race ./internal/ds/` reports.
	chosen, round := d.beginRound(groupID, candidates, d.opts.Clock.Now())

	payload, err := gateway.CommitNeededPayload(
		row.Epoch, refs, uint64(d.opts.Policy.CommitDeadline/time.Millisecond), round)
	if err != nil {
		return err
	}
	// n = 0: the frame is never replayed. deadline_ms is re-based by the writer (R31, D11).
	d.opts.Gateway.DeliverDevice(chosen, gateway.Frame{
		Op: gateway.OpMLSCommitNeeded, GroupID: &groupID, Payload: payload,
	})
	if d.opts.Metrics != nil {
		d.opts.Metrics.ElectionRounds.WithLabelValues("sent").Inc()
	}
	return nil
}

// CurrentRound reports the live round of a group's election, or 0 when none is armed. The
// acknowledgement carries a round, and a caller that acks a number it guessed acks nothing:
// AckCommitNeeded returns early on a round mismatch, so `e.acked` would never be set and the
// watchdog would never count a lost round.
func (d *DS) CurrentRound(groupID id.ID) uint64 {
	d.elections.mu.Lock()
	defer d.elections.mu.Unlock()
	if e, ok := d.elections.m[groupID]; ok {
		return e.round
	}
	return 0
}

// AckCommitNeeded records that a device accepted the task. Only an acknowledged round can be lost.
// It is what `gateway.Options.CommitAck` is wired to in the composition root: opcode 12 carries
// [round] and the connection's own group and device.
func (d *DS) AckCommitNeeded(_ context.Context, groupID, deviceID id.ID, round uint64) error {
	d.elections.mu.Lock()
	defer d.elections.mu.Unlock()
	e, ok := d.elections.m[groupID]
	if !ok || e.round != round || e.candidate != deviceID {
		return nil // a stale ack is ignored, never an error
	}
	e.acked = true
	return nil
}

// beginRound advances the round and picks the next untried candidate, entirely under the mutex,
// and returns copies. Nothing outside this function touches an *election's fields.
func (d *DS) beginRound(groupID id.ID, candidates []gateway.OnlineDevice, now time.Time) (chosen id.ID, round uint64) {
	d.elections.mu.Lock()
	defer d.elections.mu.Unlock()
	e, ok := d.elections.m[groupID]
	if !ok {
		e = &election{lost: map[id.ID]int{}, tried: map[id.ID]struct{}{}}
		d.elections.m[groupID] = e
	}
	e.round++
	for _, c := range candidates {
		if _, tried := e.tried[c.DeviceID]; tried {
			continue
		}
		chosen = c.DeviceID
		break
	}
	if chosen == (id.ID{}) {
		// Every candidate has had this round; start the rotation again.
		e.tried = map[id.ID]struct{}{}
		chosen = candidates[0].DeviceID
	}
	e.tried[chosen] = struct{}{}
	e.candidate = chosen
	e.acked = false
	e.sentAt = now
	return chosen, e.round
}

func (d *DS) clearElection(groupID id.ID) {
	d.elections.mu.Lock()
	delete(d.elections.m, groupID)
	d.elections.mu.Unlock()
}

// armedElections is how many groups hold a live election. A group with no candidate arms nothing,
// which is the one thing "the election is in memory" has to be observable for.
func (d *DS) armedElections() int {
	d.elections.mu.Lock()
	defer d.elections.mu.Unlock()
	return len(d.elections.m)
}
