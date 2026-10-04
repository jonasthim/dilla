package sfu

import (
	"context"
	"fmt"
	"log/slog"
	"net/http"
	"sync"
	"time"

	"github.com/livekit/protocol/auth"
	"github.com/livekit/protocol/livekit"
	"github.com/livekit/protocol/webhook"
)

// webhookQueueLen bounds the events waiting across every room. LiveKit itself queues at most 200 per
// room (resource_url_notifier max_depth).
const webhookQueueLen = 1024

// webhookRoomQueueLen bounds the events waiting for one room: a room that fills it is answered 503
// alone, so one member flooding its own room's events never sheds another room's (CALLS-5, SFU-8).
const webhookRoomQueueLen = 64

// webhookWorkers is how many rooms' events are handed to the sink at once. Each room's events go to
// one worker at a time, in arrival order — LiveKit's own order per room — so a slow room holds one
// worker, never the others.
const webhookWorkers = 8

// webhookBodyLimit bounds one webhook body; a protojson event is a few KiB.
const webhookBodyLimit = 1 << 20

// webhookEventTimeout bounds the sink's work on one event.
const webhookEventTimeout = 30 * time.Second

// webhookSeenIDs is how many recent event ids the handler remembers, to drop LiveKit's retries of an
// event it already accepted (a retry resends the same body, so the same id: SP-21 row 4).
const webhookSeenIDs = 1024

type webhookHandler struct {
	provider auth.KeyProvider
	sink     func(context.Context, *livekit.WebhookEvent)
	log      *slog.Logger

	// mu guards the per-room queues: rooms holds each room's waiting events and whether a worker is
	// on it; ready is the rooms with events and no worker, in the order they became ready; total
	// counts every waiting event; seen and order are the recent event ids. cond wakes the workers.
	mu      sync.Mutex
	cond    *sync.Cond
	rooms   map[string]*roomQueue
	ready   []string
	total   int
	seen    map[string]struct{}
	order   []string
	closed  bool
	workers sync.WaitGroup
	stop    sync.Once
}

// roomQueue is one room's waiting events; busy while a worker hands one of them to the sink.
type roomQueue struct {
	events []*livekit.WebhookEvent
	busy   bool
}

// NewWebhookHandler is the receiver SP-21 decided on (task 11). It verifies each POST under the
// SFU's own key (webhook.ReceiveWebhookEvent: the JWT in the Authorization header and its sha256
// claim over the body), puts the event on a bounded queue WITHOUT blocking and answers 200 at once:
// LiveKit's webhook client has no timeout and one worker per room, so a slow answer would stall every
// later event of that room — they wait up to 30 s in LiveKit's queue, and a dequeued event retries
// for 15 s more, so delivery can already be ~45 s late (SP-21 row 8). A bad signature is 401, which
// LiveKit does not retry; a full queue is 503 with Retry-After: 1, which it honours for about four
// more seconds (SP-21 row 12). The queue is kept per room (CALLS-5, SFU-8): a room holds at most
// webhookRoomQueueLen waiting events and every room together webhookQueueLen, and webhookWorkers
// workers each take one room at a time, handing its events to sink in arrival order — per room,
// LiveKit's own order — so a room whose events are slow, or that floods, is answered 503 and delays
// itself only, while the other rooms' events keep flowing. A retried event the handler already
// accepted is dropped. The handler also implements io.Closer: Close stops accepting and waits for
// the workers. A nil log discards.
func NewWebhookHandler(apiKey, apiSecret string, sink func(ctx context.Context, ev *livekit.WebhookEvent), log *slog.Logger) http.Handler {
	if log == nil {
		log = slog.New(slog.DiscardHandler)
	}
	h := &webhookHandler{
		provider: auth.NewSimpleKeyProvider(apiKey, apiSecret),
		sink:     sink,
		log:      log,
		rooms:    map[string]*roomQueue{},
		seen:     make(map[string]struct{}, webhookSeenIDs),
		order:    make([]string, 0, webhookSeenIDs),
	}
	h.cond = sync.NewCond(&h.mu)
	h.workers.Add(webhookWorkers)
	for range webhookWorkers {
		go h.run()
	}
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
	switch h.enqueue(ev) {
	case enqueueClosed:
		http.Error(w, "shutting down", http.StatusServiceUnavailable)
	case enqueueFull:
		w.Header().Set("Retry-After", "1")
		http.Error(w, "the webhook queue is full", http.StatusServiceUnavailable)
	default:
		w.WriteHeader(http.StatusOK)
	}
}

