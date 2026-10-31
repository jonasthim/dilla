package client

import (
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"math"
	"net/http"
	"strings"
	"sync"
	"time"

	"golang.org/x/time/rate"

	"github.com/jonasthim/dilla/internal/id"
)

// RateLimits may be overridden by [rate_limits] in bot.toml. Zero fields use
// conservative defaults below the instance's default per-device allowances.
type RateLimits struct {
	WritePerSecond      float64 `toml:"write_per_second"`
	WriteBurst          int     `toml:"write_burst"`
	ReadPerSecond       float64 `toml:"read_per_second"`
	ReadBurst           int     `toml:"read_burst"`
	MessagePerSecond    float64 `toml:"message_per_second"`
	MessageBurst        int     `toml:"message_burst"`
	CommitPerSecond     float64 `toml:"commit_per_second"`
	CommitBurst         int     `toml:"commit_burst"`
	ProposalPerSecond   float64 `toml:"proposal_per_second"`
	ProposalBurst       int     `toml:"proposal_burst"`
	KeyPackagePerSecond float64 `toml:"keypackage_per_second"`
	KeyPackageBurst     int     `toml:"keypackage_burst"`
}

func (r RateLimits) defaults() (RateLimits, error) {
	for _, v := range []struct {
		rate         *float64
		burst        *int
		defaultRate  float64
		defaultBurst int
	}{
		{&r.CommitPerSecond, &r.CommitBurst, 1.5, 30}, {&r.ProposalPerSecond, &r.ProposalBurst, .4, 8}, {&r.KeyPackagePerSecond, &r.KeyPackageBurst, .4, 8},
		{&r.WritePerSecond, &r.WriteBurst, 1.5, 20}, {&r.ReadPerSecond, &r.ReadBurst, 8, 40}, {&r.MessagePerSecond, &r.MessageBurst, .8, 10},
	} {
		if *v.rate == 0 {
			*v.rate = v.defaultRate
		}
		if *v.burst == 0 {
			*v.burst = v.defaultBurst
		}
		if *v.rate < 0 || math.IsNaN(*v.rate) || math.IsInf(*v.rate, 0) || *v.burst < 1 {
			return r, ErrInvalidConfig
		}
	}
	return r, nil
}

type interactiveContextKey struct{}

// WithInteractive marks a person's command and its downstream requests.
func WithInteractive(ctx context.Context) context.Context {
	return context.WithValue(ctx, interactiveContextKey{}, true)
}

type backgroundYieldContextKey struct{}

// WithBackgroundYield lets the single-threaded service defer a sweep between
// requests when gateway work is ready. Interactive contexts bypass the check.
// ready must be safe to call on the requesting goroutine.
func WithBackgroundYield(ctx context.Context, ready func() bool) context.Context {
	return context.WithValue(ctx, backgroundYieldContextKey{}, ready)
}

func backgroundShouldYield(ctx context.Context) bool {
	if interactive, _ := ctx.Value(interactiveContextKey{}).(bool); interactive {
		return false
	}
	ready, _ := ctx.Value(backgroundYieldContextKey{}).(func() bool)
	return ready != nil && ready()
}

// A yielded request has not been sent. Use the existing local pacing deferral
// so callers retain their durable state and retry it on the next sweep.
func backgroundYieldError() error {
	retry := uint64(1)
	return &APIError{Status: http.StatusTooManyRequests, Code: "E_RATE_LIMITED", Outcome: OutcomeDefinitive, RetryAfterMS: &retry}
}

// priorityLimiter never reserves future tokens. Interactive waiters take the
// next available token; background waiters sleep while interactive demand exists.
// Both priorities spend the same bucket, including its initial burst.
type priorityLimiter struct {
	*rate.Limiter
	mu          sync.Mutex
	interactive int
	changed     chan struct{}
}

func newPriorityLimiter(limit rate.Limit, burst int) *priorityLimiter {
	return &priorityLimiter{Limiter: rate.NewLimiter(limit, burst), changed: make(chan struct{})}
}

func (l *priorityLimiter) notifyLocked() {
	close(l.changed)
	l.changed = make(chan struct{})
}

func (l *priorityLimiter) Wait(ctx context.Context) error {
	interactive, _ := ctx.Value(interactiveContextKey{}).(bool)
	if interactive {
		l.mu.Lock()
		l.interactive++
		l.notifyLocked()
		l.mu.Unlock()
		defer func() {
			l.mu.Lock()
			l.interactive--
			l.notifyLocked()
			l.mu.Unlock()
		}()
	}
	for {
		if err := ctx.Err(); err != nil {
			return err
		}
		if backgroundShouldYield(ctx) {
			return backgroundYieldError()
		}
		l.mu.Lock()
		if (interactive || l.interactive == 0) && l.Allow() {
			l.mu.Unlock()
			return nil
		}
		changed := l.changed
		delay := time.Duration(math.Ceil(max(0, 1-l.Tokens()) / float64(l.Limit()) * float64(time.Second)))
		// A background waiter with available tokens still yields to interactive demand.
		if delay <= 0 {
			delay = time.Millisecond
		}
		if deadline, ok := ctx.Deadline(); ok && time.Until(deadline) < delay {
			l.mu.Unlock()
			return context.DeadlineExceeded
		}
		// Check for new gateway work even while waiting for a slow class token.
		if ready, _ := ctx.Value(backgroundYieldContextKey{}).(func() bool); !interactive && ready != nil {
			delay = min(delay, 25*time.Millisecond)
		}
		l.mu.Unlock()
		timer := time.NewTimer(delay)
		select {
		case <-ctx.Done():
			timer.Stop()
			return ctx.Err()
		case <-changed:
			timer.Stop()
		case <-timer.C:
		}
	}
}

