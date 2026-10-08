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
const typingInterval = 3 * time.Second
const typingChannelCap = 64

type typingState struct {
	user    id.ID
	expires time.Time
	last    time.Time
}

type presence struct {
	mu     sync.Mutex
	clk    clock.Clock
	typing map[[2]id.ID]typingState
	status map[id.ID]presenceState
}

type presenceState struct {
	status  uint64
	since   time.Time
	message string
}

func newPresence(clk clock.Clock) *presence {
	return &presence{clk: clk, typing: map[[2]id.ID]typingState{}, status: map[id.ID]presenceState{}}
}

// SetTyping records or clears one device's signal in one channel.
func (g *Gateway) SetTyping(channelID, userID, deviceID id.ID, typing bool) {
	g.acceptTyping(channelID, userID, deviceID, typing)
}

// acceptTyping admits at most one live signal per device and channel in three seconds.
// Expired entries are removed before the per-device channel cap is checked.
func (g *Gateway) acceptTyping(channelID, userID, deviceID id.ID, typing bool) bool {
	p := g.presence
	p.mu.Lock()
	defer p.mu.Unlock()
	now := p.clk.Now()
	for key, state := range p.typing {
		if !now.Before(state.expires) {
			delete(p.typing, key)
		}
	}
	key := [2]id.ID{channelID, deviceID}
	state, exists := p.typing[key]
	if typing {
		if exists && now.Sub(state.last) < typingInterval {
			return false
		}
		if !exists {
			count := 0
			for k := range p.typing {
				if k[1] == deviceID {
					count++
				}
			}
			if count >= typingChannelCap {
				return false
			}
		}
		p.typing[key] = typingState{user: userID, expires: now.Add(typingTTL), last: now}
		return true
	}
	if !exists || state.user != userID {
		return false
	}
	delete(p.typing, key)
	return true
}

// IsTyping reports whether a live typing signal exists. An expired entry is dropped on read, so
// the map does not grow with every keystroke of every user.
func (g *Gateway) IsTyping(channelID, userID, deviceID id.ID) bool {
	p := g.presence
	p.mu.Lock()
	defer p.mu.Unlock()
	now := p.clk.Now()
	for key, state := range p.typing {
		if !now.Before(state.expires) {
			delete(p.typing, key)
		}
	}
	key := [2]id.ID{channelID, deviceID}
	state, ok := p.typing[key]
	if !ok {
		return false
	}
	return state.user == userID
}

// SetPresence records a user's status. Presence is per user, not per device: a user is online
// while any of their devices is.
func (g *Gateway) SetPresence(userID id.ID, status uint64, message string) {
	p := g.presence
	p.mu.Lock()
	p.status[userID] = presenceState{status: status, since: p.clk.Now(), message: message}
	p.mu.Unlock()
}
