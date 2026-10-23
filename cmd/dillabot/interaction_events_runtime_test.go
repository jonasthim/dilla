//go:build linux

package main

import (
	"context"
	"errors"
	"sync"
	"testing"

	"github.com/jonasthim/dilla/internal/bot/helper"
	"github.com/jonasthim/dilla/internal/bot/native"
	"github.com/jonasthim/dilla/internal/bot/service"
	"github.com/jonasthim/dilla/internal/id"
)

type interactionPollerFunc func(context.Context, service.GroupEventHandler) (service.GroupEventPollResult, error)

func (f interactionPollerFunc) PollOnce(ctx context.Context, h service.GroupEventHandler) (service.GroupEventPollResult, error) {
	return f(ctx, h)
}

type interactionGroupInspectorFunc func(context.Context, id.ID) (native.GroupInfo, error)

func (f interactionGroupInspectorFunc) InspectGroup(ctx context.Context, group id.ID) (native.GroupInfo, error) {
	return f(ctx, group)
}

type interactionEventDescriptorInspector struct {
	descriptors []native.InteractionGroupDescriptor
	err         error
	listCalls   int
}

func (i *interactionEventDescriptorInspector) InspectGroup(context.Context, id.ID) (native.GroupInfo, error) {
	return native.GroupInfo{}, i.err
}

func (i *interactionEventDescriptorInspector) InteractionGroups(context.Context) ([]native.InteractionGroupDescriptor, error) {
	i.listCalls++
	return i.descriptors, nil
}

type interactionDispatcherFunc func(context.Context, native.GroupEvent) (string, error)

func (f interactionDispatcherFunc) Dispatch(ctx context.Context, event native.GroupEvent) (string, error) {
	return f(ctx, event)
}

func (interactionDispatcherFunc) ReauthorizeReadReplay(context.Context, native.GroupEvent) error {
	return nil
}

type interactionResponseSenderFunc func(context.Context, native.GroupEvent, string) (bool, error)

func (f interactionResponseSenderFunc) ResumeInteractionResponse(context.Context, native.GroupEvent, func(context.Context) error) (bool, error) {
	return false, nil
}

func (f interactionResponseSenderFunc) SendInteractionResponse(ctx context.Context, event native.GroupEvent, response string) (bool, error) {
	return f(ctx, event, response)
}

type interactionResumingSender struct {
	resumed bool
	sends   int
}

func (s *interactionResumingSender) ResumeInteractionResponse(context.Context, native.GroupEvent, func(context.Context) error) (bool, error) {
	return s.resumed, nil
}

func (s *interactionResumingSender) SendInteractionResponse(context.Context, native.GroupEvent, string) (bool, error) {
	s.sends++
	return true, nil
}

type interactionPreflightResumingSender struct{ calls int }

func (s *interactionPreflightResumingSender) ResumeInteractionResponse(ctx context.Context, _ native.GroupEvent, preflight func(context.Context) error) (bool, error) {
	s.calls++
	return false, preflight(ctx)
}

func (*interactionPreflightResumingSender) SendInteractionResponse(context.Context, native.GroupEvent, string) (bool, error) {
	return false, errors.New("denied replay reached a fresh send")
}

func TestInteractionEventHandlerDispatchesOnlyNativeInteractionGroups(t *testing.T) {
	event := native.GroupEvent{DeliveryID: 4, Group: id.New()}
	dispatches, sends := 0, 0
	handler := newInteractionEventHandler(
		interactionGroupInspectorFunc(func(_ context.Context, group id.ID) (native.GroupInfo, error) {
			if group != event.Group {
				t.Fatal("inspection used a different group")
			}
			return native.GroupInfo{ID: group, Kind: 3}, nil
		}),
		interactionDispatcherFunc(func(_ context.Context, got native.GroupEvent) (string, error) {
			dispatches++
			if got.DeliveryID != event.DeliveryID {
				t.Fatal("dispatcher received a different event")
			}
			return "encoded-response", nil
		}),
		interactionResponseSenderFunc(func(_ context.Context, got native.GroupEvent, response string) (bool, error) {
			sends++
			if got.DeliveryID != event.DeliveryID || response != "encoded-response" {
				t.Fatal("sender received a mismatched event or response")
			}
			return true, nil
		}),
	)
	if err := handler.HandleGroupEvent(context.Background(), event); err != nil {
		t.Fatal(err)
	}
	if dispatches != 1 || sends != 1 {
		t.Fatalf("dispatches=%d sends=%d", dispatches, sends)
	}

	handler = newInteractionEventHandler(
		interactionGroupInspectorFunc(func(_ context.Context, group id.ID) (native.GroupInfo, error) {
			return native.GroupInfo{ID: group, Kind: 0}, nil
		}),
		interactionDispatcherFunc(func(context.Context, native.GroupEvent) (string, error) {
			t.Fatal("text group reached dispatcher")
			return "", nil
		}),
		interactionResponseSenderFunc(func(context.Context, native.GroupEvent, string) (bool, error) {
			t.Fatal("text group reached response sender")
			return false, nil
		}),
	)
	if err := handler.HandleGroupEvent(context.Background(), event); err == nil {
		t.Fatal("unsupported text group was silently accepted")
	}
}

