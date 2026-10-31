package client

import (
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"math"
	"net/http"
	"strings"

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

type deviceLimiter struct {
	write, read, message, commit, proposal *rate.Limiter
	keypackages                            map[string]*rate.Limiter
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
			commit:      rate.NewLimiter(rate.Limit(c.rates.CommitPerSecond), c.rates.CommitBurst),
			proposal:    rate.NewLimiter(rate.Limit(c.rates.ProposalPerSecond), c.rates.ProposalBurst),
			keypackages: make(map[string]*rate.Limiter),
			write:       rate.NewLimiter(rate.Limit(c.rates.WritePerSecond), c.rates.WriteBurst),
			read:        rate.NewLimiter(rate.Limit(c.rates.ReadPerSecond), c.rates.ReadBurst),
			message:     rate.NewLimiter(rate.Limit(c.rates.MessagePerSecond), c.rates.MessageBurst),
		}
		c.buckets[key] = b
	}
	class := requestClass(method, path)
	var keypackage *rate.Limiter
	if class == "keypackage" {
		target := strings.Split(strings.Trim(path, "/"), "/")[1]
		keypackage = b.keypackages[target]
		if keypackage == nil {
			keypackage = rate.NewLimiter(rate.Limit(c.rates.KeyPackagePerSecond), c.rates.KeyPackageBurst)
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

func waitLimiter(ctx context.Context, limiter *rate.Limiter) error {
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
