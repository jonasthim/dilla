package sfu

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/livekit/protocol/auth"
	"github.com/livekit/protocol/livekit"
	"github.com/livekit/protocol/webhook"
	lksdk "github.com/livekit/server-sdk-go/v2"
	"google.golang.org/protobuf/encoding/protojson"
)

// signedWebhook is a POST signed the way LiveKit signs one (resource_url_notifier.go:358-391): an
// Authorization header carrying a JWT, without "Bearer", whose sha256 claim covers the body.
func signedWebhook(t *testing.T, target, key, secret string, ev *livekit.WebhookEvent) *http.Request {
	t.Helper()
	body, err := protojson.Marshal(ev)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	sum := sha256.Sum256(body)
	tok, err := auth.NewAccessToken(key, secret).SetValidFor(5 * time.Minute).
		SetSha256(base64.StdEncoding.EncodeToString(sum[:])).ToJWT()
	if err != nil {
		t.Fatalf("sign: %v", err)
	}
	req := httptest.NewRequestWithContext(t.Context(), http.MethodPost, target, bytes.NewReader(body))
	req.Header.Set("Authorization", tok)
	req.Header.Set("Content-Type", webhook.ContentType)
	return req
}

const hookKey, hookSecret = "dilla", "dilla-webhook-secret-0123456789abcd"

// SP-21's decision: verify, enqueue without blocking, answer 200; 401 on a bad or missing signature;
// the worker hands each event to the sink once, however often LiveKit retries it.
func TestTheWebhookHandlerVerifiesEnqueuesAndDedupes(t *testing.T) {
	got := make(chan *livekit.WebhookEvent, 4)
	h := NewWebhookHandler(hookKey, hookSecret, func(_ context.Context, ev *livekit.WebhookEvent) { got <- ev },
		slog.New(slog.DiscardHandler))
	defer h.(io.Closer).Close()

	ev := &livekit.WebhookEvent{Event: webhook.EventParticipantJoined, Id: "EV_one",
		Room: &livekit.Room{Name: "room-1"}, Participant: &livekit.ParticipantInfo{Identity: "dev"}}
	for range 2 {
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, signedWebhook(t, "/livekit/webhook", hookKey, hookSecret, ev))
		if rec.Code != http.StatusOK {
			t.Fatalf("a signed webhook = %d, want 200", rec.Code)
		}
	}
	select {
	case e := <-got:
		if e.GetEvent() != webhook.EventParticipantJoined || e.GetParticipant().GetIdentity() != "dev" {
			t.Fatalf("the sink got %+v", e)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("the sink never got the event")
	}
	select {
	case e := <-got:
		t.Fatalf("a retried event (same id) reached the sink twice: %+v", e)
	case <-time.After(300 * time.Millisecond):
	}

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, signedWebhook(t, "/livekit/webhook", hookKey, "another-secret-0123456789abcdefghij", ev))
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("a webhook signed with another secret = %d, want 401", rec.Code)
	}
	unsigned := signedWebhook(t, "/livekit/webhook", hookKey, hookSecret, ev)
	unsigned.Header.Del("Authorization")
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, unsigned)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("an unsigned webhook = %d, want 401", rec.Code)
	}
	select {
	case e := <-got:
		t.Fatalf("a refused webhook reached the sink: %+v", e)
	case <-time.After(300 * time.Millisecond):
	}
}