type deviceLimiter struct {
	write, read, message, commit, proposal *priorityLimiter
	keypackages                            map[string]*priorityLimiter
}

func tokenKey(token string) string { return fmt.Sprintf("%x", sha256.Sum256([]byte(token))) }

// SessionForDevice keeps one budget through session renewal and restoration.
// Session is still available for callers without a known device identity.
func (c *Client) SessionForDevice(token string, device id.ID) (*Session, error) {
	s, err := c.Session(token)
	if err != nil {
		return nil, err
	}
	if device.IsZero() {
		return nil, ErrInvalidConfig
	}
	c.rateMu.Lock()
	key, deviceKey := tokenKey(token), "device/"+device.String()
	for retired, owner := range c.devices {
		if owner == deviceKey && retired != key {
			delete(c.devices, retired)
			delete(c.buckets, retired)
		}
	}
	// A restored token may already have a fallback budget; retain it on binding.
	if b := c.buckets[key]; b != nil {
		if c.buckets[deviceKey] == nil {
			c.buckets[deviceKey] = b
		}
		delete(c.buckets, key)
	}
	c.devices[key] = deviceKey
	s.deviceRateKey = deviceKey
	c.rateMu.Unlock()
	return s, nil
}

// Mirror internal/api/dsmeter.go:routeClass and the explicit upload routes in
// internal/api/messages.go and internal/api/bot_message.go. Bot uploads are WRITE,
// ordinary ciphertext /message and readable channel /messages uploads are MESSAGE.
// Specialized sequencer routes use their explicit server classes. KeyPackage
// fetches spend both read and per-(requester,target) budgets.
func requestClass(method, path string) string {
	parts := strings.Split(strings.Trim(path, "/"), "/")
	if method == http.MethodGet && len(parts) == 3 && parts[0] == "devices" && parts[2] == "keypackage" {
		return "keypackage"
	}
	if method == http.MethodPost {
		if len(parts) == 3 && parts[0] == "groups" {
			switch parts[2] {
			case "commit", "resync", "heal":
				return "commit"
			case "proposal":
				return "proposal"
			}
		}
		if len(parts) == 6 && parts[0] == "bot-runtime" && parts[1] == "installations" && parts[3] == "interaction-groups" && parts[5] == "heal" {
			return "commit"
		}
	}
	if method == http.MethodGet || method == http.MethodHead {
		return "read"
	}
	if method == http.MethodPost && len(parts) == 3 && ((parts[0] == "groups" && parts[2] == "message") || (parts[0] == "channels" && parts[2] == "messages")) {
		return "message"
	}
	return "write"
}

func (c *Client) waitRate(ctx context.Context, token, method, path string) error {
	if backgroundShouldYield(ctx) {
		return backgroundYieldError()
	}
	key := tokenKey(token)
	c.rateMu.Lock()
	if device, ok := ctx.Value(deviceRateContextKey{}).(string); ok {
		key = device
	} else if device, ok := c.devices[key]; ok {
		key = device
	}
	b := c.buckets[key]
	if b == nil {
		b = &deviceLimiter{
			commit:      newPriorityLimiter(rate.Limit(c.rates.CommitPerSecond), c.rates.CommitBurst),
			proposal:    newPriorityLimiter(rate.Limit(c.rates.ProposalPerSecond), c.rates.ProposalBurst),
			keypackages: make(map[string]*priorityLimiter),
			write:       newPriorityLimiter(rate.Limit(c.rates.WritePerSecond), c.rates.WriteBurst),
			read:        newPriorityLimiter(rate.Limit(c.rates.ReadPerSecond), c.rates.ReadBurst),
			message:     newPriorityLimiter(rate.Limit(c.rates.MessagePerSecond), c.rates.MessageBurst),
		}
		c.buckets[key] = b
	}
	class := requestClass(method, path)
	var keypackage *priorityLimiter
	if class == "keypackage" {
		target := strings.Split(strings.Trim(path, "/"), "/")[1]
		keypackage = b.keypackages[target]
		if keypackage == nil {
			keypackage = newPriorityLimiter(rate.Limit(c.rates.KeyPackagePerSecond), c.rates.KeyPackageBurst)
			b.keypackages[target] = keypackage
		}
	}
	c.rateMu.Unlock()
	if keypackage != nil {
		if err := waitLimiter(ctx, keypackage); err != nil {
			return err
		}
	}
	limiter := b.write
	switch class {
	case "commit":
		limiter = b.commit
	case "proposal":
		limiter = b.proposal
	case "keypackage", "read":
		limiter = b.read
	case "message":
		limiter = b.message
	}
	return waitLimiter(ctx, limiter)
}

func waitLimiter(ctx context.Context, limiter *priorityLimiter) error {
	if err := limiter.Wait(ctx); err != nil {
		if deficit := 1 - limiter.Tokens(); deficit > 0 {
			retry := uint64(math.Ceil(deficit / float64(limiter.Limit()) * 1000))
			cause := ctx.Err()
			if cause == nil {
				cause = context.DeadlineExceeded
			}
			return errors.Join(&APIError{Status: http.StatusTooManyRequests, Code: "E_RATE_LIMITED", Outcome: OutcomeDefinitive, RetryAfterMS: &retry}, cause)
		}
		return err
	}
	return nil
}
