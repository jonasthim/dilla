package api

import (
	"slices"
	"time"

	"github.com/jonasthim/dilla/internal/id"
)

// PendingRepairs is how many grant repairs are outstanding across every call.
func (h *Calls) PendingRepairs() int { return h.leases.pendingCount() }

// MarkPending records a pending repair of dev in call's room, as a failed cut would.
func (h *Calls) MarkPending(call, dev id.ID, room string) {
	h.leases.markPending(call, dev.String(), pendingRepair{Room: room, DropSlot: true})
}

// SetSweepEvery sets the retry loop's room-sweep cadence, for a test that runs the loop.
func (h *Calls) SetSweepEvery(d time.Duration) { h.sweepEvery = d }

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
