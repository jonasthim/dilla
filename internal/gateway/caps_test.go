package gateway

// caps_test.go: UP6b (protocol/02 § Handshake records). A frame that needs identify's caps bit 0
// (a kind-3 `withdrawn` handshake row) reaches only connections that set it: on the fan-out, in the
// replay ring a resume reads, and in the online list invariant 7 elects from.

import (
	"context"
	"testing"

	"github.com/jonasthim/dilla/internal/auth"
	"github.com/jonasthim/dilla/internal/id"
)

// connectCaps is the harness's connect with identify's caps.
func (h *harness) connectCaps(t *testing.T, device id.ID, caps uint64) *conn {
	t.Helper()
	sink := newRecordingSink(1024, false)
	session := auth.Session{DeviceID: device, UserID: id.New(), Scope: auth.ScopeEnrolled}
	h.mu.Lock()
	h.tokens[h.tokenFor(device)] = session
	h.mu.Unlock()
	wire, e2ee, media := h.gw.advertised()
	c, err := h.gw.registerCaps(context.Background(), session, sink, [3]uint64{wire[0], e2ee[0], media[0]}, caps)
	if err != nil {
		t.Fatalf("register: %v", err)
	}
	h.mu.Lock()
	h.sinks[c] = sink
	h.mu.Unlock()
	return c
}

func TestAFrameNeedingBitZeroSkipsAConnectionWithoutIt(t *testing.T) {
	h := newHarness(t)
	group := id.New()
	withBit, without := id.New(), id.New()
	newer := h.connectCaps(t, withBit, CapWithdrawnRows)
	older := h.connectCaps(t, without, 0)
	h.drainReady(t, newer)
	h.drainReady(t, older)
	h.gw.SetGroupMembers(group, []id.ID{withBit, without})

	kind3, err := HandshakePayload(9, 4, 3, nil, []byte{0x81, 0x41, 0x01})
	if err != nil {
		t.Fatal(err)
	}
	kind0, err := HandshakePayload(10, 4, 0, nil, []byte{0xbe})
	if err != nil {
		t.Fatal(err)
	}
	h.gw.DeliverGroup(group, Frame{Op: OpMLSHandshake, GroupID: &group, Payload: kind3, Replay: true, Caps: CapWithdrawnRows})
	h.gw.DeliverGroup(group, Frame{Op: OpMLSHandshake, GroupID: &group, Payload: kind0, Replay: true})

	// The bit-0 connection gets both; the other gets the kind-0 row alone: it never takes a number
	// for the frame it was not sent.
	for i, want := range []uint64{9, 10} {
		in := h.waitFrame(t, withBit)
		if in.Op != OpMLSHandshake {
			t.Fatalf("frame %d is op %d", i, in.Op)
		}
		if seq, _ := rawUint(in.Payload[0]); seq != want {
			t.Fatalf("the bit-0 connection's frame %d is seq %d, want %d", i, seq, want)
		}
	}
	in := h.waitFrame(t, without)
	if seq, _ := rawUint(in.Payload[0]); in.Op != OpMLSHandshake || seq != 10 {
		t.Fatalf("the connection without bit 0 got op %d seq %d, want the kind-0 row (seq 10) first", in.Op, seq)
	}

	// The replay ring (ready is n = 1): a resume from n = 0 replays exactly what the connection was
	// sent.
	newer.mu.Lock()
	newerTop := newer.n
	newerReplay := newer.ring.since(0)
	newer.mu.Unlock()
	older.mu.Lock()
	olderTop := older.n
	olderReplay := older.ring.since(0)
	older.mu.Unlock()
	if newerTop != 3 || len(newerReplay) != 3 {
		t.Fatalf("the bit-0 connection's ring holds %d frames up to n %d, want ready and both rows", len(newerReplay), newerTop)
	}
	if olderTop != 2 || len(olderReplay) != 2 {
		t.Fatalf("the other connection's ring holds %d frames up to n %d, want ready and the kind-0 row: a kind-3 row would be replayed to it", len(olderReplay), olderTop)
	}
}

// OnlineIn reports a device's caps as the bits every one of its online connections set.
func TestOnlineCapsAreTheBitsEveryConnectionSet(t *testing.T) {
	h := newHarness(t)
	group := id.New()
	both, mixed := id.New(), id.New()
	h.connectCaps(t, both, CapWithdrawnRows)
	h.connectCaps(t, mixed, CapWithdrawnRows)
	h.connectCaps(t, mixed, 0)
	h.gw.SetGroupMembers(group, []id.ID{both, mixed})
	got := map[id.ID]uint64{}
	for _, d := range h.gw.OnlineIn(group) {
		got[d.DeviceID] = d.Caps
	}
	if got[both] != CapWithdrawnRows || got[mixed] != 0 {
		t.Fatalf("online caps %v: want bit 0 for the device whose every connection set it, 0 for the mixed one", got)
	}
}
