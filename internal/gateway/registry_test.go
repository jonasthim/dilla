package gateway

import (
	"bytes"
	"sync/atomic"
	"testing"
	"time"

	"github.com/fxamacker/cbor/v2"

	"github.com/jonasthim/dilla/internal/cborx"
	"github.com/jonasthim/dilla/internal/id"
)

// countingPayload proves the hot-path rule of facts-gateway-design §3.3: a group frame's payload
// is encoded ONCE and the same bytes reach every connection; only n differs.
type countingPayload struct{ calls atomic.Int64 }

func (c *countingPayload) build(t *testing.T) cbor.RawMessage {
	t.Helper()
	c.calls.Add(1)
	p, err := EpochChangedPayload(42, 4129)
	if err != nil {
		t.Fatalf("payload: %v", err)
	}
	return p
}

// The naive form of this test — build the payload once, then assert the builder ran once — is
// true for every implementation, including one that re-encodes per connection: the test itself is
// the only caller of build. What is actually under test is that the SAME payload bytes reach every
// connection and that only element 1 (n) differs, so the assertion is on the frames the sinks
// received, not on a counter.
func TestAGroupPayloadIsEncodedOnceForEveryConnection(t *testing.T) {
	h := newHarness(t)
	group := id.New()
	devices := make([]id.ID, 0, 5)
	for range 5 {
		d := id.New()
		devices = append(devices, d)
		h.connect(t, d)
		// `ready` is replayable (deviation B8) and is therefore already on the sink. The frame
		// this test is about is the one after it.
		h.waitRawFrame(t, d)
	}
	h.gw.SetGroupMembers(group, devices)

	var counter countingPayload
	payload := counter.build(t)
	h.gw.DeliverGroup(group, Frame{
		Op:      OpMLSEpochChanged,
		GroupID: &group,
		Payload: payload,
		Replay:  true,
	})

	if got := counter.calls.Load(); got != 1 {
		t.Fatalf("payload encoded %d times, want 1", got)
	}
	// Element 3 of every delivered frame must be byte-identical to the payload the producer built,
	// and every frame must differ from every other only in element 1.
	var first []byte
	for _, d := range devices {
		raw := h.waitRawFrame(t, d)
		var elems []cbor.RawMessage
		if err := cborx.Unmarshal(raw, &elems); err != nil {
			t.Fatalf("device %s: %v", d, err)
		}
		if len(elems) != 4 {
			t.Fatalf("device %s: frame has %d elements", d, len(elems))
		}
		if !bytes.Equal(elems[3], payload) {
			t.Fatalf("device %s received a re-encoded payload:\n got %x\nwant %x", d, elems[3], payload)
		}
		if first == nil {
			first = raw
			continue
		}
		if len(first) != len(raw) {
			t.Fatalf("device %s: frames differ in length, so more than n differs", d)
		}
		// The two frames may differ only inside element 1's encoding.
		var a, b []cbor.RawMessage
		_ = cborx.Unmarshal(first, &a)
		_ = cborx.Unmarshal(raw, &b)
		for i := range a {
			if i == 1 {
				continue
			}
			if !bytes.Equal(a[i], b[i]) {
				t.Fatalf("device %s: element %d differs between connections; only n may", d, i)
			}
		}
	}
}

// The ring is at least as large as the writer queue on both axes, or a slow-consumer disconnect
// becomes data loss: the connection is closed 4008 (resumable) and the client resumes from a ring
// that no longer holds what the queue dropped.
func TestTheRingIsNeverSmallerThanTheWriterQueue(t *testing.T) {
	o := defaultOptions()
	if o.RingFrames < o.QueueFrames {
		t.Errorf("RingFrames %d < QueueFrames %d", o.RingFrames, o.QueueFrames)
	}
	if o.RingBytes < o.QueueBytes {
		t.Errorf("RingBytes %d < QueueBytes %d", o.RingBytes, o.QueueBytes)
	}
	for _, c := range []struct {
		name string
		o    Options
	}{
		{"zero values are filled in", Options{}},
		{"a smaller ring is raised to the queue", Options{QueueFrames: 512, RingFrames: 8, QueueBytes: 1 << 20, RingBytes: 1 << 10}},
	} {
		t.Run(c.name, func(t *testing.T) {
			got := c.o.withDefaults()
			if got.RingFrames < got.QueueFrames || got.RingBytes < got.QueueBytes {
				t.Fatalf("withDefaults left ring %d/%d below queue %d/%d",
					got.RingFrames, got.RingBytes, got.QueueFrames, got.QueueBytes)
			}
		})
	}
}

