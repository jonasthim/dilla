package service

import (
	"context"
	"errors"
	"fmt"
	"math"
	"time"

	"github.com/jonasthim/dilla/internal/bot/native"
	"github.com/jonasthim/dilla/internal/cborx"
	"github.com/jonasthim/dilla/internal/id"
)

// GroupEventMaxPendingAge bounds how long one event may fail at the head of the shared queue.
// After this long since its first failed handling attempt (Jonas 2026-10-30: one hour), the
// poller acknowledges it as undeliverable, whatever the cause, so a cause no handler classifies
// (a terminal send after restore, a resync that never finishes, a future bug) cannot stall every
// Bot reply indefinitely. The first-failure time is durable in the helper's state store.
const GroupEventMaxPendingAge = time.Hour

const (
	groupEventFailureArea    = uint64(8)
	groupEventFailureKey     = "dilla.bot.group-event-failure.v1/"
	groupEventFailureVersion = uint64(1)
)

// groupEventFailureState is the helper state store; *native.Client implements it. Without it the
// age limit cannot be proven and failing events simply stay pending.
type groupEventFailureState interface {
	StateGet(context.Context, uint64, []byte) (native.StateValue, error)
	StateTransaction(context.Context, id.ID, []native.StateChange) ([]uint64, error)
}

type groupEventNative interface {
	Binding() native.Binding
	ReadGroupEvents(context.Context, uint64, uint64) (native.GroupEventPage, error)
	AcknowledgeGroupEvents(context.Context, uint64) error
}

// GroupEventHandler processes one authenticated, decrypted native event.
// It must make externally visible effects idempotent by event identity because
// a lost acknowledgement causes the event to be delivered again.
type GroupEventHandler interface {
	HandleGroupEvent(context.Context, native.GroupEvent) error
}

var ErrGroupEventHandler = errors.New("group event handler failed")

// GroupEventHandlerError keeps the failed delivery and its cause. It still matches
// ErrGroupEventHandler, so the event stays pending exactly as before.
type GroupEventHandlerError struct {
	DeliveryID uint64
	Err        error
}

func (e *GroupEventHandlerError) Error() string {
	return fmt.Sprintf("%s at delivery %d: %v", ErrGroupEventHandler.Error(), e.DeliveryID, e.Err)
}
func (e *GroupEventHandlerError) Unwrap() []error { return []error{ErrGroupEventHandler, e.Err} }

// UndeliverableGroupEvent is implemented by a handler error that proves the event can never be
// handled (for example, its group is gone or outside interaction scope, or its saved read was
// definitively denied). The poller acknowledges such an event instead of retrying it forever,
// because the queue is shared by every group and user: an unacknowledged head blocks all later
// events durably, across restarts.
//
// Only errors that are proven permanent may implement it. Acknowledging an event is
// irreversible: an undeliverable error for a transient failure (network, server 5xx, busy,
// rate limit, cancellation, a missing row that may still arrive) would drop a valid command.
type UndeliverableGroupEvent interface {
	error
	Undeliverable() bool
}

func isUndeliverableGroupEvent(err error) bool {
	var u UndeliverableGroupEvent
	return errors.As(err, &u) && u.Undeliverable()
}

// SkippedGroupEvent records one undeliverable event the poller acknowledged, for the caller's log.
// FirstFailure is set when the event was skipped by GroupEventMaxPendingAge; Cause is then the
// last handler error.
type SkippedGroupEvent struct {
	DeliveryID   uint64
	FirstFailure time.Time
	Cause        error
}

// ErrGroupEventPendingTooLong marks an event acknowledged because it stayed pending for
// GroupEventMaxPendingAge.
var ErrGroupEventPendingTooLong = errors.New("group event stayed pending past the age limit")

type GroupEventPollResult struct {
	Handled             uint64
	Skipped             []SkippedGroupEvent // undeliverable events acknowledged without handling
	AcknowledgedThrough uint64
	More                bool
}

// GroupEventPoller drains one bounded page of the helper's durable event queue.
// The native helper, rather than this process, persists the acknowledgement.
type GroupEventPoller struct {
	native  groupEventNative
	binding native.Binding
	now     func() time.Time
}

func NewGroupEventPoller(n *native.Client) (*GroupEventPoller, error) {
	if n == nil {
		return nil, errors.New("missing group event source")
	}
	return newGroupEventPoller(n)
}

