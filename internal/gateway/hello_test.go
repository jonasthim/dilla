package gateway

import (
	"net/http"
	"testing"
	"time"

	"github.com/coder/websocket"
)

// Deviation B23 (ruling 44), closed by task 27a: `hello` grows from seven elements to nine, the
// last two being invariant 7's back-off window — backoff_ms and backoff_jitter_ms. The instance
// only ever addresses the elected committer, so the other devices learn how long to wait from
// hello, once per connection, and the window is whatever Options carries: the composition root
// fills it from ds.Policy.
func TestHelloAdvertisesTheBackoffWindow(t *testing.T) {
	g := New(Options{Backoff: 450 * time.Millisecond, BackoffJitter: 150 * time.Millisecond})
	c, ctx := dialGateway(t, g, &websocket.DialOptions{
		HTTPHeader:   http.Header{"Authorization": []string{"Bearer nobody"}},
		Subprotocols: []string{"dilla.v1"},
	})
	in := readWS(t, ctx, c)
	if in.Op != OpHello {
		t.Fatalf("first frame op %d, want hello", in.Op)
	}
	if len(in.Payload) != 9 {
		t.Fatalf("hello has %d elements, want 9", len(in.Payload))
	}
	for i, want := range map[int]uint64{7: 450, 8: 150} {
		got, err := rawUint(in.Payload[i])
		if err != nil {
			t.Fatalf("hello[%d]: %v", i, err)
		}
		if got != want {
			t.Errorf("hello[%d] = %d, want %d", i, got, want)
		}
	}
}

// Unset, the window is protocol/02's own: 300 ms + random(0..300 ms).
func TestTheBackoffWindowDefaultsToInvariant7s(t *testing.T) {
	o := Options{}.withDefaults()
	if o.Backoff != 300*time.Millisecond || o.BackoffJitter != 300*time.Millisecond {
		t.Fatalf("Backoff/BackoffJitter default to %v/%v, want 300ms/300ms", o.Backoff, o.BackoffJitter)
	}
}
