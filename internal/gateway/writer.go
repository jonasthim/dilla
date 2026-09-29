package gateway

import (
	"context"
	"log/slog"
	"sync"
	"time"

	"github.com/coder/websocket"

	"github.com/jonasthim/dilla/internal/clock"
)

// sink is the transport half a connection drives: the writer owns its write end, `serve` and
// `readLoop` own its read end. The real implementation wraps a *websocket.Conn; the tests use a
// recording double, because what is under test is the queueing discipline, not the library.
type sink interface {
	write(ctx context.Context, b []byte) error
	read(ctx context.Context) (websocket.MessageType, []byte, error)
	close(code CloseCode, reason string)
}

type writerLimits struct {
	Frames   int
	Bytes    int
	Deadline time.Duration
}

type queued struct {
	frame Frame
	// raw is an already-encoded frame, set only by enqueueRaw for the resume replay. When it is
	// non-nil writeOne writes it verbatim: a replayed frame carries the n it was first sent with.
	raw  []byte
	n    uint64
	at   time.Time
	size int
}

// frameOverhead is what Encode adds around a payload: the four-element array head, the opcode,
// n as a uint64 head, and a 16-byte group_id with its bstr head. It is an upper bound, so the
// byte accounting never under-counts a queued frame.
const frameOverhead = 32

// writer owns one connection's outbound path: one goroutine, a queue bounded on BOTH frames and
// bytes, and a non-blocking enqueue so no producer ever blocks on a slow socket. Overflow closes
// 4008, which is deliberately resumable — the client reconnects and replays from its ring.
//
// The byte bound is not decoration: QueueFrames is 256 and MaxFrameBytes is 131 584, so a
// frame-only bound lets one stalled connection pin ~32 MiB. interfaces §6.1 makes QueueBytes part
// of the contract, and `withDefaults` raises RingBytes to match it, so whatever the queue refuses
// is still replayable from the ring.
type writer struct {
	sink   sink
	limits writerLimits
	clk    clock.Clock
	queue  chan queued
	done   chan struct{}
	// finished is closed by run's defer, so drain can wait for the outstanding frames.
	finished chan struct{}
	// log is where a dropped frame is recorded. It is set once, before run starts, and never
	// written again; nil means the process default logger.
	log *slog.Logger

	mu          sync.Mutex
	queuedBytes int
}

// newWriter starts a writer whose dropped frames go to the process default logger. The Gateway
// passes its own logger through newWriterWithLogger instead.
func newWriter(s sink, l writerLimits, clk clock.Clock) *writer {
	return newWriterWithLogger(s, l, clk, nil)
}

func newWriterWithLogger(s sink, l writerLimits, clk clock.Clock, log *slog.Logger) *writer {
	w := &writer{
		sink:     s,
		limits:   l,
		clk:      clk,
		queue:    make(chan queued, l.Frames),
		done:     make(chan struct{}),
		finished: make(chan struct{}),
		log:      log,
	}
	go w.run()
	return w
}

// enqueue never blocks. A queue that is full on either axis is a slow consumer, and the answer to
// a slow consumer is to disconnect it, not to stall the delivery service.
func (w *writer) enqueue(f Frame, n uint64) {
	size := len(f.Payload) + frameOverhead
	w.mu.Lock()
	if w.queuedBytes+size > w.limits.Bytes {
		w.mu.Unlock()
		w.sink.close(CloseRateLimited, "writer queue byte bound")
		return
	}
	w.queuedBytes += size
	w.mu.Unlock()
	select {
	case w.queue <- queued{frame: f, n: n, at: w.clk.Now(), size: size}:
	default:
		w.mu.Lock()
		w.queuedBytes -= size
		w.mu.Unlock()
		w.sink.close(CloseRateLimited, "writer queue overflow")
	}
}

// enqueueRaw queues an already-encoded frame. Resume replay is its only caller: a replayed frame
// carries the n it was first sent with, so passing it back through Encode would re-stamp it.
func (w *writer) enqueueRaw(b []byte) {
	w.mu.Lock()
	if w.queuedBytes+len(b) > w.limits.Bytes {
		w.mu.Unlock()
		w.sink.close(CloseRateLimited, "writer queue byte bound")
		return
	}
	w.queuedBytes += len(b)
	w.mu.Unlock()
	select {
	case w.queue <- queued{raw: b, at: w.clk.Now(), size: len(b)}:
	default:
		w.mu.Lock()
		w.queuedBytes -= len(b)
		w.mu.Unlock()
		w.sink.close(CloseRateLimited, "writer queue overflow")
	}
}

