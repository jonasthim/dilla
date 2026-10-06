package gateway

// pending_test.go pins the security review's F4: identify refuses a pending session (protocol/02
// § Device sessions item 4, L-HTTP-57: a pending session reaches its own two backup reads, its
// own device-list GET and PUT and the session routes needing no session, and nothing else). A
// holder of the password alone mints pending sessions; without this it opened gateway
// connections, received `ready` and held connection slots. It answers like a token that does not
// resolve: an E_UNAUTHENTICATED error frame and close 4003.

import (
	"context"
	"testing"

	"github.com/coder/websocket"

	"github.com/jonasthim/dilla/internal/auth"
	"github.com/jonasthim/dilla/internal/id"
)

func pendingSession(h *harness, device id.ID) string {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.tokens[h.tokenFor(device)] = auth.Session{DeviceID: device, UserID: id.New(), Scope: auth.ScopePending}
	return h.tokenFor(device)
}

// The pending token in the identify frame.
func TestIdentifyRefusesAPendingSession(t *testing.T) {
	h := newHarness(t)
	device := id.New()
	token := pendingSession(h, device)
	s := newRecordingSink(8, false)
	go h.gw.serve(context.Background(), s, "")
	h.readFrom(t, s) // hello

	p, err := payload(token, uint64(1), uint64(1), uint64(1), uint64(0))
	if err != nil {
		t.Fatalf("payload: %v", err)
	}
	s.feed(mustEncode(t, Frame{Op: OpIdentify, Payload: p, Replay: true}, 1))

	in := h.readFrom(t, s)
	if in.Op != OpError {
		t.Fatalf("a pending session's identify: op %d, want an error frame", in.Op)
	}
	if code, err := rawText(in.Payload[1]); err != nil || code != "E_UNAUTHENTICATED" {
		t.Fatalf("error code = %q (err %v), want E_UNAUTHENTICATED", code, err)
	}
	if got := h.waitCloseOn(t, s); got != CloseUnauthenticated {
		t.Fatalf("close code = %d, want 4003", got)
	}
	if h.gw.Online(device) {
		t.Fatal("a pending device is online")
	}
}

// The browser path: a ticket that redeems to a pending session's token, over a real socket.
func TestATicketForAPendingSessionIsRefused(t *testing.T) {
	h := newHarness(t)
	device := id.New()
	token := pendingSession(h, device)
	ticket, _, err := h.gw.Tickets().Mint(device, token)
	if err != nil {
		t.Fatalf("mint: %v", err)
	}
	c, ctx := dialGateway(t, h.gw, &websocket.DialOptions{
		Subprotocols: []string{"dilla.v1", "dilla.ticket." + ticket},
	})
	if in := readWS(t, ctx, c); in.Op != OpHello {
		t.Fatalf("first frame op %d, want hello", in.Op)
	}
	p, err := payload("", uint64(1), uint64(1), uint64(1), uint64(0))
	if err != nil {
		t.Fatalf("payload: %v", err)
	}
	if err := c.Write(ctx, websocket.MessageBinary,
		mustEncode(t, Frame{Op: OpIdentify, Payload: p, Replay: true}, 1)); err != nil {
		t.Fatalf("write: %v", err)
	}
	if in := readWS(t, ctx, c); in.Op != OpError {
		t.Fatalf("a pending ticket's identify: op %d, want an error frame", in.Op)
	}
	if _, _, err := c.Read(ctx); websocket.CloseStatus(err) != websocket.StatusCode(CloseUnauthenticated) {
		t.Fatalf("close status = %v, want 4003", websocket.CloseStatus(err))
	}
	if h.gw.Online(device) {
		t.Fatal("a pending device is online")
	}
}
