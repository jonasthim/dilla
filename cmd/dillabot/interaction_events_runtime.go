//go:build linux

package main

import (
	"context"
	"errors"
	"sync"

	"github.com/jonasthim/dilla/internal/bot/helper"
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

type interactionEventDescriptorSource interface {
	InteractionGroups(context.Context) ([]native.InteractionGroupDescriptor, error)
}

type interactionEventDispatcher interface {
	Dispatch(context.Context, native.GroupEvent) (string, error)
	ReauthorizeReadReplay(context.Context, native.GroupEvent) error
}

type interactionEventResponseSender interface {
	ResumeInteractionResponse(context.Context, native.GroupEvent, func(context.Context) error) (bool, error)
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
	group, err := inspectInteractionEventGroup(ctx, h.native, event)
	if err != nil {
		return err
	}
	if group.ID != event.Group {
		return errors.New("native interaction event group inspection mismatch")
	}
	if group.Kind != 3 {
		return errors.New("unsupported native bot event group kind")
	}
	// Resume a committed response before dispatch so a retry does not rerun the
	// dispatcher when its exact response is already durable.
	resumed, err := h.sender.ResumeInteractionResponse(ctx, event, func(preflightCtx context.Context) error {
		return h.dispatcher.ReauthorizeReadReplay(preflightCtx, event)
	})
	if err != nil {
		return err
	}
	if resumed {
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

// inspectInteractionEventGroup keeps ordinary groups on the generic path. A Bot's native generic
// inspector intentionally refuses kind-3 groups, so interaction events use an exact active
// descriptor from their bound native store and the authenticated event sender.
func inspectInteractionEventGroup(ctx context.Context, inspector interactionEventInspection, event native.GroupEvent) (native.GroupInfo, error) {
	group, err := inspector.InspectGroup(ctx, event.Group)
	if err == nil {
		return group, nil
	}
	var status *helper.StatusError
	if !errors.As(err, &status) || status.Status != 2 {
		return native.GroupInfo{}, err
	}
	source, ok := inspector.(interactionEventDescriptorSource)
	if !ok {
		return native.GroupInfo{}, err
	}
	descriptors, listErr := source.InteractionGroups(ctx)
	if listErr != nil {
		return native.GroupInfo{}, listErr
	}
	var found *native.InteractionGroupDescriptor
	for i := range descriptors {
		if descriptors[i].Group != event.Group {
			continue
		}
		if found != nil {
			return native.GroupInfo{}, errors.New("duplicate native interaction event group")
		}
		found = &descriptors[i]
	}
	if found == nil {
		return native.GroupInfo{}, err
	}
	b := found.Binding
	if found.State != 2 || found.Group.IsZero() || b.Instance.IsZero() || b.Installation.IsZero() || b.Community != event.Community ||
		b.BotUser.IsZero() || found.BotDevice.IsZero() || b.ParticipantUser.IsZero() || b.ParticipantDevice.IsZero() ||
		b.ParticipantUser != event.Channel || b.ParticipantUser != event.SenderUser || b.ParticipantDevice != event.SenderDevice ||
		b.PolicyVersion == 0 || b.E2EEVersion != 1 || b.MediaVersion != 0 {
		return native.GroupInfo{}, errors.New("native interaction event group does not match its authenticated sender")
	}
	community := b.Community
	return native.GroupInfo{ID: found.Group, Kind: 3, Community: &community, Target: b.ParticipantUser, State: found.State, Epoch: found.Epoch}, nil
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
