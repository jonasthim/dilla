package auth

import (
	"net/netip"
	"sync"
	"time"

	"github.com/jonasthim/dilla/internal/clock"
	"github.com/jonasthim/dilla/internal/config"
	"github.com/jonasthim/dilla/internal/id"
	"github.com/jonasthim/dilla/internal/server"
)

// Throttle is the login-specific half of rate limiting: a token bucket for the
// attempt rate, plus a per-account and per-address failure ledger that produces
// a growing lockout. Both halves are needed — the bucket bounds how fast an
// attacker may try, the ledger bounds how many times they may be wrong.
type Throttle struct {
	limiter *server.RateLimiter
	lockout config.Lockout
	clk     clock.Clock

	mu     sync.Mutex
	byUser map[id.ID][]time.Time
	byAddr map[string][]time.Time
}

func NewThrottle(c config.Rate, l config.Lockout, clk clock.Clock) *Throttle {
	return &Throttle{
		limiter: server.NewRateLimiter(c, clk), lockout: l, clk: clk,
		byUser: map[id.ID][]time.Time{}, byAddr: map[string][]time.Time{},
	}
}

// Classes is the fixed set of login-adjacent buckets.
func Classes(c config.Rate) map[string]server.Class {
	return map[string]server.Class{
		"login":        {Name: "login", PerSecond: c.LoginPerSecond, Burst: c.LoginBurst},
		"login_failed": {Name: "login_failed", PerSecond: c.LoginFailedPerSecond, Burst: c.LoginFailedBurst},
		"register":     {Name: "register", PerSecond: c.RegisterPerSecond, Burst: c.RegisterBurst},
		"invite":       {Name: "invite", PerSecond: c.InvitePerSecond, Burst: c.InviteBurst},
		"unauth":       {Name: "unauth", PerSecond: c.UnauthPerSecond, Burst: c.UnauthBurst},
	}
}

// Allow meters one attempt. An unknown class is allowed rather than refused: a
// typo in a class name must not lock a route out entirely.
func (t *Throttle) Allow(class string, key string) (bool, time.Duration) {
	c, ok := Classes(t.limiterConfig())[class]
	if !ok {
		return true, 0
	}
	return t.limiter.Allow(c, key)
}

// Peek asks a bucket's state without spending a token. It exists for
// `login_failed`, whose only writer is RecordFailure: a route that gated on it
// with Allow would meter every SUCCESSFUL login on the failure bucket, so the
// route reads it with Peek instead and the failures alone fill it.
func (t *Throttle) Peek(class string, key string) (bool, time.Duration) {
	c, ok := Classes(t.limiterConfig())[class]
	if !ok {
		return true, 0
	}
	return t.limiter.Peek(c, key)
}

func (t *Throttle) limiterConfig() config.Rate { return t.limiter.Config() }

// RecordFailure records one failed authentication and returns how long the
// account is locked from this moment. The first free_attempts cost nothing;
// after that the lockout doubles from first_lockout up to lockout_ceiling; at
// hard_ceiling consecutive failures the account is locked for the ceiling
// indefinitely, which is NIST SP 800-63B Rev. 4's "no more than 100" SHALL.
//
// This is the WRITER. LockedFor is the gate that enforces what it returns.
func (t *Throttle) RecordFailure(userID id.ID, ip netip.Addr) time.Duration {
	now := t.clk.Now()
	window := t.lockout.ObservationWindow.Value()

	t.mu.Lock()
	defer t.mu.Unlock()
	t.byUser[userID] = appendWithin(t.byUser[userID], now, window)
	key := server.RateKey(ip)
	t.byAddr[key] = appendWithin(t.byAddr[key], now, window)
	// The address ledger feeds the login_failed bucket, so fifty failures across
	// fifty accounts from one address still throttle that address.
	t.limiter.Allow(Classes(t.limiterConfig())["login_failed"], key)

	return t.curve(len(t.byUser[userID]))
}

// LockedFor is the standing gate RecordFailure's return value only describes:
// how long this account is locked RIGHT NOW, measured from its last failure,
// asked without adding a failure of its own. A handler calls it before it
// checks the credential, because a lockout that is only reported after the
// credential has been verified lets the attacker whose next guess happens to be
// correct straight through it.
//
// It prunes the account's expired failures while it holds the lock, which is
// Sweep's work done early and changes no answer.
func (t *Throttle) LockedFor(userID id.ID) time.Duration {
	now := t.clk.Now()
	window := t.lockout.ObservationWindow.Value()

	t.mu.Lock()
	defer t.mu.Unlock()
	ts := within(t.byUser[userID], now, window)
	if len(ts) == 0 {
		delete(t.byUser, userID)
		return 0
	}
	t.byUser[userID] = ts
	d := t.curve(len(ts))
	if d == 0 {
		return 0
	}
	// From the LAST failure, not from the first: a lockout that only lifts when
	// the whole observation window rolls over would never let the curve double,
	// and would hold a legitimate owner out for fifteen minutes on a thirty
	// second penalty.
	if remaining := ts[len(ts)-1].Add(d).Sub(now); remaining > 0 {
		return remaining
	}
	return 0
}

// curve maps a count of failures inside the observation window to the lockout
// it earns: the first free_attempts cost nothing, then first_lockout doubling
// up to lockout_ceiling, and the ceiling flat from hard_ceiling on.
func (t *Throttle) curve(n int) time.Duration {
	if n <= t.lockout.FreeAttempts {
		return 0
	}
	if n >= t.lockout.HardCeiling {
		return t.lockout.LockoutCeiling.Value()
	}
	d := t.lockout.FirstLockout.Value()
	for i := t.lockout.FreeAttempts + 1; i < n; i++ {
		d *= 2
		if d >= t.lockout.LockoutCeiling.Value() {
			return t.lockout.LockoutCeiling.Value()
		}
	}
	return d
}

// Clear forgets an account's failures after a successful login.
func (t *Throttle) Clear(userID id.ID) {
	t.mu.Lock()
	defer t.mu.Unlock()
	delete(t.byUser, userID)
}

// Sweep drops failures older than the observation window and empties the
// entries they leave behind, so the two maps do not grow without bound.
func (t *Throttle) Sweep() {
	now := t.clk.Now()
	window := t.lockout.ObservationWindow.Value()
	t.mu.Lock()
	defer t.mu.Unlock()
	for k, v := range t.byUser {
		if v = within(v, now, window); len(v) == 0 {
			delete(t.byUser, k)
		} else {
			t.byUser[k] = v
		}
	}
	for k, v := range t.byAddr {
		if v = within(v, now, window); len(v) == 0 {
			delete(t.byAddr, k)
		} else {
			t.byAddr[k] = v
		}
	}
	t.limiter.Sweep()
}

// Tracked is how many entries the throttle holds: accounts and addresses with failures inside the
// observation window, plus the limiter's buckets. Sweep is what keeps it bounded.
func (t *Throttle) Tracked() int {
	t.mu.Lock()
	n := len(t.byUser) + len(t.byAddr)
	t.mu.Unlock()
	return n + t.limiter.Len()
}

func appendWithin(ts []time.Time, now time.Time, window time.Duration) []time.Time {
	return append(within(ts, now, window), now)
}

func within(ts []time.Time, now time.Time, window time.Duration) []time.Time {
	cutoff := now.Add(-window)
	out := ts[:0]
	for _, t := range ts {
		if t.After(cutoff) {
			out = append(out, t)
		}
	}
	return out
}
