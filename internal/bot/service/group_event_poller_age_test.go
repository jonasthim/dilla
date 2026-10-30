package service

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/jonasthim/dilla/internal/bot/native"
	"github.com/jonasthim/dilla/internal/id"
)

func ageTestQueue() *durableGroupEventQueue {
	community := id.New()
	return &durableGroupEventQueue{binding: native.Binding{Instance: id.New(), Community: community, Installation: id.New()},
		events: []native.GroupEvent{{DeliveryID: 1, Community: community, Group: id.New()}, {DeliveryID: 2, Community: community, Group: id.New()}}}
}

// pollAt builds a fresh poller per call, as every reconcile pass and every restart does.
func pollAt(t *testing.T, ctx context.Context, q *durableGroupEventQueue, at time.Time, handler GroupEventHandler) (GroupEventPollResult, error) {
	t.Helper()
	p, err := newGroupEventPoller(q)
	if err != nil {
		t.Fatal(err)
	}
	p.now = func() time.Time { return at }
	return p.PollOnce(ctx, handler)
}

func TestGroupEventPollerAgeLimitSkipsOnlyAfterAnHourOfFailuresAndSurvivesRestarts(t *testing.T) {
	q := ageTestQueue()
	transient := errors.New("send receipt is terminal after restore")
	var handled []uint64
	handler := groupEventHandlerFunc(func(_ context.Context, event native.GroupEvent) error {
		if event.DeliveryID == 1 {
			return transient
		}
		handled = append(handled, event.DeliveryID)
		return nil
	})
	start := time.Unix(1_800_000_000, 0)
	// Failing for just under the limit, across several fresh pollers (restarts), stays pending.
	for _, at := range []time.Time{start, start.Add(10 * time.Minute), start.Add(GroupEventMaxPendingAge - time.Second)} {
		result, err := pollAt(t, context.Background(), q, at, handler)
		if !errors.Is(err, transient) || q.acked != 0 || len(result.Skipped) != 0 || len(handled) != 0 {
			t.Fatalf("at +%s: err=%v acked=%d skipped=%v; a failure younger than the limit must stay pending", at.Sub(start), err, q.acked, result.Skipped)
		}
	}
	// At the limit the first-failure time recorded by the first poller still counts.
	result, err := pollAt(t, context.Background(), q, start.Add(GroupEventMaxPendingAge), handler)
	if err != nil || q.acked != 2 || len(handled) != 1 || handled[0] != 2 || len(result.Skipped) != 1 {
		t.Fatalf("at the limit: err=%v acked=%d handled=%v skipped=%v", err, q.acked, handled, result.Skipped)
	}
	skip := result.Skipped[0]
	if skip.DeliveryID != 1 || !skip.FirstFailure.Equal(start) || !errors.Is(skip.Cause, ErrGroupEventPendingTooLong) || !errors.Is(skip.Cause, transient) {
		t.Fatalf("skip = %+v; want delivery 1, its first-failure time and its last cause", skip)
	}
}

func TestGroupEventPollerAgeRestartsForANewHeadEvent(t *testing.T) {
	q := ageTestQueue()
	start := time.Unix(1_800_000_000, 0)
	fail := errors.New("transient")
	// Event 1 fails at start, then succeeds; event 2 first fails much later and gets its own age.
	if _, err := pollAt(t, context.Background(), q, start, groupEventHandlerFunc(func(context.Context, native.GroupEvent) error { return fail })); !errors.Is(err, fail) {
		t.Fatal(err)
	}
	late := start.Add(3 * GroupEventMaxPendingAge)
	result, err := pollAt(t, context.Background(), q, late, groupEventHandlerFunc(func(_ context.Context, e native.GroupEvent) error {
		if e.DeliveryID == 2 {
			return fail
		}
		return nil
	}))
	if !errors.Is(err, fail) || q.acked != 1 || len(result.Skipped) != 0 {
		t.Fatalf("err=%v acked=%d skipped=%v; a newly failing event must not inherit an older event's age", err, q.acked, result.Skipped)
	}
}

func TestGroupEventPollerNeverSkipsUnderCancellation(t *testing.T) {
	start := time.Unix(1_800_000_000, 0)
	t.Run("undeliverable error", func(t *testing.T) {
		q := ageTestQueue()
		ctx, cancel := context.WithCancel(context.Background())
		defer cancel()
		_, err := pollAt(t, ctx, q, start, groupEventHandlerFunc(func(context.Context, native.GroupEvent) error {
			cancel()
			return goneGroupError{}
		}))
		if err == nil || q.acked != 0 {
			t.Fatalf("err=%v acked=%d; nothing may be acknowledged under cancellation", err, q.acked)
		}
	})
	t.Run("past the age limit", func(t *testing.T) {
		q := ageTestQueue()
		fail := errors.New("transient")
		if _, err := pollAt(t, context.Background(), q, start, groupEventHandlerFunc(func(context.Context, native.GroupEvent) error { return fail })); !errors.Is(err, fail) {
			t.Fatal(err)
		}
		ctx, cancel := context.WithCancel(context.Background())
		defer cancel()
		_, err := pollAt(t, ctx, q, start.Add(2*GroupEventMaxPendingAge), groupEventHandlerFunc(func(context.Context, native.GroupEvent) error {
			cancel()
			return fail
		}))
		if err == nil || q.acked != 0 {
			t.Fatalf("err=%v acked=%d; an aged event may not be skipped under cancellation", err, q.acked)
		}
	})
}

func TestGroupEventPollerKeepsEventPendingWhenItsAgeCannotBeRecorded(t *testing.T) {
	q := ageTestQueue()
	q.stateErr = errors.New("helper state unavailable")
	fail := errors.New("transient")
	start := time.Unix(1_800_000_000, 0)
	for _, at := range []time.Time{start, start.Add(5 * GroupEventMaxPendingAge)} {
		if _, err := pollAt(t, context.Background(), q, at, groupEventHandlerFunc(func(context.Context, native.GroupEvent) error { return fail })); !errors.Is(err, fail) || q.acked != 0 {
			t.Fatalf("err=%v acked=%d; an unprovable age must keep the event pending", err, q.acked)
		}
	}
}

func TestGroupEventPollerRetriesASkipWhoseAcknowledgementFailed(t *testing.T) {
	q := ageTestQueue()
	q.ackFails = 1
	calls := 0
	handler := groupEventHandlerFunc(func(_ context.Context, e native.GroupEvent) error {
		if e.DeliveryID == 1 {
			calls++
			return goneGroupError{}
		}
		return nil
	})
	result, err := pollAt(t, context.Background(), q, time.Unix(1_800_000_000, 0), handler)
	if err == nil || q.acked != 0 || len(result.Skipped) != 0 {
		t.Fatalf("err=%v acked=%d skipped=%v; an unacknowledged skip must not be reported", err, q.acked, result.Skipped)
	}
	result, err = pollAt(t, context.Background(), q, time.Unix(1_800_000_000, 0), handler)
	if err != nil || q.acked != 2 || calls != 2 || len(result.Skipped) != 1 || result.Skipped[0].DeliveryID != 1 {
		t.Fatalf("retry: err=%v acked=%d calls=%d skipped=%v", err, q.acked, calls, result.Skipped)
	}
}