func TestInteractionEventHandlerResolvesKind3AfterGenericScopeRefusal(t *testing.T) {
	group, community, participant, device := id.New(), id.New(), id.New(), id.New()
	event := native.GroupEvent{DeliveryID: 7, Group: group, Community: community, Channel: participant, SenderUser: participant, SenderDevice: device}
	descriptor := native.InteractionGroupDescriptor{Group: group, BotDevice: id.New(), State: 2, Binding: native.InteractionGroupBinding{
		Instance: id.New(), Installation: id.New(), Community: community, BotUser: id.New(), ParticipantUser: participant,
		ParticipantDevice: device, PolicyVersion: 1, E2EEVersion: 1,
	}}
	inspector := &interactionEventDescriptorInspector{err: &helper.StatusError{Status: 2}, descriptors: []native.InteractionGroupDescriptor{descriptor}}
	dispatches := 0
	handler := newInteractionEventHandler(inspector,
		interactionDispatcherFunc(func(context.Context, native.GroupEvent) (string, error) { dispatches++; return "response", nil }),
		&interactionResumingSender{})
	router := newGroupEventRouter(inspector, handler, nil, 0, 0)
	if err := router.HandleGroupEvent(context.Background(), event); err != nil {
		t.Fatal(err)
	}
	if dispatches != 1 || inspector.listCalls != 2 {
		t.Fatalf("dispatches=%d descriptor lookups=%d", dispatches, inspector.listCalls)
	}
	event.SenderDevice = id.New()
	if err := router.HandleGroupEvent(context.Background(), event); err == nil {
		t.Fatal("event from a different participant device was accepted")
	}
	if dispatches != 1 {
		t.Fatal("mismatched participant device reached dispatcher")
	}
}

func TestInteractionEventHandlerLeavesUnsupportedTextGroupUnacknowledged(t *testing.T) {
	event := native.GroupEvent{DeliveryID: 9, Group: id.New()}
	handler := newInteractionEventHandler(
		interactionGroupInspectorFunc(func(_ context.Context, group id.ID) (native.GroupInfo, error) {
			return native.GroupInfo{ID: group, Kind: 0}, nil
		}),
		interactionDispatcherFunc(func(context.Context, native.GroupEvent) (string, error) {
			t.Fatal("text group reached interaction dispatcher")
			return "", nil
		}),
		interactionResponseSenderFunc(func(context.Context, native.GroupEvent, string) (bool, error) {
			t.Fatal("text group reached response sender")
			return false, nil
		}),
	)
	acked := false
	poller := interactionPollerFunc(func(ctx context.Context, h service.GroupEventHandler) (service.GroupEventPollResult, error) {
		if err := h.HandleGroupEvent(ctx, event); err != nil {
			return service.GroupEventPollResult{}, err
		}
		acked = true
		return service.GroupEventPollResult{Handled: 1, AcknowledgedThrough: event.DeliveryID}, nil
	})
	_, err := newInteractionEventRuntime(poller, handler).Drain(context.Background())
	if err == nil || acked {
		t.Fatalf("Drain error=%v acked=%v; unsupported group must stay pending", err, acked)
	}
}

func TestInteractionEventHandlerFailsClosedUntilResponseSendConfirmed(t *testing.T) {
	event := native.GroupEvent{DeliveryID: 2, Group: id.New()}
	sendErr := errors.New("durable accepted receipt unavailable")
	handler := newInteractionEventHandler(
		interactionGroupInspectorFunc(func(_ context.Context, group id.ID) (native.GroupInfo, error) {
			return native.GroupInfo{ID: group, Kind: 3}, nil
		}),
		interactionDispatcherFunc(func(context.Context, native.GroupEvent) (string, error) { return "private response", nil }),
		interactionResponseSenderFunc(func(context.Context, native.GroupEvent, string) (bool, error) { return false, sendErr }),
	)
	acked := false
	poller := interactionPollerFunc(func(ctx context.Context, h service.GroupEventHandler) (service.GroupEventPollResult, error) {
		if err := h.HandleGroupEvent(ctx, event); err != nil {
			return service.GroupEventPollResult{}, err
		}
		acked = true
		return service.GroupEventPollResult{Handled: 1, AcknowledgedThrough: event.DeliveryID}, nil
	})
	runtime := newInteractionEventRuntime(poller, handler)
	_, err := runtime.Drain(context.Background())
	if !errors.Is(err, sendErr) || acked {
		t.Fatalf("Drain error=%v acked=%v", err, acked)
	}
}

