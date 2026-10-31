//go:build linux

package main

import (
	"testing"
	"time"

	"github.com/jonasthim/dilla/internal/id"
)

// Reproducer (CT 144, 2026-10-31): one member's /play is a chain of sequential interaction
// requests in one interaction group, each sent ~0.5 s after the previous reply. signal1.3's web
// client sends state, search, enqueue, announce(register), resume, announce(card): six. With a
// healthy gateway every request takes the fast path, and every one must be polled within 1 s.
func TestReproSequentialCommandChainIsAnsweredWithinOneSecond(t *testing.T) {
	a, group := id.New(), id.New()
	h := startWait(t, a)
	const step = 50 * time.Millisecond
	var latencies []time.Duration
	for range 6 {
		h.runtime.notifyInteraction(a, group)
		var waited time.Duration
		for h.take(a) == 0 {
			h.step(step)
			waited += step
			if waited > 40*time.Second {
				t.Fatal("never polled")
			}
		}
		latencies = append(latencies, waited)
		h.step(500 * time.Millisecond) // the Bot's work + the reply + the client's next request
	}
	t.Logf("signal-to-poll latency per request: %v", latencies)
	for i, l := range latencies {
		if l > time.Second {
			t.Errorf("request %d waited %v for its fast poll (budget), want <= 1s", i+1, l)
		}
	}
}
