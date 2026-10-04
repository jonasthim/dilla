package api

import (
	"slices"

	"github.com/jonasthim/dilla/internal/id"
)

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
