package api

import (
	"sync"
	"time"

	"github.com/jonasthim/dilla/internal/id"
)

// RelayAcks is a RelayRevoker whose cuts reach a relay in another process (server.RelayRevoker,
// R-UP11): Unacked reports a device whose cut that relay has not acknowledged yet.
type RelayAcks interface {
	Unacked(device id.ID) bool
}

// relayPending reports whether dev has a relay cut the relay that would carry its media has not
// applied. Such a device is refused like one whose SFU repair is pending (isPending): 503
// E_UNAVAILABLE at the start, the /rtc gate and the share route, until the relay acknowledges
// the cut — no window in which a cut device gets a fresh credential the relay would still honour
// its old ones beside.
func (h *Calls) relayPending(dev id.ID) bool {
	a, ok := h.relay.(RelayAcks)
	return ok && a.Unacked(dev)
}

// recentMintWindow is how far back GET /media/recent-mints counts (R-UP4): a call token minted
// within it may be on its way to the SFU, which `dillad media --idle` must not restart under it.
const recentMintWindow = 60 * time.Second

// maxMintLog bounds the mint record; past it the oldest go, and the count stays at the bound,
// which reads busy anyway.
const maxMintLog = 4096

// mintLog is when call tokens were minted, oldest first, within recentMintWindow.
type mintLog struct {
	mu    sync.Mutex
	times []time.Time
}

func (l *mintLog) note(now time.Time) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.pruneLocked(now)
	if len(l.times) >= maxMintLog {
		l.times = l.times[1:]
	}
	l.times = append(l.times, now)
}

func (l *mintLog) pruneLocked(now time.Time) {
	i := 0
	for i < len(l.times) && now.Sub(l.times[i]) >= recentMintWindow {
		i++
	}
	l.times = l.times[i:]
}

// RecentMints is the number of call tokens the start route minted within the last 60 s, on the
// instance clock.
func (h *Calls) RecentMints() int {
	h.mints.mu.Lock()
	defer h.mints.mu.Unlock()
	h.mints.pruneLocked(h.clk.Now())
	return len(h.mints.times)
}
