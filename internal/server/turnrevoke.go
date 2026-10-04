package server

import (
	"container/list"
	"context"
	"log/slog"
	"sync"
	"time"

	"github.com/jonasthim/dilla/internal/clock"
	"github.com/jonasthim/dilla/internal/id"
)

// BarredLookup answers whether a device may no longer take part in calls — revoked, quarantined, or
// of a disabled or deleted user — as the database says, which another process (`dillad admin`) may
// have written. A device the database does not know is barred. api.BarredDevices is one.
type BarredLookup interface {
	DeviceBarred(ctx context.Context, device id.ID) (bool, error)
}

const (
	// maxRelayCuts bounds the cut map: an entry lives at most turn.max_allocation_age, so it holds
	// the cuts of one max-age window; past the cap the oldest cut is forgotten (its device is then
	// still refused by the barred lookup when it is barred, and by the max age in any case).
	maxRelayCuts = 4096
	// barredTTL is how long the relay trusts one barred lookup, and how often it re-checks the
	// devices that hold relay sockets: a device another process revoked loses the relay within it.
	barredTTL = 30 * time.Second
	// maxBarredCache bounds the lookup cache (least recently used out).
	maxBarredCache = 4096
	// barredLookupTimeout bounds one lookup; maxBarredLookups bounds the lookups in flight. pion
	// calls the auth handler on the client connection's own goroutine, so a slow store stalls only
	// that client, and never longer than the timeout; past the bound the relay does not wait.
	barredLookupTimeout = 2 * time.Second
	maxBarredLookups    = 8
)

// RelayRevocations is what the relay knows about devices that lost the right to it (task 13 review
// I1). It is created once by the composition root and shared by the relay (StartTURN) and the call
// routes (api.Calls.WithRelay).
//
//   - A cut (Revoke) records device → cut time. The relay's auth handler refuses every method of a
//     credential issued at or before its device's cut, and the device's live relay sockets are
//     closed at once: pion then deletes their allocations (allocation.go:375-381), which fires
//     OnAllocationDeleted and so frees the quota slots and moves the gauge. A credential issued
//     after the cut passes, which only a device that may take part in calls again can get. An
//     entry is dropped once turn.max_allocation_age has passed since the cut, when no credential
//     issued before it is honoured anyway.
//   - The barred lookup (WithBarred) covers what no cut reaches — a device another process revoked
//     that is in no call room. It is asked (through a cache of barredTTL) only about a device whose
//     request pion has authenticated — the OnAuth event, after the MESSAGE-INTEGRITY check — and,
//     every barredTTL, about each device that holds relay sockets; a barred device is cut. The
//     auth handler itself, which pion calls before the integrity check, reads the cut map only, so
//     no unauthenticated request causes a store read or a cache entry. A lookup that fails, times
//     out or finds the bound of lookups in flight reached caches nothing and is logged at WARN: the
//     relay never waits on the database, and such a device is bounded by turn.max_allocation_age
//     until a later lookup succeeds. The cut map stays authoritative whatever the lookup says.
type RelayRevocations struct {
	clk  clock.Clock
	keep int64 // seconds a cut is kept: turn.max_allocation_age

	mu    sync.Mutex
	cuts  map[string]int64
	socks map[string]map[*countingConn]struct{}

	barred   BarredLookup
	log      *slog.Logger
	cache    *barredCache
	inflight chan struct{}
	warned   time.Time
}

// NewRelayRevocations keeps each cut for maxAllocationAge (turn.max_allocation_age; 2 h when unset).
func NewRelayRevocations(maxAllocationAge time.Duration, clk clock.Clock) *RelayRevocations {
	if maxAllocationAge <= 0 {
		maxAllocationAge = 2 * time.Hour
	}
	return &RelayRevocations{
		clk: clk, keep: int64(maxAllocationAge / time.Second),
		cuts: map[string]int64{}, socks: map[string]map[*countingConn]struct{}{},
	}
}

// WithBarred makes the relay consult b about every device it authenticates and every device that
// holds a relay socket, and returns r. log receives the lookups that fail open.
func (r *RelayRevocations) WithBarred(b BarredLookup, log *slog.Logger) *RelayRevocations {
	if log == nil {
		log = slog.New(slog.DiscardHandler)
	}
	r.barred, r.log = b, log
	r.cache = newBarredCache(maxBarredCache)
	r.inflight = make(chan struct{}, maxBarredLookups)
	return r
}

// Revoke cuts device from the relay as of at: every credential of it issued at or before at is
// refused from now on, and its relay sockets are closed. It takes a lock, writes a map and closes
// sockets, and never blocks on anything else, so a request path may call it.
func (r *RelayRevocations) Revoke(device id.ID, at time.Time) {
	r.revoke(device.String(), at.Unix())
}

func (r *RelayRevocations) revoke(dev string, at int64) {
	r.mu.Lock()
	if prev, ok := r.cuts[dev]; !ok || at > prev {
		if !ok && len(r.cuts) >= maxRelayCuts {
			r.makeRoomLocked()
		}
		r.cuts[dev] = at
	}
	conns := r.socks[dev]
	delete(r.socks, dev)
	r.mu.Unlock()
	for c := range conns {
		_ = c.Close()
	}
}

// makeRoomLocked drops every expired cut and, if the map is still full, the oldest one.
func (r *RelayRevocations) makeRoomLocked() {
	now := r.clk.Now().Unix()
	oldest, oldestAt := "", int64(0)
	for dev, at := range r.cuts {
		if now > at+r.keep {
			delete(r.cuts, dev)
			continue
		}
		if oldest == "" || at < oldestAt {
			oldest, oldestAt = dev, at
		}
	}
	if len(r.cuts) >= maxRelayCuts {
		delete(r.cuts, oldest)
	}
}