func (w *writer) run() {
	defer close(w.finished)
	for {
		select {
		case <-w.done:
			return
		case q := <-w.queue:
			if !w.writeOne(q) {
				return
			}
		}
	}
}

// writeOne encodes and writes one queued frame, releasing its bytes from the queue accounting
// whatever the outcome. It reports whether the writer may continue.
func (w *writer) writeOne(q queued) bool {
	defer func() {
		w.mu.Lock()
		w.queuedBytes -= q.size
		w.mu.Unlock()
	}()
	if q.raw != nil {
		ctx, cancel := context.WithTimeout(context.Background(), w.limits.Deadline)
		err := w.sink.write(ctx, q.raw)
		cancel()
		if err != nil {
			w.sink.close(CloseUnknown, "write")
			return false
		}
		return true
	}
	frame := q.frame
	// R31/D11: mls.commit_needed's deadline is relative to the moment the frame reaches
	// the writer, so it is re-based here and nowhere else.
	if frame.Op == OpMLSCommitNeeded {
		// The elapsed time is the QUEUE wait: q.at is stamped by enqueue. The interval between the
		// delivery service minting deadline_ms in RequestCommit and the frame reaching enqueue is
		// not subtracted, which is a small under-count and is stated here rather than hidden; the
		// queue wait is the part that can reach seconds under a slow consumer.
		rebased, err := rebaseDeadline(frame.Payload, w.clk.Now().Sub(q.at))
		if err != nil {
			// The frame is DROPPED, not sent with its stale deadline: a client that acts on a
			// deadline the instance has already passed will be re-elected against, and a silently
			// swallowed error here is how that becomes invisible. The connection survives the
			// drop — logDropped logs it — so `return true` is the writer carrying on.
			w.logDropped(frame, err)
			return true
		}
		frame.Payload = rebased
	}
	b, err := Encode(frame, q.n)
	if err != nil {
		w.sink.close(CloseUnknown, "encode")
		return false
	}
	ctx, cancel := context.WithTimeout(context.Background(), w.limits.Deadline)
	err = w.sink.write(ctx, b)
	cancel()
	if err != nil {
		w.sink.close(CloseUnknown, "write")
		return false
	}
	return true
}

// logDropped records a frame the writer refused to send and LEAVES THE CONNECTION UP: one
// malformed mls.commit_needed payload is a delivery-service bug, not a reason to disconnect a
// client that has done nothing wrong, and writeOne goes on serving the queue. The brief's body
// closed the sink here and still returned true, so the writer kept writing into a socket it had
// just closed and the connection ended on the next failed write's reason instead of this one.
func (w *writer) logDropped(f Frame, err error) {
	attrs := []any{
		slog.Int("op", int(f.Op)),
		slog.String("err", err.Error()),
	}
	if f.GroupID != nil {
		attrs = append(attrs, slog.String("group_id", f.GroupID.String()))
	}
	w.logger().Warn("gateway: frame dropped by the writer", attrs...)
}

// logger is the writer's logger, or the process default when the Gateway passed none. Keeping it
// behind an accessor is what lets newWriter stay a three-parameter call.
func (w *writer) logger() *slog.Logger {
	if w.log != nil {
		return w.log
	}
	return slog.Default()
}

func (w *writer) stop() {
	select {
	case <-w.done:
	default:
		close(w.done)
	}
}

// drain lets the writer finish what is already queued, then stops it, bounded by ctx. Shutdown
// uses it so the `reconnect` frame is on the wire before the socket closes: `run` selects between
// `done` and `queue` and Go picks at random when both are ready, so stopping first would drop the
// last frame about half the time.
func (w *writer) drain(ctx context.Context) {
	for {
		w.mu.Lock()
		pending := w.queuedBytes
		w.mu.Unlock()
		if pending == 0 {
			w.stop()
			return
		}
		// The one-millisecond poll is a backoff between two reads of queuedBytes, not a deadline
		// the gateway's behaviour is defined over, so it is REAL time and not w.clk: a
		// clock.Fake only advances when a test advances it, and drain is called from inside
		// Shutdown on the test's own goroutine, so a fake timer here would never fire and
		// Shutdown would never return. It is a timer the loop stops on every path.
		t := time.NewTimer(time.Millisecond)
		select {
		case <-ctx.Done():
			t.Stop()
			w.stop()
			<-w.finished
			return
		case <-w.finished:
			t.Stop()
			return
		case <-t.C:
		}
	}
}