// ready's per-group digest is what a client with a refused resume heals from, so
// proposals_outstanding must be real: a group under an instance freeze reports 1, not 0.
func TestReadyReportsProposalsOutstandingPerGroup(t *testing.T) {
	h := newHarness(t)
	group := id.New()
	device := id.New()
	h.setGroupsForDevice(device, group)
	h.setOutstanding(group, 1)

	c := h.connect(t, device)
	in := h.waitFrame(t, c.deviceID)
	if in.Op != OpReady {
		t.Fatalf("first frame after identify is op %d, want ready", in.Op)
	}
	var rows [][]cbor.RawMessage
	if err := cborx.Unmarshal(in.Payload[8], &rows); err != nil {
		t.Fatalf("ready groups: %v", err)
	}
	if len(rows) != 1 {
		t.Fatalf("ready carries %d group rows, want 1", len(rows))
	}
	outstanding, err := rawUint(rows[0][3])
	if err != nil {
		t.Fatalf("proposals_outstanding: %v", err)
	}
	if outstanding != 1 {
		t.Fatalf("proposals_outstanding = %d, want 1", outstanding)
	}
}

// Fan-out is per connection: three tabs of one device each get their own n.
func TestThreeConnectionsOfOneDeviceEachGetTheirOwnN(t *testing.T) {
	h := newHarness(t)
	device := id.New()
	group := id.New()
	tabs := []*conn{h.connect(t, device), h.connect(t, device), h.connect(t, device)}
	h.gw.SetGroupMembers(group, []id.ID{device})

	p, err := EpochChangedPayload(42, 4129)
	if err != nil {
		t.Fatalf("payload: %v", err)
	}
	h.gw.DeliverGroup(group, Frame{Op: OpMLSEpochChanged, GroupID: &group, Payload: p, Replay: true})

	for i, c := range tabs {
		// n = 1 is this connection's own `ready`; n = 2 is the group frame. A shared counter
		// would leave the second and third tabs at 3 and 4.
		if c.n != 2 {
			t.Errorf("tab %d: n = %d, want 2 — every connection counts for itself", i, c.n)
		}
	}
}

// R10: online is true immediately at ready — the jitter trap is that a first heartbeat is up to
// heartbeat_ms away, so a device that has just become ready must not look offline.
func TestOnlineIsTrueAtReadyAndFalseAfterTheIdleWindow(t *testing.T) {
	h := newHarness(t)
	device := id.New()
	h.connect(t, device)

	if !h.gw.Online(device) {
		t.Fatal("a device is online the moment it is ready")
	}
	h.clk.Advance(89 * time.Second)
	if !h.gw.Online(device) {
		t.Fatal("still inside session_idle_close")
	}
	h.clk.Advance(2 * time.Second)
	if h.gw.Online(device) {
		t.Fatal("past session_idle_close the device is not online")
	}
}

// A session inside the resume grace window holds no connection and is therefore not online
// (protocol/02 invariant 6, as amended).
func TestASuspendedSessionInTheResumeWindowIsNotOnline(t *testing.T) {
	h := newHarness(t)
	device := id.New()
	c := h.connect(t, device)
	h.suspend(c)
	if h.gw.Online(device) {
		t.Fatal("a suspended connection must not count as online")
	}
}

func TestOnlineInOrdersBotDevicesFirstThenByLeafIndex(t *testing.T) {
	h := newHarness(t)
	group := id.New()
	human1, human2, bot := id.New(), id.New(), id.New()
	h.connect(t, human1)
	h.connect(t, human2)
	h.connect(t, bot)
	h.gw.SetGroupMembers(group, []id.ID{human1, human2, bot})
	h.setLeaves(group, map[id.ID]uint32{human1: 2, human2: 1, bot: 9})
	h.setBots(bot)

	got := h.gw.OnlineIn(group)
	if len(got) != 3 {
		t.Fatalf("OnlineIn returned %d devices, want 3", len(got))
	}
	if got[0].DeviceID != bot {
		t.Errorf("first candidate is %s, want the bot %s", got[0].DeviceID, bot)
	}
	if got[1].LeafIndex != 1 || got[2].LeafIndex != 2 {
		t.Errorf("humans are not ordered by leaf index: %v", got)
	}
}
