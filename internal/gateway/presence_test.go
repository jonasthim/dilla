package gateway

import (
	"testing"
	"time"

	"github.com/jonasthim/dilla/internal/id"
)

func TestTypingExpiresAfterTenSeconds(t *testing.T) {
	h := newHarness(t)
	user, device := id.New(), id.New()
	channel := id.New()
	h.gw.SetTyping(channel, user, device, true)
	if !h.gw.IsTyping(channel, user, device) {
		t.Fatal("typing must be live immediately")
	}
	h.clk.Advance(9 * time.Second)
	if !h.gw.IsTyping(channel, user, device) {
		t.Fatal("typing must still be live at 9 s")
	}
	h.clk.Advance(2 * time.Second)
	if h.gw.IsTyping(channel, user, device) {
		t.Fatal("typing must expire after 10 s")
	}
}

func TestEphemeralFramesAreNeverReplayed(t *testing.T) {
	h := newHarness(t)
	device := id.New()
	c := h.connect(t, device)
	// `ready` is itself replayable (deviation B8), so it has already taken n = 1 and sits in the
	// ring. What this test is about is that an ephemeral frame takes NEITHER.
	nBefore, ringBefore := c.n, len(c.ring.since(0))
	p, err := PresencePayload(id.New(), 1, 1758659000, "")
	if err != nil {
		t.Fatalf("payload: %v", err)
	}
	h.gw.DeliverDevice(device, Frame{Op: OpPresence, Payload: p}) // Replay false
	if c.n != nBefore {
		t.Fatalf("n = %d after an ephemeral frame, want %d", c.n, nBefore)
	}
	if got := len(c.ring.since(0)); got != ringBefore {
		t.Fatalf("the ring holds %d frames after an ephemeral one, want %d", got, ringBefore)
	}
}