func newGroupEventPoller(n groupEventNative) (*GroupEventPoller, error) {
	if n == nil {
		return nil, errors.New("missing group event source")
	}
	b := n.Binding()
	if b.Instance.IsZero() || b.Community.IsZero() || b.Installation.IsZero() {
		return nil, errors.New("invalid group event binding")
	}
	return &GroupEventPoller{native: n, binding: b, now: time.Now}, nil
}

func (p *GroupEventPoller) PollOnce(ctx context.Context, handler GroupEventHandler) (GroupEventPollResult, error) {
	var result GroupEventPollResult
	if p == nil || handler == nil || ctx == nil {
		return result, errors.New("missing group event poll dependency")
	}
	page, err := p.native.ReadGroupEvents(ctx, 0, 100)
	if err != nil {
		return result, err
	}
	if len(page.Events) > 100 || page.Next > page.HighWater {
		return result, errors.New("invalid group event page")
	}
	for _, event := range page.Events {
		if err := ctx.Err(); err != nil {
			return result, err
		}
		if event.Community != p.binding.Community || event.DeliveryID <= result.AcknowledgedThrough || event.DeliveryID > page.Next {
			return result, errors.New("invalid group event binding or order")
		}
		var skipped *SkippedGroupEvent
		if err := handler.HandleGroupEvent(ctx, event); err != nil {
			if ctx.Err() != nil {
				// Never skip, and never start an event's age, on a cancelled pass.
				return result, &GroupEventHandlerError{DeliveryID: event.DeliveryID, Err: err}
			}
			if isUndeliverableGroupEvent(err) {
				skipped = &SkippedGroupEvent{DeliveryID: event.DeliveryID, Cause: err}
			} else {
				first, aged, ageErr := p.failureAge(ctx, event.DeliveryID)
				if ageErr != nil || !aged || ctx.Err() != nil {
					return result, &GroupEventHandlerError{DeliveryID: event.DeliveryID, Err: errors.Join(err, ageErr)}
				}
				skipped = &SkippedGroupEvent{DeliveryID: event.DeliveryID, FirstFailure: first,
					Cause: fmt.Errorf("%w (first failure %s): %w", ErrGroupEventPendingTooLong, first.UTC().Format(time.RFC3339), err)}
			}
		}
		if err := p.native.AcknowledgeGroupEvents(ctx, event.DeliveryID); err != nil {
			return result, err
		}
		if skipped == nil {
			result.Handled++
		} else {
			result.Skipped = append(result.Skipped, *skipped)
		}
		result.AcknowledgedThrough = event.DeliveryID
	}
	if page.Next > result.AcknowledgedThrough {
		if err := p.native.AcknowledgeGroupEvents(ctx, page.Next); err != nil {
			return result, err
		}
		result.AcknowledgedThrough = page.Next
	}
	result.More = page.Next < page.HighWater
	return result, nil
}

// failureAge records the first failed handling time of delivery durably (only the queue head can
// fail, so one record per installation suffices) and reports whether it is older than
// GroupEventMaxPendingAge. Any state error keeps the event pending.
func (p *GroupEventPoller) failureAge(ctx context.Context, delivery uint64) (time.Time, bool, error) {
	state, ok := p.native.(groupEventFailureState)
	if !ok {
		return time.Time{}, false, nil
	}
	now := p.now()
	if now.Unix() <= 0 || delivery > math.MaxInt64 {
		return time.Time{}, false, errors.New("invalid group event failure clock or delivery")
	}
	key := []byte(groupEventFailureKey + p.binding.Installation.String())
	current, err := state.StateGet(ctx, groupEventFailureArea, key)
	if err != nil {
		return time.Time{}, false, err
	}
	if !current.Tombstone && len(current.Value) > 0 {
		var record []uint64
		if err := cborx.Unmarshal(current.Value, &record); err != nil || len(record) != 3 || record[0] != groupEventFailureVersion || record[2] == 0 || record[2] > math.MaxInt64 {
			return time.Time{}, false, errors.New("invalid group event failure record")
		}
		if record[1] == delivery {
			first := time.Unix(int64(record[2]), 0)
			return first, now.Sub(first) >= GroupEventMaxPendingAge, nil
		}
	}
	value, err := cborx.Marshal([]uint64{groupEventFailureVersion, delivery, uint64(now.Unix())})
	if err != nil {
		return time.Time{}, false, err
	}
	if _, err := state.StateTransaction(ctx, id.New(), []native.StateChange{{Area: groupEventFailureArea, Key: key, ExpectedRevision: current.Revision, Value: value}}); err != nil {
		return time.Time{}, false, err
	}
	return now, false, nil
}

var _ groupEventFailureState = (*native.Client)(nil)
