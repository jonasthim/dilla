package main

import (
	"context"
	"io"
	"log/slog"
	"sync/atomic"
	"testing"
	"time"
)

func TestBotStructuralEventPrunerUsesThirtyDayCutoffAndStops(t *testing.T) {
	now := time.Unix(1_800_000_000, 0)
	ctx, cancel := context.WithCancel(context.Background())
	called := make(chan int64, 4)
	var calls atomic.Int32
	done := make(chan struct{})
	go func() {
		defer close(done)
		runBotStructuralEventPruner(ctx, 5*time.Millisecond, func() time.Time { return now },
			func(_ context.Context, cutoff int64) (int64, error) {
				called <- cutoff
				calls.Add(1)
				return 0, nil
			}, slog.New(slog.NewTextHandler(io.Discard, nil)))
	}()

	want := now.Add(-30 * 24 * time.Hour).Unix()
	select {
	case got := <-called:
		if got != want {
			t.Fatalf("initial prune cutoff = %d, want %d", got, want)
		}
	case <-time.After(time.Second):
		t.Fatal("pruner did not run at startup")
	}
	select {
	case got := <-called:
		if got != want {
			t.Fatalf("periodic prune cutoff = %d, want %d", got, want)
		}
	case <-time.After(time.Second):
		t.Fatal("pruner did not run periodically")
	}

	cancel()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("pruner did not stop after cancellation")
	}
	stoppedAt := calls.Load()
	time.Sleep(20 * time.Millisecond)
	if got := calls.Load(); got != stoppedAt {
		t.Fatalf("prune calls after cancellation = %d, want %d", got, stoppedAt)
	}
}
