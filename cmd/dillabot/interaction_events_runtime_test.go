//go:build linux

package main

import (
	"context"
	"errors"
	"sync"
	"testing"

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

type interactionDispatcherFunc func(context.Context, native.GroupEvent) (string, error)

func (f interactionDispatcherFunc) Dispatch(ctx context.Context, event native.GroupEvent) (string, error) {
	return f(ctx, event)
}

type interactionResponseSenderFunc func(context.Context, native.GroupEvent, string) (bool, error)

func (f interactionResponseSenderFunc) SendInteractionResponse(ctx context.Context, event native.GroupEvent, response string) (bool, error) {
	return f(ctx, event, response)
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
	if err := handler.HandleGroupEvent(context.Background(), event); err != nil {
		t.Fatalf("ignore non-interaction group: %v", err)
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
