package gateway

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/fxamacker/cbor/v2"
	"github.com/jonasthim/dilla/internal/cborx"
	"github.com/jonasthim/dilla/internal/clock"
)

// recordingSink is the transport double. Its stall gate is a mutex-guarded bool plus a
// sync.Cond, never a channel field that is reassigned: the writer goroutine reads the gate on
// every write while the test goroutine flips it, and `go test -race -count=4` is a gate this
// package must pass.
type recordingSink struct {
	frames chan []byte
	closed chan CloseCode

	mu      sync.Mutex
	cond    *sync.Cond
	stalled bool
	shut    bool
}

func newRecordingSink(depth int, stalled bool) *recordingSink {
	s := &recordingSink{
		frames:  make(chan []byte, depth),
		closed:  make(chan CloseCode, 1),
		stalled: stalled,
	}
	s.cond = sync.NewCond(&s.mu)
	return s
}

func (s *recordingSink) write(_ context.Context, b []byte) error {
	s.mu.Lock()
	for s.stalled && !s.shut {
		s.cond.Wait()
	}
	shut := s.shut
	s.mu.Unlock()
	if shut {
		return errors.New("sink closed")
	}
	s.frames <- b
	return nil
}

// stall and release are the only way the gate moves after construction.
func (s *recordingSink) stall() {
	s.mu.Lock()
	s.stalled = true
	s.mu.Unlock()
}

func (s *recordingSink) release() {
	s.mu.Lock()
	s.stalled = false
	s.mu.Unlock()
	s.cond.Broadcast()
}

func (s *recordingSink) close(code CloseCode, _ string) {
	s.mu.Lock()
	s.shut = true
	s.mu.Unlock()
	// Waking every blocked writer is what stops a stalled test from leaking its goroutine.
	s.cond.Broadcast()
	select {
	case s.closed <- code:
	default:
	}
}

func TestAnOverflowingWriterClosesFourZeroZeroEight(t *testing.T) {
	sink := newRecordingSink(64, true)
	t.Cleanup(sink.release)
	clk := clock.NewFake(time.Unix(1_700_000_000, 0))
	w := newWriter(sink, writerLimits{Frames: 2, Bytes: 1 << 20, Deadline: time.Second}, clk)
	t.Cleanup(w.stop)

	payload := cbor.RawMessage{0x80} // []
	for range 8 {
		w.enqueue(Frame{Op: OpPresence, Payload: payload}, 0)
	}
	select {
	case code := <-sink.closed:
		if code != CloseRateLimited {
			t.Fatalf("close code = %d, want 4008", code)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("an overflowing queue must close the connection, not block the producer")
	}
}

// The byte bound is enforced independently of the frame bound: 4 frames of 64 KiB stay well under
// QueueFrames and well over a 128 KiB QueueBytes, and the connection must still close 4008.
func TestAWriterOverTheByteBoundClosesFourZeroZeroEightWhileUnderTheFrameBound(t *testing.T) {
	sink := newRecordingSink(64, true)
	t.Cleanup(sink.release)
	clk := clock.NewFake(time.Unix(1_700_000_000, 0))
	w := newWriter(sink, writerLimits{Frames: 256, Bytes: 128 << 10, Deadline: time.Second}, clk)
	t.Cleanup(w.stop)

	big, err := cborx.Marshal([]any{make([]byte, 64<<10)})
	if err != nil {
		t.Fatalf("payload: %v", err)
	}
	for range 4 {
		w.enqueue(Frame{Op: OpMessageCT, Payload: cbor.RawMessage(big), Replay: true}, 1)
	}
	select {
	case code := <-sink.closed:
		if code != CloseRateLimited {
			t.Fatalf("close code = %d, want 4008", code)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("the byte bound is declared but not enforced: four 64 KiB frames fitted in a 128 KiB queue")
	}
}

// Deliver* must never block a producer: the DS holds no lock while fanning out, and a stalled
// socket must not stall a commit.
func TestEnqueueNeverBlocks(t *testing.T) {
	sink := newRecordingSink(1, false)
	clk := clock.NewFake(time.Unix(1_700_000_000, 0))
	w := newWriter(sink, writerLimits{Frames: 1, Bytes: 64, Deadline: time.Second}, clk)
	t.Cleanup(w.stop)

	done := make(chan struct{})
	go func() {
		for range 1000 {
			w.enqueue(Frame{Op: OpPresence, Payload: cbor.RawMessage{0x80}}, 0)
		}
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("enqueue blocked")
	}
}

// The first heartbeat is jittered into [0, heartbeat_ms) so 1,500 clients reconnecting after a
// restart do not synchronise onto one second (protocol/02, "Liveness"). firstDelay is armed by
// Gateway.register in task 18; this is the distribution test interfaces §10 task 17 names.
func TestTheFirstHeartbeatIsJitteredIntoTheInterval(t *testing.T) {
	p := newHeartbeatPolicy(30 * time.Second)
	buckets := make([]int, 6)
	for range 6000 {
		d := p.firstDelay()
		if d < 0 || d >= p.interval {
			t.Fatalf("firstDelay = %v, want [0, %v)", d, p.interval)
		}
		buckets[int(d/(5*time.Second))]++
	}
	for i, n := range buckets {
		if n == 0 {
			t.Errorf("bucket %d (%ds-%ds) is empty; the first beat is not jittered across the interval",
				i, i*5, (i+1)*5)
		}
	}
}
