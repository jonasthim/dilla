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
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(3 * time.Second):
		// Ensure a failure can still complete test cleanup.
		held.Release()
		<-closeDone
		t.Fatal("shutdown waited for a retained instance instead of closing its module")
	}
	held.Release()
	if _, err := r.Acquire(t.Context()); !errors.Is(err, ErrClosed) {
		t.Fatalf("acquisition after shutdown = %v", err)
	}
}

func TestCloseReturnsWithRetainedInstanceAndRejectsUse(t *testing.T) {
	r := newTestRuntime(t, Options{PoolSize: 1})
	held, err := r.Acquire(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	defer held.Release()
	closed := make(chan error, 1)
	go func() { closed <- r.Close(context.Background()) }()
	select {
	case err := <-closed:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		held.Release()
		<-closed
		t.Fatal("Close blocked on a retained DS group instance")
	}
	if _, err := held.Call(t.Context(), "dilla_abi", nil); !errors.Is(err, ErrClosed) {
		t.Fatalf("retained instance call after shutdown = %v, want ErrClosed", err)
	}
	// DS cache cleanup may release an instance after its runtime has closed.
	held.Release()
	held.Release()
	if _, err := held.Call(t.Context(), "dilla_abi", nil); !errors.Is(err, ErrReleased) {
		t.Fatalf("call after late release = %v, want ErrReleased", err)
	}
}

func TestCloseWaitsForActiveCallButNotRetainedInstance(t *testing.T) {
	entered, resume := make(chan struct{}), make(chan struct{})
	r := newTestRuntime(t, Options{PoolSize: 1, OnCall: func(string) {
		close(entered)
		<-resume
	}})
	held, err := r.Acquire(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	defer held.Release()
	req, err := encodeRequest()
	if err != nil {
		t.Fatal(err)
	}
	called := make(chan error, 1)
	go func() { _, err := held.Call(t.Context(), "dilla_abi", req); called <- err }()
	<-entered
	closed := make(chan error, 1)
	go func() { closed <- r.Close(context.Background()) }()
	<-r.done // Shutdown has rejected new work before waiting for the active call.
	premature := false
	select {
	case err := <-closed:
		premature = true
		if err != nil {
			t.Errorf("Close: %v", err)
		}
	case <-time.After(100 * time.Millisecond):
	}
	close(resume)
	if err := <-called; err != nil {
		t.Errorf("active call interrupted by shutdown: %v", err)
	}
	if premature {
		t.Fatal("Close destroyed the runtime while a Call was still active")
	}
	select {
	case err := <-closed:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		held.Release()
		<-closed
		t.Fatal("Close waited for retained instance ownership after the call finished")
	}
}
