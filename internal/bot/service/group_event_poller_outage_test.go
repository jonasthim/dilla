package service

import (
	"context"
	"errors"
	"testing"

	"github.com/jonasthim/dilla/internal/bot/native"
	"github.com/jonasthim/dilla/internal/id"
)

// durableGroupEventQueue models the native helper's event journal: the ack cursor
// survives a process restart, and every read starts after it (ReadGroupEvents(0, 100)).
type durableGroupEventQueue struct {
	binding native.Binding
	events  []native.GroupEvent
	acked   uint64
}

func (q *durableGroupEventQueue) Binding() native.Binding { return q.binding }
func (q *durableGroupEventQueue) ReadGroupEvents(_ context.Context, _, limit uint64) (native.GroupEventPage, error) {
	page := native.GroupEventPage{Next: q.acked, HighWater: q.acked}
	for _, e := range q.events {
		if e.DeliveryID > page.HighWater {
			page.HighWater = e.DeliveryID
		}
		if e.DeliveryID > q.acked && uint64(len(page.Events)) < limit {
			page.Events = append(page.Events, e)
			page.Next = e.DeliveryID
		}
	}
	return page, nil
}
func (q *durableGroupEventQueue) AcknowledgeGroupEvents(_ context.Context, through uint64) error {
	if through > q.acked {
		q.acked = through
	}
	return nil
}

// goneGroupError is what a handler returns for an event whose group can never be answered
// again (the group left the native store). It is declared here, not imported, so this test
// compiles against the code before and after the fix.
type goneGroupError struct{}

func (goneGroupError) Error() string       { return "native interaction group is no longer active" }
func (goneGroupError) Undeliverable() bool { return true }

// Production outage (CT 144, 2026-10-25..): one event whose handler can never succeed sits at
// the head of the durable queue. Every later command, for every user, waits behind it, across
// reconciliation passes and process restarts, and the log only ever says "group event handler
// failed".
func TestGroupEventPollerUndeliverableHeadDoesNotBlockLaterEventsAcrossRestarts(t *testing.T) {
	community := id.New()
	q := &durableGroupEventQueue{binding: native.Binding{Instance: id.New(), Community: community, Installation: id.New()},
		events: []native.GroupEvent{{DeliveryID: 1, Community: community, Group: id.New()}, {DeliveryID: 2, Community: community, Group: id.New()}}}
	var handled []uint64
	handler := groupEventHandlerFunc(func(_ context.Context, event native.GroupEvent) error {
		if event.DeliveryID == 1 {
			return goneGroupError{}
		}
		handled = append(handled, event.DeliveryID)
		return nil
	})
	var lastErr error
	for pass := 0; pass < 23; pass++ { // 23 logged "dispatch paused" passes, one restart in between
		p, err := newGroupEventPoller(q) // a fresh poller per pass, as reconcile() builds one
		if err != nil {
			t.Fatal(err)
		}
		_, lastErr = p.PollOnce(context.Background(), handler)
	}
	if len(handled) != 1 || handled[0] != 2 || q.acked != 2 {
		t.Fatalf("later event never dispatched behind an undeliverable head: handled=%v acked=%d lastErr=%v", handled, q.acked, lastErr)
	}
}

func TestGroupEventPollerKeepsTheHandlerCauseAndDeliveryID(t *testing.T) {
	community := id.New()
	q := &durableGroupEventQueue{binding: native.Binding{Instance: id.New(), Community: community, Installation: id.New()},
		events: []native.GroupEvent{{DeliveryID: 7, Community: community, Group: id.New()}}}
	cause := errors.New("read permission revoked")
	p, _ := newGroupEventPoller(q)
	_, err := p.PollOnce(context.Background(), groupEventHandlerFunc(func(context.Context, native.GroupEvent) error { return cause }))
	var handlerErr *GroupEventHandlerError
	if !errors.Is(err, ErrGroupEventHandler) || !errors.Is(err, cause) || !errors.As(err, &handlerErr) || handlerErr.DeliveryID != 7 || q.acked != 0 {
		t.Fatalf("PollOnce error = %v; the cause and delivery must survive and the event must stay pending", err)
	}
}
