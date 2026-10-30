package service

import (
	"context"
	"errors"
	"fmt"

	"github.com/jonasthim/dilla/internal/bot/native"
)

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
// handled (for example, its group has left the native store). The poller acknowledges such an
// event instead of retrying it forever, because the queue is shared by every group and user:
// an unacknowledged head blocks all later events durably, across restarts.
type UndeliverableGroupEvent interface {
	error
	Undeliverable() bool
}

func isUndeliverableGroupEvent(err error) bool {
	var u UndeliverableGroupEvent
	return errors.As(err, &u) && u.Undeliverable()
}

// SkippedGroupEvent records one undeliverable event the poller acknowledged, for the caller's log.
type SkippedGroupEvent struct {
	DeliveryID uint64
	Cause      error
}

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
	return &GroupEventPoller{native: n, binding: b}, nil
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
		var skipped error
		if err := handler.HandleGroupEvent(ctx, event); err != nil {
			if ctx.Err() != nil || !isUndeliverableGroupEvent(err) {
				return result, &GroupEventHandlerError{DeliveryID: event.DeliveryID, Err: err}
			}
			skipped = err
		}
		if err := p.native.AcknowledgeGroupEvents(ctx, event.DeliveryID); err != nil {
			return result, err
		}
		if skipped == nil {
			result.Handled++
		} else {
			result.Skipped = append(result.Skipped, SkippedGroupEvent{DeliveryID: event.DeliveryID, Cause: skipped})
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
