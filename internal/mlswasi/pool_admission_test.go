package mlswasi

import (
	"context"
	"errors"
	"sync/atomic"
	"testing"
	"time"
)

func TestPoolAdmissionCancellationAndShutdown(t *testing.T) {
	var priorities atomic.Int32
	r := newTestRuntime(t, Options{PoolSize: 1, Priority: func(context.Context) int {
		priorities.Add(1)
		return 1
	}})
	held, err := r.Acquire(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	defer held.Release()
	ctx, cancel := context.WithCancel(t.Context())
	waiterDone := make(chan error, 1)
	go func() { _, err := r.Acquire(ctx); waiterDone <- err }()
	cancel()
	if err := <-waiterDone; !errors.Is(err, context.Canceled) {
		t.Fatalf("cancelled acquisition = %v", err)
	}
	if priorities.Load() != 2 {
		t.Fatal("pool did not apply its priority callback to acquisitions")
	}
	go func() { _, err := r.Acquire(t.Context()); waiterDone <- err }()
	closeDone := make(chan error, 1)
	go func() { closeDone <- r.Close(context.Background()) }()
	select {
	case err := <-waiterDone:
		if !errors.Is(err, ErrClosed) {
			t.Fatalf("acquisition during shutdown = %v", err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("shutdown did not wake queued acquisition")
	}
	select {
	case err := <-closeDone:
		t.Fatalf("runtime closed while an instance was acquired: %v", err)
	default:
	}
	held.Release()
	select {
	case err := <-closeDone:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("runtime did not close after instance release")
	}
	if _, err := r.Acquire(t.Context()); !errors.Is(err, ErrClosed) {
		t.Fatalf("acquisition after shutdown = %v", err)
	}
}
