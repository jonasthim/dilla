package gateway

import (
	"slices"
	"sync"
	"time"

	"github.com/jonasthim/dilla/internal/id"
)

// registry is the live connection index. Everything a producer needs — the device's connections,
// a group's member devices, a user's devices — is a map lookup under one mutex held only for the
// lookup: Deliver* copies the target slice and releases the lock before enqueueing, so a slow
// socket can never hold the delivery service's fan-out.
type registry struct {
	mu sync.RWMutex

	byDevice map[id.ID][]*conn
	byUser   map[id.ID][]*conn
	members  map[id.ID][]id.ID          // group -> member devices, written by the DS after a merge
	leaves   map[id.ID]map[id.ID]uint32 // group -> device -> leaf index
	bots     map[id.ID]struct{}
}

func newRegistry() *registry {
	return &registry{
		byDevice: map[id.ID][]*conn{},
		byUser:   map[id.ID][]*conn{},
		members:  map[id.ID][]id.ID{},
		leaves:   map[id.ID]map[id.ID]uint32{},
		bots:     map[id.ID]struct{}{},
	}
}

func (r *registry) add(c *conn) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.byDevice[c.deviceID] = append(r.byDevice[c.deviceID], c)
	r.byUser[c.userID] = append(r.byUser[c.userID], c)
}

// remove reports whether the connection WAS in the index. The answer is what keeps the
// dilla_gateway_connections gauge honest: suspend, CloseDevice and Shutdown all remove, and
// readLoop's deferred suspend runs after CloseDevice has already taken the same connection out,
// so a Dec() that is not conditioned on this would drive the gauge negative.
func (r *registry) remove(c *conn) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	before := len(r.byDevice[c.deviceID])
	r.byDevice[c.deviceID] = removeConn(r.byDevice[c.deviceID], c)
	removed := len(r.byDevice[c.deviceID]) != before
	if len(r.byDevice[c.deviceID]) == 0 {
		delete(r.byDevice, c.deviceID)
	}
	r.byUser[c.userID] = removeConn(r.byUser[c.userID], c)
	if len(r.byUser[c.userID]) == 0 {
		delete(r.byUser, c.userID)
	}
	return removed
}

func removeConn(list []*conn, c *conn) []*conn {
	out := list[:0]
	for _, x := range list {
		if x != c {
			out = append(out, x)
		}
	}
	return out
}

func (r *registry) connsOfDevice(d id.ID) []*conn {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return slices.Clone(r.byDevice[d])
}

func (r *registry) connsOfUser(u id.ID) []*conn {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return slices.Clone(r.byUser[u])
}

func (r *registry) connsOfGroup(g id.ID) []*conn {
	r.mu.RLock()
	defer r.mu.RUnlock()
	var out []*conn
	for _, device := range r.members[g] {
		out = append(out, r.byDevice[device]...)
	}
	return out
}

func (r *registry) all() []*conn {
	r.mu.RLock()
	defer r.mu.RUnlock()
	var out []*conn
	for _, list := range r.byDevice {
		out = append(out, list...)
	}
	return out
}

func (r *registry) setMembers(g id.ID, devices []id.ID) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.members[g] = slices.Clone(devices)
}

func (r *registry) setLeaves(g id.ID, leaves map[id.ID]uint32) {
	r.mu.Lock()
	defer r.mu.Unlock()
	copied := make(map[id.ID]uint32, len(leaves))
	for k, v := range leaves {
		copied[k] = v
	}
	r.leaves[g] = copied
}

func (r *registry) setBots(devices []id.ID) {
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, d := range devices {
		r.bots[d] = struct{}{}
	}
}

// onlineIn is invariant 7's candidate list: bot devices first, then by leaf index. A device with
// several connections appears once, with its earliest ready time.
func (r *registry) onlineIn(g id.ID, now time.Time, idle time.Duration) []OnlineDevice {
	r.mu.RLock()
	defer r.mu.RUnlock()
	seen := map[id.ID]OnlineDevice{}
	for _, device := range r.members[g] {
		for _, c := range r.byDevice[device] {
			if !c.online(now, idle) {
				continue
			}
			_, isBot := r.bots[device]
			candidate := OnlineDevice{
				DeviceID:  device,
				LeafIndex: r.leaves[g][device],
				IsBot:     isBot,
				ReadyAt:   c.readyAt(),
			}
			if prev, ok := seen[device]; !ok || candidate.ReadyAt.Before(prev.ReadyAt) {
				seen[device] = candidate
			}
		}
	}
	out := make([]OnlineDevice, 0, len(seen))
	for _, v := range seen {
		out = append(out, v)
	}
	slices.SortFunc(out, func(a, b OnlineDevice) int {
		switch {
		case a.IsBot != b.IsBot:
			if a.IsBot {
				return -1
			}
			return 1
		case a.LeafIndex != b.LeafIndex:
			if a.LeafIndex < b.LeafIndex {
				return -1
			}
			return 1
		default:
			return 0
		}
	})
	return out
}
