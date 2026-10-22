//go:build linux

package main

import (
	"context"
	"errors"
	"sync"

	"github.com/jonasthim/dilla/internal/bot/native"
	"github.com/jonasthim/dilla/internal/bot/service"
	"github.com/jonasthim/dilla/internal/id"
)

const maxInteractionEventPollPasses = 4

var errInteractionResponseNotAccepted = errors.New("interaction response has no confirmed accepted receipt")

type interactionEventPoller interface {
	PollOnce(context.Context, service.GroupEventHandler) (service.GroupEventPollResult, error)
}

type interactionEventInspection interface {
	InspectGroup(context.Context, id.ID) (native.GroupInfo, error)
}

type interactionEventDispatcher interface {
	Dispatch(context.Context, native.GroupEvent) (string, error)
}

type interactionEventResponseSender interface {
	SendInteractionResponse(context.Context, native.GroupEvent, string) (bool, error)
}

type interactionEventHandler struct {
	native     interactionEventInspection
	dispatcher interactionEventDispatcher
	sender     interactionEventResponseSender
}

func newInteractionEventHandler(n interactionEventInspection, dispatcher interactionEventDispatcher, sender interactionEventResponseSender) service.GroupEventHandler {
	return interactionEventHandler{native: n, dispatcher: dispatcher, sender: sender}
}

func (h interactionEventHandler) HandleGroupEvent(ctx context.Context, event native.GroupEvent) error {
	if ctx == nil || h.native == nil || h.dispatcher == nil || h.sender == nil || event.DeliveryID == 0 || event.Group.IsZero() {
		return errors.New("missing or invalid native interaction event dependency")
	}
	group, err := h.native.InspectGroup(ctx, event.Group)
	if err != nil {
		return err
	}
	if group.ID != event.Group {
		return errors.New("native interaction event group inspection mismatch")
	}
	if group.Kind != 3 {
		return nil
	}
	response, err := h.dispatcher.Dispatch(ctx, event)
	if err != nil {
		return err
	}
	// The sender must durably bind the exact response and send parameters to
	// this event before it sends. Nil means the server accepted the encrypted
	// response and its receipt was confirmed in the native outbox. This keeps
	// the poller's acknowledgement from advancing on an uncertain send.
	accepted, err := h.sender.SendInteractionResponse(ctx, event, response)
	if err != nil {
		return err
	}
	if !accepted {
		return errInteractionResponseNotAccepted
	}
	return nil
}

type interactionEventRuntime struct {
	mu      sync.Mutex
	poller  interactionEventPoller
	handler service.GroupEventHandler
}

func newInteractionEventRuntime(poller interactionEventPoller, handler service.GroupEventHandler) *interactionEventRuntime {
	return &interactionEventRuntime{poller: poller, handler: handler}
}

func (r *interactionEventRuntime) Drain(ctx context.Context) (service.GroupEventPollResult, error) {
	var total service.GroupEventPollResult
	if r == nil || ctx == nil || r.poller == nil || r.handler == nil {
		return total, errors.New("missing interaction event runtime dependency")
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	for pass := 0; pass < maxInteractionEventPollPasses; pass++ {
		if err := ctx.Err(); err != nil {
			return total, err
		}
		result, err := r.poller.PollOnce(ctx, r.handler)
		total.Handled += result.Handled
		if result.AcknowledgedThrough > total.AcknowledgedThrough {
			total.AcknowledgedThrough = result.AcknowledgedThrough
		}
		total.More = result.More
		if err != nil {
			return total, err
		}
		if !result.More {
			break
		}
	}
	return total, nil
}
