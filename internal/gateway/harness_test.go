package gateway

import (
	"context"
	"errors"
	"slices"
	"sync"
	"testing"
	"time"

	"github.com/jonasthim/dilla/internal/auth"
	"github.com/jonasthim/dilla/internal/clock"
	"github.com/jonasthim/dilla/internal/id"
	"github.com/jonasthim/dilla/internal/store"
)

type harness struct {
	gw         *Gateway
	clk        *clock.Fake
	generation uint64

	mu          sync.Mutex
	sinks       map[*conn]*recordingSink
	groups      map[id.ID][]id.ID // device -> its groups, what GroupsForDevice answers
	outstanding map[id.ID]uint64  // group -> proposals_outstanding
}

func newHarness(t *testing.T) *harness {
	t.Helper()
	clk := clock.NewFake(time.Unix(1_700_000_000, 0))
	h := &harness{
		clk:         clk,
		generation:  1,
		sinks:       map[*conn]*recordingSink{},
		groups:      map[id.ID][]id.ID{},
		outstanding: map[id.ID]uint64{},
	}
	h.gw = New(Options{
		Clock:      clk,
		Generation: 1,
		Store:      h, // the harness is the store double: see the three methods below
		Auth:       h, // and the Authenticator double
		Outstanding: func(_ context.Context, g id.ID) uint64 {
			h.mu.Lock()
			defer h.mu.Unlock()
			return h.outstanding[g]
		},
	})
	t.Cleanup(func() { _ = h.gw.Shutdown(context.Background()) })
	return h
}

func (h *harness) setGroupsForDevice(device id.ID, groups ...id.ID) {
	h.mu.Lock()
	h.groups[device] = groups
	h.mu.Unlock()
}

func (h *harness) setOutstanding(group id.ID, n uint64) {
	h.mu.Lock()
	h.outstanding[group] = n
	h.mu.Unlock()
}

// connect registers a ready connection without a socket: the transport is task 17's sink
// interface, so the registry and fan-out are testable without a WebSocket.
func (h *harness) connect(t *testing.T, device id.ID) *conn {
	t.Helper()
	sink := newRecordingSink(1024, false)
	c, err := h.gw.register(context.Background(),
		auth.Session{DeviceID: device, UserID: id.New(), Scope: auth.ScopeEnrolled}, sink)
	if err != nil {
		t.Fatalf("register: %v", err)
	}
	h.mu.Lock()
	h.sinks[c] = sink
	h.mu.Unlock()
	return c
}

// stall and release drive the sink's own mutex-guarded gate. The gate is NEVER a channel field
// reassigned from the test goroutine: the writer goroutine reads it on every write, and
// `go test -race -count=4` is this package's gate.
func (h *harness) stall(c *conn)   { h.sink(c).stall() }
func (h *harness) release(c *conn) { h.sink(c).release() }

func (h *harness) sink(c *conn) *recordingSink {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.sinks[c]
}

func (h *harness) suspend(c *conn)                                { h.gw.suspend(c) }
func (h *harness) setLeaves(group id.ID, leaves map[id.ID]uint32) { h.gw.SetGroupLeaves(group, leaves) }
func (h *harness) setBots(devices ...id.ID)                       { h.gw.SetBotDevices(devices) }

func (h *harness) waitRawFrame(t *testing.T, device id.ID) []byte {
	t.Helper()
	h.mu.Lock()
	var sink *recordingSink
	for c, s := range h.sinks {
		if c.deviceID == device {
			sink = s
			break
		}
	}
	h.mu.Unlock()
	if sink == nil {
		t.Fatalf("device %s has no connection", device)
	}
	select {
	case b := <-sink.frames:
		return b
	case <-time.After(2 * time.Second):
		t.Fatalf("no frame reached device %s", device)
		return nil
	}
}

func (h *harness) waitFrame(t *testing.T, device id.ID) Inbound {
	t.Helper()
	in, err := decodeAny(h.waitRawFrame(t, device))
	if err != nil {
		t.Fatalf("decode: %v", err)
	}
	return in
}

func (h *harness) waitClose(t *testing.T, c *conn) CloseCode {
	t.Helper()
	select {
	case code := <-h.sink(c).closed:
		return code
	case <-time.After(2 * time.Second):
		t.Fatal("no close")
		return 0
	}
}

// readFrom waits for one frame on a sink the harness did not register (serve's own sink).
func (h *harness) readFrom(t *testing.T, s *recordingSink) Inbound {
	t.Helper()
	select {
	case b := <-s.frames:
		in, err := decodeAny(b)
		if err != nil {
			t.Fatalf("decode: %v", err)
		}
		return in
	case <-time.After(2 * time.Second):
		t.Fatal("no frame")
		return Inbound{}
	}
}

func (h *harness) waitCloseOn(t *testing.T, s *recordingSink) CloseCode {
	t.Helper()
	select {
	case code := <-s.closed:
		return code
	case <-time.After(2 * time.Second):
		t.Fatal("no close")
		return 0
	}
}

func mustEncode(t *testing.T, f Frame, n uint64) []byte {
	t.Helper()
	b, err := Encode(f, n)
	if err != nil {
		t.Fatalf("Encode: %v", err)
	}
	return b
}

// --- the two doubles the gateway needs -----------------------------------------------------------
// GroupsForDevice, GetCursor and CountKeyPackages are the only three store methods the gateway
// calls, so the harness satisfies gateway.Store (the narrow interface Options.Store holds) rather
// than store.Repository: a real SQLite repository here would test the storage layer, not the
// gateway.

func (h *harness) GroupsForDevice(_ context.Context, device id.ID) ([]id.ID, error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	return slices.Clone(h.groups[device]), nil
}

func (h *harness) GetCursor(_ context.Context, _, _ id.ID) (store.CursorRow, error) {
	return store.CursorRow{LastSeq: 0, LastEpoch: 0}, nil
}

func (h *harness) CountKeyPackages(_ context.Context, _ id.ID, _ int64) (int64, error) {
	return 32, nil
}

// Resolve accepts any non-empty token and mints an enrolled session, which is what the frame-level
// tests need; auth's own refusals are internal/auth's tests, not the gateway's.
func (h *harness) Resolve(_ context.Context, bearer string) (auth.Session, error) {
	if bearer == "" {
		return auth.Session{}, errors.New("no token")
	}
	return auth.Session{UserID: id.New(), DeviceID: id.New(), Scope: auth.ScopeEnrolled}, nil
}