func TestInteractionEventHandlerResumesCommittedResponseBeforeDispatch(t *testing.T) {
	event := native.GroupEvent{DeliveryID: 5, Group: id.New()}
	sender := &interactionResumingSender{resumed: true}
	dispatches := 0
	handler := newInteractionEventHandler(
		interactionGroupInspectorFunc(func(_ context.Context, group id.ID) (native.GroupInfo, error) {
			return native.GroupInfo{ID: group, Kind: 3}, nil
		}),
		interactionDispatcherFunc(func(context.Context, native.GroupEvent) (string, error) {
			dispatches++
			return "response", nil
		}),
		sender,
	).(interactionEventHandler)
	if err := handler.HandleGroupEvent(context.Background(), event); err != nil {
		t.Fatal(err)
	}
	if dispatches != 0 || sender.sends != 0 {
		t.Fatalf("dispatches=%d fresh sends=%d; committed response must resume before dispatch", dispatches, sender.sends)
	}
}

func TestInteractionEventHandlerKeepsRevokedPendingReadResponseUnacknowledged(t *testing.T) {
	event := native.GroupEvent{DeliveryID: 6, Group: id.New()}
	denied := errors.New("read permission revoked")
	dispatches := 0
	sender := &interactionPreflightResumingSender{}
	guarded := readReplayGuardDispatcher{interactionDispatcherFunc: interactionDispatcherFunc(func(context.Context, native.GroupEvent) (string, error) {
		dispatches++
		return "response", nil
	}), authorize: func(context.Context, native.GroupEvent) error { return denied }}
	handler := newInteractionEventHandler(
		interactionGroupInspectorFunc(func(_ context.Context, group id.ID) (native.GroupInfo, error) {
			return native.GroupInfo{ID: group, Kind: 3}, nil
		}),
		guarded,
		sender,
	).(interactionEventHandler)
	// The saved outbox response must remain pending and must not fall through
	// to dispatch after the fresh authorization check denies it.
	acked := false
	poller := interactionPollerFunc(func(ctx context.Context, h service.GroupEventHandler) (service.GroupEventPollResult, error) {
		if err := h.HandleGroupEvent(ctx, event); err != nil {
			return service.GroupEventPollResult{}, err
		}
		acked = true
		return service.GroupEventPollResult{Handled: 1, AcknowledgedThrough: event.DeliveryID}, nil
	})
	_, err := newInteractionEventRuntime(poller, handler).Drain(context.Background())
	if !errors.Is(err, denied) || acked || sender.calls != 1 || dispatches != 0 {
		t.Fatalf("Drain err=%v acked=%v resume checks=%d dispatches=%d", err, acked, sender.calls, dispatches)
	}
}

type readReplayGuardDispatcher struct {
	interactionDispatcherFunc
	authorize func(context.Context, native.GroupEvent) error
}

func (d readReplayGuardDispatcher) ReauthorizeReadReplay(ctx context.Context, event native.GroupEvent) error {
	return d.authorize(ctx, event)
}

func TestInteractionEventRuntimeSerializesAndBoundsDrain(t *testing.T) {
	var mu sync.Mutex
	active, maxActive, calls := 0, 0, 0
	poller := interactionPollerFunc(func(context.Context, service.GroupEventHandler) (service.GroupEventPollResult, error) {
		mu.Lock()
		active++
		if active > maxActive {
			maxActive = active
		}
		calls++
		mu.Unlock()
		defer func() { mu.Lock(); active--; mu.Unlock() }()
		return service.GroupEventPollResult{Handled: 1, More: true}, nil
	})
	runtime := newInteractionEventRuntime(poller, groupEventHandlerFuncForTest(func(context.Context, native.GroupEvent) error { return nil }))
	var wg sync.WaitGroup
	for range 2 {
		wg.Add(1)
		go func() { defer wg.Done(); _, _ = runtime.Drain(context.Background()) }()
	}
	wg.Wait()
	if maxActive != 1 || calls != 2*maxInteractionEventPollPasses {
		t.Fatalf("max concurrent polls=%d calls=%d", maxActive, calls)
	}
}

type groupEventHandlerFuncForTest func(context.Context, native.GroupEvent) error

func (f groupEventHandlerFuncForTest) HandleGroupEvent(ctx context.Context, event native.GroupEvent) error {
	return f(ctx, event)
}
