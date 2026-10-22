package service

import (
	"context"
	"errors"

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

type GroupEventPollResult struct {
	Handled             uint64
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
		if err := handler.HandleGroupEvent(ctx, event); err != nil {
			return result, ErrGroupEventHandler
		}
		if err := p.native.AcknowledgeGroupEvents(ctx, event.DeliveryID); err != nil {
			return result, err
		}
		result.Handled++
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
