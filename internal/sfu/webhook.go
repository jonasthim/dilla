package sfu

import (
	"context"
	"log/slog"
	"net/http"
	"sync"
	"time"

	"github.com/livekit/protocol/auth"
	"github.com/livekit/protocol/livekit"
	"github.com/livekit/protocol/webhook"
)

// webhookQueueLen bounds the events waiting for the worker. LiveKit itself queues at most 200 per
// room (resource_url_notifier max_depth); 256 absorbs a burst across rooms.
const webhookQueueLen = 256

// webhookBodyLimit bounds one webhook body; a protojson event is a few KiB.
const webhookBodyLimit = 1 << 20

// webhookEventTimeout bounds the sink's work on one event.
const webhookEventTimeout = 30 * time.Second

// webhookSeenIDs is how many recent event ids the worker remembers, to drop LiveKit's retries of an
// event it already dispatched (a retry resends the same body, so the same id: SP-21 row 4).
const webhookSeenIDs = 1024

type webhookHandler struct {
	provider auth.KeyProvider
	sink     func(context.Context, *livekit.WebhookEvent)
	log      *slog.Logger
	queue    chan *livekit.WebhookEvent
	done     chan struct{}
	stopped  chan struct{}
	stop     sync.Once
}

// NewWebhookHandler is the receiver SP-21 decided on (task 11). It verifies each POST under the
// SFU's own key (webhook.ReceiveWebhookEvent: the JWT in the Authorization header and its sha256
// claim over the body), puts the event on a bounded queue WITHOUT blocking and answers 200 at once:
// LiveKit's webhook client has no timeout and one worker per room, so a slow answer would stall every
// later event of that room — they wait up to 30 s in LiveKit's queue, and a dequeued event retries
// for 15 s more, so delivery can already be ~45 s late (SP-21 row 8). A bad signature is 401, which
// LiveKit does not retry; a full queue is 503 with Retry-After: 1, which it honours for about four
// more seconds (SP-21 row 12). One worker hands events to sink in arrival order — per room,
// LiveKit's own order — and drops a retried event it has already dispatched. The handler also
// implements io.Closer: Close stops accepting and waits for the worker. A nil log discards.
func NewWebhookHandler(apiKey, apiSecret string, sink func(ctx context.Context, ev *livekit.WebhookEvent), log *slog.Logger) http.Handler {
	if log == nil {
		log = slog.New(slog.DiscardHandler)
	}
	h := &webhookHandler{
		provider: auth.NewSimpleKeyProvider(apiKey, apiSecret),
		sink:     sink,
		log:      log,
		queue:    make(chan *livekit.WebhookEvent, webhookQueueLen),
		done:     make(chan struct{}),
		stopped:  make(chan struct{}),
	}
	go h.run()
	return h
}

func (h *webhookHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, webhookBodyLimit)
	ev, err := webhook.ReceiveWebhookEvent(r, h.provider)
	if err != nil {
		h.log.WarnContext(r.Context(), "refused a LiveKit webhook", "err", err)
		http.Error(w, "the webhook did not verify", http.StatusUnauthorized)
		return
	}
	select {
	case <-h.done:
		http.Error(w, "shutting down", http.StatusServiceUnavailable)
		return
	default:
	}
	select {
	case h.queue <- ev:
		w.WriteHeader(http.StatusOK)
	default:
		w.Header().Set("Retry-After", "1")
		http.Error(w, "the webhook queue is full", http.StatusServiceUnavailable)
	}
}

func (h *webhookHandler) run() {
	defer close(h.stopped)
	seen := make(map[string]struct{}, webhookSeenIDs)
	order := make([]string, 0, webhookSeenIDs)
	for {
		select {
		case <-h.done:
			return
		case ev := <-h.queue:
			if id := ev.GetId(); id != "" {
				if _, dup := seen[id]; dup {
					continue
				}
				if len(order) == webhookSeenIDs {
					delete(seen, order[0])
					order = order[1:]
				}
				seen[id] = struct{}{}
				order = append(order, id)
			}
			h.dispatch(ev)
		}
	}
}

// dispatch runs the sink on one event; a panic in it is logged and the worker goes on, because a
// worker that died would leave every later webhook unanswered past its queue.
func (h *webhookHandler) dispatch(ev *livekit.WebhookEvent) {
	if h.sink == nil {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), webhookEventTimeout)
	defer cancel()
	defer func() {
		if p := recover(); p != nil {
			h.log.Error("a LiveKit webhook's handler panicked", "event", ev.GetEvent(), "panic", p)
		}
	}()
	h.sink(ctx, ev)
}

// Close stops accepting webhooks and waits for the worker to return.
func (h *webhookHandler) Close() error {
	h.stop.Do(func() { close(h.done) })
	<-h.stopped
	return nil
}
