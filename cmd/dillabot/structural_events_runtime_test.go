package main

import (
	"context"
	"errors"
	"testing"

	"github.com/jonasthim/dilla/internal/bot/service"
)

func TestDrainStructuralEventsResumesMoreWithinBound(t *testing.T) {
	calls := 0
	got, err := drainStructuralEvents(context.Background(), func(context.Context) (service.StructuralEventPollResult, error) {
		calls++
		return service.StructuralEventPollResult{Processed: 2, Pages: 2, AcknowledgedThrough: uint64(calls * 2), More: true}, nil
	})
	if err != nil {
		t.Fatalf("drainStructuralEvents: %v", err)
	}
	if calls != maxStructuralEventPollPasses || got.Processed != 2*maxStructuralEventPollPasses || got.Pages != 2*maxStructuralEventPollPasses || got.AcknowledgedThrough != 2*maxStructuralEventPollPasses || !got.More {
		t.Fatalf("calls=%d result=%+v", calls, got)
	}
}

func TestDrainStructuralEventsStopsWhenCaughtUp(t *testing.T) {
	calls := 0
	got, err := drainStructuralEvents(context.Background(), func(context.Context) (service.StructuralEventPollResult, error) {
		calls++
		return service.StructuralEventPollResult{Processed: 1, Pages: 1, AcknowledgedThrough: 7}, nil
	})
	if err != nil || calls != 1 || got.More {
		t.Fatalf("calls=%d result=%+v err=%v", calls, got, err)
	}
}

func TestDrainStructuralEventsStopsOnHandlerError(t *testing.T) {
	want := errors.New("kind-3 interaction has no authenticated roster")
	calls := 0
	_, err := drainStructuralEvents(context.Background(), func(context.Context) (service.StructuralEventPollResult, error) {
		calls++
		return service.StructuralEventPollResult{}, want
	})
	if !errors.Is(err, want) || calls != 1 {
		t.Fatalf("calls=%d err=%v", calls, err)
	}
}
