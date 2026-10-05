package sfu

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/livekit/protocol/livekit"
	"github.com/livekit/protocol/webhook"
)

// CALLS-5 / SFU-8: one room whose events are slow — or that floods — holds one worker and its own
// queue only. With room A's sink stalled and A's queue full (503 for A), room B's events are still
// accepted (200) and handed to the sink at once, in order.
func TestASlowRoomNeitherShedsNorStallsAnotherRoomsWebhooks(t *testing.T) {
	release := make(chan struct{})
	got := make(chan string, 16)
	h := NewWebhookHandler(hookKey, hookSecret, func(_ context.Context, ev *livekit.WebhookEvent) {
		if ev.GetRoom().GetName() == "room-a" {
			<-release
			return
		}
		got <- ev.GetId()
	}, slog.New(slog.DiscardHandler))
	defer func() {
		close(release)
		_ = h.(io.Closer).Close()
	}()
	post := func(room, evID string) int {
		ev := &livekit.WebhookEvent{Event: webhook.EventTrackPublished, Id: evID, Room: &livekit.Room{Name: room}}
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, signedWebhook(t, "/livekit/webhook", hookKey, hookSecret, ev))
		return rec.Code
	}
	refusedA := false
	for i := range webhookRoomQueueLen + 4 {
		if post("room-a", fmt.Sprintf("EV_a%d", i)) == http.StatusServiceUnavailable {
			refusedA = true
			break
		}
	}
	if !refusedA {
		t.Fatal("a flooding room was never answered 503")
	}
	for i := range 3 {
		if code := post("room-b", fmt.Sprintf("EV_b%d", i)); code != http.StatusOK {
			t.Fatalf("room B's webhook %d = %d while room A is full, want 200", i, code)
		}
	}
	for i := range 3 {
		select {
		case id := <-got:
			if want := fmt.Sprintf("EV_b%d", i); id != want {
				t.Fatalf("room B's event %d = %s, want %s (in order)", i, id, want)
			}
		case <-time.After(2 * time.Second):
			t.Fatalf("room B's event %d never reached the sink while room A's sink was stalled", i)
		}
	}
}

// The handler's total bound still holds across rooms: once webhookQueueLen events wait, every room is
// answered 503.
func TestTheWebhookQueueIsBoundedAcrossRooms(t *testing.T) {
	release := make(chan struct{})
	h := NewWebhookHandler(hookKey, hookSecret, func(context.Context, *livekit.WebhookEvent) { <-release },
		slog.New(slog.DiscardHandler))
	defer func() {
		close(release)
		_ = h.(io.Closer).Close()
	}()
	wh := h.(*webhookHandler)
	accepted := 0
	for i := range webhookQueueLen + webhookWorkers + 64 {
		ev := &livekit.WebhookEvent{Event: webhook.EventTrackPublished, Id: fmt.Sprintf("EV_%d", i),
			Room: &livekit.Room{Name: fmt.Sprintf("room-%d", i/(webhookRoomQueueLen/2))}}
		rec := httptest.NewRecorder()
		wh.ServeHTTP(rec, signedWebhook(t, "/livekit/webhook", hookKey, hookSecret, ev))
		if rec.Code == http.StatusOK {
			accepted++
		}
	}
	if accepted > webhookQueueLen+webhookWorkers {
		t.Fatalf("accepted %d webhooks with every sink stalled, want at most %d", accepted, webhookQueueLen+webhookWorkers)
	}
}
