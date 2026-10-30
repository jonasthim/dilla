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
	WritePerSecond   float64 `toml:"write_per_second"`
	WriteBurst       int     `toml:"write_burst"`
	ReadPerSecond    float64 `toml:"read_per_second"`
	ReadBurst        int     `toml:"read_burst"`
	MessagePerSecond float64 `toml:"message_per_second"`
	MessageBurst     int     `toml:"message_burst"`
}

func (r RateLimits) defaults() (RateLimits, error) {
	for _, v := range []struct {
		rate         *float64
		burst        *int
		defaultRate  float64
		defaultBurst int
	}{
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

type deviceLimiter struct{ write, read, message *rate.Limiter }

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
	c.devices[tokenKey(token)] = "device/" + device.String()
	c.rateMu.Unlock()
	return s, nil
}

// Mirror internal/api/dsmeter.go:routeClass and the explicit upload routes in
// internal/api/messages.go and internal/api/bot_message.go. Bot uploads are WRITE,
// ordinary ciphertext /message and readable channel /messages uploads are MESSAGE.
// Commit/proposal requests also spend the write budget; their specialized
// server allowances remain enforced by the shared retry path.
func requestClass(method, path string) string {
	if method == http.MethodGet || method == http.MethodHead {
		return "read"
	}
	parts := strings.Split(strings.Trim(path, "/"), "/")
	if method == http.MethodPost && len(parts) == 3 && ((parts[0] == "groups" && parts[2] == "message") || (parts[0] == "channels" && parts[2] == "messages")) {
		return "message"
	}
	return "write"
}

func (c *Client) waitRate(ctx context.Context, token, method, path string) error {
	key := tokenKey(token)
	c.rateMu.Lock()
	if device, ok := c.devices[key]; ok {
		key = device
	}
	b := c.buckets[key]
	if b == nil {
		b = &deviceLimiter{write: rate.NewLimiter(rate.Limit(c.rates.WritePerSecond), c.rates.WriteBurst), read: rate.NewLimiter(rate.Limit(c.rates.ReadPerSecond), c.rates.ReadBurst), message: rate.NewLimiter(rate.Limit(c.rates.MessagePerSecond), c.rates.MessageBurst)}
		c.buckets[key] = b
	}
	c.rateMu.Unlock()
	limiter := b.write
	switch requestClass(method, path) {
	case "read":
		limiter = b.read
	case "message":
		limiter = b.message
	}
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
