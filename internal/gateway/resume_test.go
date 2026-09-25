package gateway

import (
	"context"
	"testing"

	"github.com/jonasthim/dilla/internal/id"
)

// A connection closed with a code protocol/02 marks as NOT resumable must not be parked in the
// resume window. The revocation path is auth.Sessions.OnRevoke -> Deps.CloseGateway ->
// Gateway.CloseDevice, and readLoop's `defer g.suspend(c)` fires right after it: without the gate
// the same connection goes straight back into g.suspended under its unchanged token, and the
// device that was just revoked can reconnect inside ResumeWindow.
func TestARevokedConnectionIsNotLeftResumable(t *testing.T) {
	h := newHarness(t)
	device := id.New()
	c := h.connect(t, device)
	token := c.resumeToken()

	h.revoke(device)
	// readLoop's deferred suspend, which fires as soon as the closed socket fails its next read.
	h.gw.suspend(c)

	if _, ok := h.gw.suspended.Load(string(token)); ok {
		t.Fatal("a connection closed 4004 session_revoked is still resumable")
	}
	if h.gw.Online(device) {
		t.Fatal("a revoked device must not be online")
	}
}

// The other half of the same rule: a connection that was ALREADY in the resume window when the
// revocation arrived is not in the registry CloseDevice walks, so it has to be swept out by hand.
func TestRevokingADeviceDropsAConnectionAlreadyInTheResumeWindow(t *testing.T) {
	h := newHarness(t)
	device := id.New()
	c := h.connect(t, device)
	token := c.resumeToken()
	h.gw.suspend(c)
	if _, ok := h.gw.suspended.Load(string(token)); !ok {
		t.Fatal("a cleanly suspended connection must be resumable straight away")
	}

	h.revoke(device)

	if _, ok := h.gw.suspended.Load(string(token)); ok {
		t.Fatal("revoking a device must drop its suspended connections too")
	}
}

// 4009 session_timeout is the other non-resumable code, and sweepLiveness is the only thing that
// sends it.
func TestAHeartbeatTimeoutLeavesNoResumableSession(t *testing.T) {
	h := newHarness(t)
	c := h.connect(t, id.New())
	token := c.resumeToken()

	h.clk.Advance(h.gw.beat.grace + 1)
	h.gw.sweepLiveness()

	if got := h.waitClose(t, c); got != CloseSessionTimeout {
		t.Fatalf("close code = %d, want 4009", got)
	}
	if _, ok := h.gw.suspended.Load(string(token)); ok {
		t.Fatal("a connection closed 4009 session_timeout is still resumable")
	}
}

// A revoked device presenting its old resume token and no credential is refused on the wire, not
// only in the registry.
func TestARevokedDeviceCannotResumeWithItsOldToken(t *testing.T) {
	h := newHarness(t)
	device := id.New()
	c := h.connect(t, device)
	token := c.resumeToken()
	h.revoke(device)
	h.gw.suspend(c)

	s := newRecordingSink(8, false)
	go h.gw.serve(context.Background(), s, "")
	h.readFrom(t, s) // hello

	p, err := payload("", token, h.generation, uint64(0))
	if err != nil {
		t.Fatalf("payload: %v", err)
	}
	s.feed(mustEncode(t, Frame{Op: OpResume, Payload: p, Replay: true}, 2))

	in := h.readFrom(t, s)
	if in.Op != OpInvalidSession {
		t.Fatalf("op %d, want invalid_session", in.Op)
	}
	if h.gw.Online(device) {
		t.Fatal("a revoked device was put back into the live registry by a resume")
	}
}

// resume's element 0 is a session_token (protocol/02 line 135) and it is checked: possession of a
// resume token alone is not an authentication.
func TestResumeIsRefusedWhenTheSessionTokenNamesAnotherDevice(t *testing.T) {
	h := newHarness(t)
	mine := h.connect(t, id.New())
	theirs := h.connect(t, id.New())
	token := mine.resumeToken()
	h.gw.suspend(mine)

	s := newRecordingSink(8, false)
	go h.gw.serve(context.Background(), s, "")
	h.readFrom(t, s) // hello

	// A valid credential — for the wrong device.
	p, err := payload(h.tokenFor(theirs.deviceID), token, h.generation, uint64(0))
	if err != nil {
		t.Fatalf("payload: %v", err)
	}
	s.feed(mustEncode(t, Frame{Op: OpResume, Payload: p, Replay: true}, 2))

	if in := h.readFrom(t, s); in.Op != OpInvalidSession {
		t.Fatalf("op %d, want invalid_session", in.Op)
	}
	if h.gw.Online(mine.deviceID) {
		t.Fatal("another device's session token resumed this connection")
	}
}

// And a resume carrying no credential at all — neither in the payload nor on the HTTP upgrade —
// is refused rather than accepted on the resume token.
func TestResumeIsRefusedWithoutAnyCredential(t *testing.T) {
	h := newHarness(t)
	c := h.connect(t, id.New())
	token := c.resumeToken()
	h.gw.suspend(c)

	s := newRecordingSink(8, false)
	go h.gw.serve(context.Background(), s, "")
	h.readFrom(t, s) // hello

	p, err := payload("", token, h.generation, uint64(0))
	if err != nil {
		t.Fatalf("payload: %v", err)
	}
	s.feed(mustEncode(t, Frame{Op: OpResume, Payload: p, Replay: true}, 2))

	if in := h.readFrom(t, s); in.Op != OpInvalidSession {
		t.Fatalf("op %d, want invalid_session", in.Op)
	}
	if h.gw.Online(c.deviceID) {
		t.Fatal("a resume with an empty session token was accepted")
	}
}

// Two resumes in a row over two fresh sinks. The server half of the rotation is sound — the
// rotated token is accepted the second time — and this test isolates the remaining gap to the
// WIRE: `resumed` is [replayed_from, replayed_to] and carries no token, so a real client cannot
// learn the rotated value and the test has to read it off the connection. The controller ruling
// this needs is recorded in the task-18 fix report; when it lands, the `c.resumeToken()` read
// below becomes a read of the frame and this test stops being a white-box one.
func TestAResumedConnectionCanResumeAgain(t *testing.T) {
	h := newHarness(t)
	c := h.connect(t, id.New())
	first := c.resumeToken()
	second := h.resumeOnce(t, c, first)
	if string(first) == string(second) {
		t.Fatal("the resume token must rotate on every resumed")
	}
	h.resumeOnce(t, c, second)
}

// resumeOnce suspends the connection, resumes it over a brand-new sink, insists the first frame
// is `resumed`, and answers the rotated token.
func (h *harness) resumeOnce(t *testing.T, c *conn, token []byte) []byte {
	t.Helper()
	h.gw.suspend(c)
	s := newRecordingSink(16, false)
	go h.gw.serve(context.Background(), s, "")
	h.readFrom(t, s) // hello

	p, err := payload(h.tokenFor(c.deviceID), token, h.generation, uint64(0))
	if err != nil {
		t.Fatalf("payload: %v", err)
	}
	s.feed(mustEncode(t, Frame{Op: OpResume, Payload: p, Replay: true}, 2))
	if in := h.readFrom(t, s); in.Op != OpResumed {
		t.Fatalf("op %d, want resumed", in.Op)
	}
	return c.resumeToken()
}