// cutCovers reports whether a credential of dev issued at issued is cut.
func (r *RelayRevocations) cutCovers(dev string, issued int64) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	at, ok := r.cuts[dev]
	if !ok {
		return false
	}
	if r.clk.Now().Unix() > at+r.keep {
		delete(r.cuts, dev)
		return false
	}
	return issued <= at
}

// knownBarred reports whether the cache holds a fresh "barred" answer for dev. It reads memory
// only — no lookup, no insertion — so any caller may use it.
func (r *RelayRevocations) knownBarred(dev string) bool {
	if r.barred == nil {
		return false
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	bar, ok := r.cache.get(dev, r.clk.Now())
	return ok && bar
}

// checkBarred is the cached barred lookup for dev, which cuts a barred device as of now. It must be
// called only for a device whose request pion has authenticated, or one that holds a relay socket:
// it reads the store on a cache miss and caches the answer. A lookup that fails, or that finds
// maxBarredLookups already in flight, caches nothing and reports false: the device stays bounded
// by the cut map and turn.max_allocation_age, and its next authenticated request or the holders'
// re-check asks again.
func (r *RelayRevocations) checkBarred(dev string) bool {
	if r.barred == nil {
		return false
	}
	now := r.clk.Now()
	r.mu.Lock()
	bar, ok := r.cache.get(dev, now)
	r.mu.Unlock()
	if ok {
		return bar
	}
	device, err := id.Parse(dev)
	if err != nil {
		return false
	}
	select {
	case r.inflight <- struct{}{}:
	default:
		r.warn("the relay's barred lookups are saturated; this device is checked on its next request", "device", dev)
		return false
	}
	ctx, cancel := context.WithTimeout(context.Background(), barredLookupTimeout)
	bar, err = r.barred.DeviceBarred(ctx, device)
	cancel()
	<-r.inflight
	if err != nil {
		r.warn("the relay's barred lookup failed; this device is checked on its next request", "device", dev, "err", err)
		return false
	}
	r.mu.Lock()
	r.cache.put(dev, bar, now.Add(barredTTL))
	r.mu.Unlock()
	if bar {
		r.revoke(dev, now.Unix())
	}
	return bar
}

// warn logs a fail-open lookup at most once per barredTTL, so a flood of them cannot flood the log.
func (r *RelayRevocations) warn(msg string, args ...any) {
	now := r.clk.Now()
	r.mu.Lock()
	quiet := now.Sub(r.warned) < barredTTL
	if !quiet {
		r.warned = now
	}
	r.mu.Unlock()
	if !quiet {
		r.log.Warn(msg, args...)
	}
}

// checkHolders asks the barred lookup about every device holding a relay socket, which cuts the
// barred ones: what keeps a device that only sends ChannelData — never authenticated — from
// outliving its revocation by another process.
func (r *RelayRevocations) checkHolders() {
	if r.barred == nil {
		return
	}
	r.mu.Lock()
	devs := make([]string, 0, len(r.socks))
	for dev := range r.socks {
		devs = append(devs, dev)
	}
	r.mu.Unlock()
	for _, dev := range devs {
		r.checkBarred(dev)
	}
}

// watch runs checkHolders every barredTTL until stop is closed.
func (r *RelayRevocations) watch(stop <-chan struct{}) {
	tick := time.NewTicker(barredTTL)
	defer tick.Stop()
	for {
		select {
		case <-stop:
			return
		case <-tick.C:
			r.checkHolders()
		}
	}
}

// track records c as one of dev's relay sockets; untrack forgets it.
func (r *RelayRevocations) track(dev string, c *countingConn) {
	r.mu.Lock()
	defer r.mu.Unlock()
	set := r.socks[dev]
	if set == nil {
		set = map[*countingConn]struct{}{}
		r.socks[dev] = set
	}
	set[c] = struct{}{}
}

func (r *RelayRevocations) untrack(dev string, c *countingConn) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if set := r.socks[dev]; set != nil {
		delete(set, c)
		if len(set) == 0 {
			delete(r.socks, dev)
		}
	}
}

// barredCache is a bounded least-recently-used cache of barred lookups; its owner locks it.
type barredCache struct {
	max int
	ll  *list.List
	m   map[string]*list.Element
}

type barredEntry struct {
	dev   string
	bar   bool
	until time.Time
}

func newBarredCache(maxEntries int) *barredCache {
	return &barredCache{max: maxEntries, ll: list.New(), m: map[string]*list.Element{}}
}

func (c *barredCache) get(dev string, now time.Time) (bool, bool) {
	e, ok := c.m[dev]
	if !ok {
		return false, false
	}
	ent, _ := e.Value.(*barredEntry) // the list holds only *barredEntry
	if !now.Before(ent.until) {
		c.ll.Remove(e)
		delete(c.m, dev)
		return false, false
	}
	c.ll.MoveToFront(e)
	return ent.bar, true
}

func (c *barredCache) put(dev string, bar bool, until time.Time) {
	if e, ok := c.m[dev]; ok {
		ent, _ := e.Value.(*barredEntry) // the list holds only *barredEntry
		ent.bar, ent.until = bar, until
		c.ll.MoveToFront(e)
		return
	}
	c.m[dev] = c.ll.PushFront(&barredEntry{dev: dev, bar: bar, until: until})
	if c.ll.Len() > c.max {
		last := c.ll.Back()
		c.ll.Remove(last)
		if ent, ok := last.Value.(*barredEntry); ok {
			delete(c.m, ent.dev)
		}
	}
}
