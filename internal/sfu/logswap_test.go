package sfu

import (
	"context"
	"log/slog"
	"sync/atomic"
	"testing"
	"time"
)

// recordingHandler counts every record it is handed, at any level.
type recordingHandler struct{ n *atomic.Int64 }

func (recordingHandler) Enabled(context.Context, slog.Level) bool { return true }
func (h recordingHandler) Handle(context.Context, slog.Record) error {
	h.n.Add(1)
	return nil
}
func (h recordingHandler) WithAttrs([]slog.Attr) slog.Handler { return h }
func (h recordingHandler) WithGroup(string) slog.Handler      { return h }

// LiveKit's logger is installed once per process and only its handler is swapped, so two servers
// started and stopped in sequence each reach their own handler, and the first one hears nothing once
// the second has started.
func TestEachServersLogRecordsReachItsOwnHandler(t *testing.T) {
	var a, b atomic.Int64

	ca := testConfig()
	ca.Port, ca.UDPPort = 7928, 7930
	ca.Log = slog.New(recordingHandler{n: &a})
	srvA, err := Start(t.Context(), ca)
	if err != nil {
		t.Fatalf("Start A: %v", err)
	}
	if err := srvA.Stop(context.Background()); err != nil {
		t.Fatalf("Stop A: %v", err)
	}
	if a.Load() == 0 {
		t.Fatal("the first server's records never reached its handler")
	}

	cb := testConfig()
	cb.Port, cb.UDPPort = 7932, 7934
	cb.Log = slog.New(recordingHandler{n: &b})
	srvB, err := Start(t.Context(), cb)
	if err != nil {
		t.Fatalf("Start B: %v", err)
	}
	defer func() { _ = srvB.Stop(context.Background()) }()

	frozen := a.Load()
	time.Sleep(300 * time.Millisecond)
	if b.Load() == 0 {
		t.Error("the second server's records never reached its handler")
	}
	if got := a.Load(); got != frozen {
		t.Errorf("the first handler heard %d more records after the second server's Start", got-frozen)
	}
}
