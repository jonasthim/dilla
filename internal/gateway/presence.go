package gateway

import (
	"sync"
	"time"

	"github.com/jonasthim/dilla/internal/clock"
	"github.com/jonasthim/dilla/internal/id"
)

// typingTTL is how long one typing signal lives. Ephemeral state is never persisted and never
// replayed: op 48-50 frames are n = 0 by construction.
const typingTTL = 10 * time.Second

type presence struct {
	mu     sync.Mutex
	clk    clock.Clock
	typing map[[2]id.ID]time.Time
	status map[id.ID]presenceState
}

type presenceState struct {
	status  uint64
	since   time.Time
	message string
}

func newPresence(clk clock.Clock) *presence {
	return &presence{clk: clk, typing: map[[2]id.ID]time.Time{}, status: map[id.ID]presenceState{}}
}

// SetTyping records or clears a typing signal for one device of one user.
func (g *Gateway) SetTyping(userID, deviceID id.ID, typing bool) {
	p := g.presence
	p.mu.Lock()
	key := [2]id.ID{userID, deviceID}
	if typing {
		p.typing[key] = p.clk.Now().Add(typingTTL)
	} else {
		delete(p.typing, key)
	}
	p.mu.Unlock()
}

// IsTyping reports whether a live typing signal exists. An expired entry is dropped on read, so
// the map does not grow with every keystroke of every user.
func (g *Gateway) IsTyping(userID, deviceID id.ID) bool {
	p := g.presence
	p.mu.Lock()
	defer p.mu.Unlock()
	key := [2]id.ID{userID, deviceID}
	expires, ok := p.typing[key]
	if !ok {
		return false
	}
	if !p.clk.Now().Before(expires) {
		delete(p.typing, key)
		return false
	}
	return true
}

// SetPresence records a user's status. Presence is per user, not per device: a user is online
// while any of their devices is.
func (g *Gateway) SetPresence(userID id.ID, status uint64, message string) {
	p := g.presence
	p.mu.Lock()
	p.status[userID] = presenceState{status: status, since: p.clk.Now(), message: message}
	p.mu.Unlock()
}