type enqueueResult int

const (
	enqueued enqueueResult = iota
	enqueueClosed
	enqueueFull
)

// enqueue puts ev on its room's queue without blocking: a duplicate of an accepted event is accepted
// and dropped, a full room (or a full handler) refuses it.
func (h *webhookHandler) enqueue(ev *livekit.WebhookEvent) enqueueResult {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.closed {
		return enqueueClosed
	}
	evID := ev.GetId()
	if evID != "" {
		if _, dup := h.seen[evID]; dup {
			return enqueued
		}
	}
	room := ev.GetRoom().GetName()
	q := h.rooms[room]
	if h.total >= webhookQueueLen || (q != nil && len(q.events) >= webhookRoomQueueLen) {
		return enqueueFull
	}
	if evID != "" {
		if len(h.order) == webhookSeenIDs {
			delete(h.seen, h.order[0])
			h.order = h.order[1:]
		}
		h.seen[evID] = struct{}{}
		h.order = append(h.order, evID)
	}
	if q == nil {
		q = &roomQueue{}
		h.rooms[room] = q
	}
	q.events = append(q.events, ev)
	h.total++
	if !q.busy && len(q.events) == 1 {
		h.ready = append(h.ready, room)
		h.cond.Signal()
	}
	return enqueued
}

// run is one worker: it takes a ready room, hands its oldest event to the sink, and puts the room
// back at the end of the ready list while it has more.
func (h *webhookHandler) run() {
	defer h.workers.Done()
	for {
		h.mu.Lock()
		for len(h.ready) == 0 && !h.closed {
			h.cond.Wait()
		}
		if h.closed {
			h.mu.Unlock()
			return
		}
		room := h.ready[0]
		h.ready = h.ready[1:]
		q := h.rooms[room]
		ev := q.events[0]
		q.events = q.events[1:]
		q.busy = true
		h.total--
		h.mu.Unlock()

		h.dispatch(ev)

		h.mu.Lock()
		q.busy = false
		if len(q.events) > 0 {
			h.ready = append(h.ready, room)
			h.cond.Signal()
		} else {
			delete(h.rooms, room)
		}
		h.mu.Unlock()
	}
}

// dispatch runs the sink on one event; a panic in it is logged and the worker goes on, because a
// worker that died would leave its rooms' webhooks unanswered past their queues.
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

// Close stops accepting webhooks and waits for the workers to return; events still queued are
// dropped.
func (h *webhookHandler) Close() error {
	h.stop.Do(func() {
		h.mu.Lock()
		h.closed = true
		h.cond.Broadcast()
		h.mu.Unlock()
	})
	h.workers.Wait()
	return nil
}

// RoomSID names the incarnation of room the SFU holds now — its LiveKit room sid — and whether it
// holds one at all (CALLS-3): a room_finished for a reaped room whose name a start has re-created
// since carries the earlier sid.
func (s *Server) RoomSID(ctx context.Context, room string) (sid string, held bool, err error) {
	rs, ctx, err := s.roomServiceFor(ctx, &auth.VideoGrant{RoomList: true})
	if err != nil {
		return "", false, err
	}
	res, err := rs.ListRooms(ctx, &livekit.ListRoomsRequest{Names: []string{room}})
	if err != nil {
		return "", false, fmt.Errorf("sfu: list room %s: %w", room, err)
	}
	for _, r := range res.GetRooms() {
		if r.GetName() == room {
			return r.GetSid(), true, nil
		}
	}
	return "", false, nil
}
