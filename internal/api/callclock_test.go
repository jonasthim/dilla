package api_test

// The instance clock and the SFU's clock are two clocks. LiveKit stamps a participant's join with
// its own (the in-process SFU reads the process's wall clock); the instance stamps an admission
// with Options.Clock. The test host freezes that one and moves it forward (advance_clock, a TOTP
// pick that waits for the next period), so it can run ahead of LiveKit's: a session's join then
// reads as earlier than its admission, its leave is bound to no membership, and its leaf stays in
// the call group (the remote tile that never went in leave-reload after blocked.spec).

import (
	"testing"
	"time"

	"github.com/livekit/protocol/livekit"
	"github.com/livekit/protocol/webhook"

	"github.com/jonasthim/dilla/internal/api"
	"github.com/jonasthim/dilla/internal/clock"
)

// A leave is bound to its session's admission by the SFU's clock, not the instance's: with the
// instance clock 75 s ahead of the SFU's, the session LiveKit reports joined a second after its
// admission still leaves at that membership, so its Remove is proposed at once.
func TestALeaveIsBoundToItsAdmissionWhenTheInstanceClockRunsAheadOfTheSFUs(t *testing.T) {
	f := newEventsFixture(t, api.CallsConfig{})
	// The start the fixture made admitted the device already: the SFU's clock is 75 s behind both
	// that admission and this one.
	sfuClk := clock.NewFake(f.e.Clk.Now().Add(-75 * time.Second))
	f.calls.WithSFUClock(sfuClk)
	admitThroughProxy(t, f.calls, f.room, f.dev)
	sfuClk.Advance(time.Second)
	joined := sfuClk.Now()
	f.events.Handle(t.Context(), &livekit.WebhookEvent{Event: webhook.EventParticipantJoined, Id: "EV_join",
		Room:        &livekit.Room{Name: f.room},
		Participant: &livekit.ParticipantInfo{Identity: f.dev.String(), Sid: "PA_1", JoinedAtMs: joined.UnixMilli()}})
	f.events.FlushAnnouncements()
	f.sendLeft(t, f.dev, "PA_1", joined)
	got := f.ds.memberRemovals()
	if len(got) != 1 || got[0].Device != f.dev || got[0].Added != 3 {
		t.Fatalf("membership-bound Removes = %+v, want the device's admitted epoch-3 membership", got)
	}
}

// Without an SFU clock of its own (a Calls built for a test, or an instance whose clock is the SFU's)
// the admission is stamped by the instance clock, as before.
func TestWithoutAnSFUClockTheInstanceClockBindsTheLeave(t *testing.T) {
	f := newEventsFixture(t, api.CallsConfig{})
	admitThroughProxy(t, f.calls, f.room, f.dev)
	f.e.Clk.Advance(time.Second)
	f.sendLeft(t, f.dev, "PA_1", f.e.Clk.Now())
	if got := f.ds.memberRemovals(); len(got) != 1 || got[0].Device != f.dev {
		t.Fatalf("membership-bound Removes = %+v, want the device's admitted membership", got)
	}
}
