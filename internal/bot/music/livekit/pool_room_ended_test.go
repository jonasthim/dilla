package livekit

import (
	"context"
	"sync/atomic"
	"testing"
	"time"
)

func TestPoolReportsIdleRemoteDisconnectOnceAndIgnoresOldGeneration(t *testing.T) {
	p, err := NewPool(time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	defer p.Close()
	backend := &poolBackendStub{}
	p.backend = backend
	var ended atomic.Int32
	p.SetRoomEndedReporter(func() {
		// A callback may inspect/change pool configuration; it must run outside p.mu.
		p.SetRTTReporter(nil)
		ended.Add(1)
	})
	call, group := poolCall(93, 94)
	first, err := p.startSource(context.Background(), call, group, newPoolEpochs(), newPoolSource())
	if err != nil {
		t.Fatal(err)
	}
	_ = first.Close()
	backend.disconnectRoom(0)
	backend.disconnectRoom(0)
	if got := ended.Load(); got != 1 {
		t.Fatalf("idle remote room-end reports=%d want 1", got)
	}
	if err := p.Reset(); err != nil {
		t.Fatal(err)
	}
	replacement, err := p.startSource(context.Background(), call, group, newPoolEpochs(), newPoolSource())
	if err != nil {
		t.Fatal(err)
	}
	defer replacement.Close()
	backend.disconnectRoom(0)
	if got := ended.Load(); got != 1 {
		t.Fatalf("old generation cleared replacement: reports=%d", got)
	}
	backend.disconnectRoom(1)
	if got := ended.Load(); got != 2 {
		t.Fatalf("replacement room-end reports=%d want 2", got)
	}
}

func TestPoolReportsIdleLeaveOnce(t *testing.T) {
	p, err := NewPool(time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	defer p.Close()
	backend := &poolBackendStub{}
	p.backend = backend
	var ended atomic.Int32
	p.SetRoomEndedReporter(func() { p.SetRTTReporter(nil); ended.Add(1) })
	call, group := poolCall(95, 96)
	session, err := p.startSource(context.Background(), call, group, newPoolEpochs(), newPoolSource())
	if err != nil {
		t.Fatal(err)
	}
	_ = session.Close()
	if err := p.LeaveIdle(); err != nil {
		t.Fatal(err)
	}
	backend.disconnectRoom(0)
	if got := ended.Load(); got != 1 {
		t.Fatalf("idle leave reports=%d want 1", got)
	}
}
