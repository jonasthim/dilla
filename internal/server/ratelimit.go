package server

import (
	"math"
	"sync"
	"time"

	"golang.org/x/time/rate"

	"github.com/jonasthim/dilla/internal/clock"
	"github.com/jonasthim/dilla/internal/config"
)

// Class is one metered thing: a name, a rate and a burst.
type Class struct {
	Name      string
	PerSecond float64
	Burst     int
}

type bucket struct {
	lim  *rate.Limiter
	seen time.Time
}

// RateLimiter is an in-process token-bucket map keyed by (class, subject).
type RateLimiter struct {
	mu      sync.Mutex
	buckets map[string]*bucket
	cfg     config.Rate
	clk     clock.Clock
	maxWait time.Duration
}

func NewRateLimiter(c config.Rate, clk clock.Clock) *RateLimiter {
	return &RateLimiter{buckets: make(map[string]*bucket), cfg: c, clk: clk, maxWait: c.MaxRetryAfter.Value()}
}

// Allow refuses with AllowN(now, 1), never with Reserve(): a denied AllowN
// mutates nothing, while Reserve consumes a token even when the caller intends
// to refuse, so a client that is already being throttled gets throttled harder
// for asking (gap-49 verdicts 9 and 10).
//
// Every call passes l.clk.Now() rather than letting x/time/rate read the wall
// clock: a limiter that ignores the injected clock makes its own tests
// timing-dependent, which is the whole reason the seam exists.
func (l *RateLimiter) Allow(class Class, key string) (bool, time.Duration) {
	if !l.cfg.Enabled {
		return true, 0
	}
	k := class.Name + "\x00" + key
	now := l.clk.Now()
	l.mu.Lock()
	b, ok := l.buckets[k]
	if !ok {
		if len(l.buckets) >= l.cfg.MaxKeys {
			l.evictOldestLocked()
		}
		b = &bucket{lim: rate.NewLimiter(rate.Limit(class.PerSecond), class.Burst)}
		l.buckets[k] = b
	}
	b.seen = now
	l.mu.Unlock()

	if b.lim.AllowN(now, 1) {
		return true, 0
	}
	// §5.3: retry_after_ms is computed from the bucket's DEFICIT and rounded up,
	// not from the constant 1/rate. The deficit is how far short of one token
	// the bucket is right now: a caller refused the instant the bucket emptied
	// waits a full 1/rate, one refused 90% of the way back waits a tenth of it,
	// and telling both the same number sends the second one away for nine times
	// longer than it needed to.
	deficit := 1 - b.lim.TokensAt(now)
	if deficit < 0 {
		deficit = 0
	}
	ms := math.Ceil(deficit / class.PerSecond * 1000) // rounded UP to the next millisecond
	if ms < 1 {
		ms = 1
	}
	wait := time.Duration(ms) * time.Millisecond
	if l.maxWait > 0 && wait > l.maxWait {
		wait = l.maxWait
	}
	return false, wait
}

// Sweep drops every bucket that is full, which is behaviour-preserving: a full
// bucket is indistinguishable from a fresh one.
func (l *RateLimiter) Sweep() {
	now := l.clk.Now()
	l.mu.Lock()
	defer l.mu.Unlock()
	for k, b := range l.buckets {
		if b.lim.TokensAt(now) >= float64(b.lim.Burst()) {
			delete(l.buckets, k)
		}
	}
}

func (l *RateLimiter) Len() int {
	l.mu.Lock()
	defer l.mu.Unlock()
	return len(l.buckets)
}

func (l *RateLimiter) evictOldestLocked() {
	var oldestKey string
	var oldest time.Time
	for k, b := range l.buckets {
		if oldest.IsZero() || b.seen.Before(oldest) {
			oldestKey, oldest = k, b.seen
		}
	}
	delete(l.buckets, oldestKey)
}