// A sink that stalls fills the bounded queue; the next webhook is 503 with Retry-After: 1, which
// LiveKit's client honours, instead of a request that blocks every later event of its room.
func TestAFullWebhookQueueAnswers503(t *testing.T) {
	release := make(chan struct{})
	h := NewWebhookHandler(hookKey, hookSecret, func(context.Context, *livekit.WebhookEvent) { <-release },
		slog.New(slog.DiscardHandler))
	refusedAt := -1
	var retryAfter string
	for i := range webhookQueueLen + 8 {
		ev := &livekit.WebhookEvent{Event: webhook.EventTrackPublished, Id: "EV_" + strings.Repeat("x", i+1),
			Room: &livekit.Room{Name: "room-1"}}
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, signedWebhook(t, "/livekit/webhook", hookKey, hookSecret, ev))
		if rec.Code == http.StatusServiceUnavailable {
			refusedAt, retryAfter = i, rec.Header().Get("Retry-After")
			break
		}
		if rec.Code != http.StatusOK {
			t.Fatalf("webhook %d = %d", i, rec.Code)
		}
	}
	close(release)
	_ = h.(io.Closer).Close()
	if refusedAt < webhookQueueLen || refusedAt > webhookQueueLen+1 || retryAfter != "1" {
		t.Fatalf("the first 503 came at webhook %d with Retry-After %q; want at %d or %d with \"1\"",
			refusedAt, retryAfter, webhookQueueLen, webhookQueueLen+1)
	}
}

// The contract with the real LiveKit v1.13.7: data-only participants produce participant_joined;
// DeleteRoom produces one participant_left per participant and room_finished (G30's order is
// recorded); afterwards the old token is refused 404, because room.auto_create is false (SP-23).
func TestLiveKitDeliversTheCallLifecycleToTheReceiver(t *testing.T) {
	var mu sync.Mutex
	var seen []string
	c := testConfig()
	c.Port, c.UDPPort = 7958, 7960
	h := NewWebhookHandler(c.APIKey, c.APISecret, func(_ context.Context, ev *livekit.WebhookEvent) {
		mu.Lock()
		defer mu.Unlock()
		seen = append(seen, ev.GetEvent()+":"+ev.GetParticipant().GetIdentity())
	}, slog.New(slog.DiscardHandler))
	defer h.(io.Closer).Close()
	mux := http.NewServeMux()
	mux.Handle("POST "+WebhookPath, h)
	ts := httptest.NewServer(mux)
	defer ts.Close()
	c.WebhookURL = ts.URL + WebhookPath
	srv, err := Start(t.Context(), c)
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	defer func() { _ = srv.Stop(context.WithoutCancel(t.Context())) }()

	const room = "lifecycle-room"
	if err := srv.CreateRoom(t.Context(), room); err != nil {
		t.Fatalf("CreateRoom: %v", err)
	}
	aliceTok, _ := srv.Token(room, "alice", PublishGrant(true, false, false), nil)
	bobTok, _ := srv.Token(room, "bob", PublishGrant(true, false, false), nil)
	for _, tok := range []string{aliceTok, bobTok} {
		r, err := lksdk.ConnectToRoomWithToken(srv.URL(), tok, &lksdk.RoomCallback{})
		if err != nil {
			t.Fatalf("join: %v", err)
		}
		t.Cleanup(r.Disconnect)
	}
	has := func(want ...string) bool {
		mu.Lock()
		defer mu.Unlock()
		for _, w := range want {
			found := false
			for _, s := range seen {
				found = found || s == w
			}
			if !found {
				return false
			}
		}
		return true
	}
	sfuEventually(t, "participant_joined for alice and bob", 15*time.Second, func() bool {
		return has("participant_joined:alice", "participant_joined:bob")
	})
	if err := srv.DeleteRoom(t.Context(), room); err != nil {
		t.Fatalf("DeleteRoom: %v", err)
	}
	sfuEventually(t, "participant_left × 2 and room_finished", 15*time.Second, func() bool {
		return has("participant_left:alice", "participant_left:bob", "room_finished:")
	})
	mu.Lock()
	t.Logf("SP-23 event order after DeleteRoom: %v", seen)
	mu.Unlock()
	status, body := rtcUpgradeStatus(t, srv, aliceTok)
	t.Logf("SP-23 rejoin of a deleted room: status=%d body=%q", status, body)
	if status != http.StatusNotFound || !strings.Contains(body, "requested room does not exist") {
		t.Fatalf("a rejoin of a deleted room = %d %q, want 404 \"requested room does not exist\"", status, body)
	}
}
