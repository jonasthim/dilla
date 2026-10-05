package api

import (
	"context"
	"slices"
	"time"

	"github.com/jonasthim/dilla/internal/id"
)

// SetStartHookForTest makes start call f at its named points ("mint", "respond").
func (h *Calls) SetStartHookForTest(f func(stage string)) { h.startHook = f }

// SetEndHookForTest makes endCall call f at its named points ("closed": the call group is closed and
// the voice session not yet ended).
func (h *Calls) SetEndHookForTest(f func(stage string)) { h.endHook = f }

// ProcessQueueForTest runs one pass of the retry loop's work queue on the caller's goroutine.
func (h *Calls) ProcessQueueForTest(ctx context.Context) { h.processQueue(ctx) }

// ProcessTeardownsForTest runs the work queue's teardown pass alone on the caller's goroutine.
func (h *Calls) ProcessTeardownsForTest(ctx context.Context) { h.processTeardowns(ctx) }

// QueuedForTest is how many entries the work queue holds, and whether a request did not fit.
func (h *Calls) QueuedForTest() (int, bool) {
	h.cutMu.Lock()
	defer h.cutMu.Unlock()
	return h.queuedLocked(), h.resyncAll
}

// LockCallForTest takes call's lock and returns its release, for a test that makes a call busy.
func (h *Calls) LockCallForTest(ctx context.Context, call id.ID) (func(), error) {
	return h.leases.lockCall(ctx, call, time.Second)
}

// FlushAnnouncements waits, up to five seconds, until every queued voice_state was delivered.
func (c *CallEvents) FlushAnnouncements() {
	deadline := time.Now().Add(5 * time.Second)
	for !c.announcementsIdle() && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
}

// SaturatingAddForTest is the stats route's saturating sum.
func SaturatingAddForTest(a, b uint64) uint64 { return saturatingAdd(a, b) }

// PendingRepairs is how many grant repairs are outstanding across every call.
func (h *Calls) PendingRepairs() int { return h.leases.pendingCount() }

// MarkPending records a pending repair of dev in call's room, as a failed cut would.
func (h *Calls) MarkPending(call, dev id.ID, room string) {
	h.leases.markPending(call, dev.String(), pendingRepair{Room: room, DropSlot: true})
}

// SetSweepEvery sets the retry loop's room-sweep cadence, for a test that runs the loop.
func (h *Calls) SetSweepEvery(d time.Duration) { h.sweepEvery = d }

// CutPasses is how many retry-loop passes took a non-empty cut-request set.
func (h *Calls) CutPasses() int64 { return h.cutPasses.Load() }

// SharersOf is the devices holding a sharing slot of call, for the lease-invariant tests in
// package api_test.
func (h *Calls) SharersOf(call id.ID) []id.ID {
	h.leases.mu.Lock()
	defer h.leases.mu.Unlock()
	out := make([]id.ID, 0, len(h.leases.byCall[call]))
	for dev := range h.leases.byCall[call] {
		out = append(out, dev)
	}
	slices.SortFunc(out, func(a, b id.ID) int { return slices.Compare(a[:], b[:]) })
	return out
}
