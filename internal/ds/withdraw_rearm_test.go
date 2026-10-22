package ds_test

// withdraw_rearm_test.go: UP6b review fix. A re-arm of a WITHDRAWN row that fails inside its
// transaction must leave the ref queued in the guest: unqueueProposal keeps a ref SQL still holds,
// and a withdrawn row is still held (the listings leave it out). Taken out, a later commit applying
// the ref would be refused 422 by g.Process instead of 409 `withdrawn` (correction C3).

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/jonasthim/dilla/internal/ds"
	"github.com/jonasthim/dilla/internal/id"
)

func TestAFailedReArmOfAWithdrawnRowKeepsItQueued(t *testing.T) {
	for _, fault := range []string{"AppendHandshake", "ReissueProposal"} {
		t.Run(fault, func(t *testing.T) {
			h := newDSHarness(t)
			ctx := context.Background()
			g := h.callGroupWithMembers(t, 3)
			removed := h.absent(t, g, 1)
			if n, err := h.resume(t, g, 1); err != nil || n != 1 {
				t.Fatalf("resume = %d, %v", n, err)
			}
			h.clk.Advance(ds.WithdrawnStandWindow + time.Second)
			leaf, added := h.membershipOf(t, g, 1)

			h.failNextTx(fault)
			if err := h.ds.ProposeAbsenceRemove(ctx, g.id, leaf, g.members[1], added, id.New()); !errors.Is(err, errInjected) {
				t.Fatalf("the re-arm with %s failing: got %v, want the injected failure", fault, err)
			}
			h.failNextTx("")
			if w := h.withdrawnRows(t, g); len(w) != 1 {
				t.Fatalf("%d withdrawn rows after the failed re-arm, want the one still marked", len(w))
			}
			if !h.guestHolds(t, g.id, removed.Ref, false) {
				t.Fatal("the failed re-arm took the withdrawn ref out of the guest's queue")
			}
			if !h.guestHolds(t, g.id, removed.Ref, true) {
				t.Fatal("the state blob no longer holds the withdrawn ref")
			}
		})
	}
}
