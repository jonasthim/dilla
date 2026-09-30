package api

import (
	"math"
	"sync"
	"time"

	"github.com/jonasthim/dilla/internal/clock"
	"github.com/jonasthim/dilla/internal/id"
	"github.com/jonasthim/dilla/internal/server"
)

// blobMeter is the per-user upload meter of [blobs] (fix wave C7): uploads_per_minute is a
// request bucket and upload_bytes_per_day a byte bucket, both token buckets that refill
// continuously and start full. A PUT reserves one request and the bytes it may write before a
// byte of the body is read, and settles the byte reservation to what was actually read once the
// upload is over, so bytes the instance read and then refused (a hash mismatch, a quota refusal
// after the body), orphaned, or later deleted all spend the budget: deleting an attachment frees
// quota, never the day's budget. A zero or negative setting turns its bucket off.
//
// The buckets live in memory: a restart refills them. Their number is bounded by the enrolled
// users who uploaded since the process started.
type blobMeter struct {
	clk       clock.Clock
	perMinute float64
	perDay    float64

	mu    sync.Mutex
	users map[id.ID]*uploadBuckets
}

type uploadBuckets struct {
	requests, bytes float64
	at              time.Time
}

func newBlobMeter(clk clock.Clock, perMinute int, perDay int64) *blobMeter {
	return &blobMeter{clk: clk, perMinute: float64(perMinute), perDay: float64(perDay),
		users: map[id.ID]*uploadBuckets{}}
}

// refill brings u up to now and answers it.
func (m *blobMeter) refill(user id.ID) *uploadBuckets {
	now := m.clk.Now()
	u, ok := m.users[user]
	if !ok {
		u = &uploadBuckets{requests: m.perMinute, bytes: m.perDay, at: now}
		m.users[user] = u
		return u
	}
	elapsed := now.Sub(u.at).Seconds()
	if elapsed > 0 {
		u.requests = math.Min(m.perMinute, u.requests+elapsed*m.perMinute/60)
		u.bytes = math.Min(m.perDay, u.bytes+elapsed*m.perDay/86400)
		u.at = now
	}
	return u
}

// begin reserves one upload of at most reserve bytes for user, or answers 429 E_RATE_LIMITED with
// the wait until it would fit. It answers the byte reservation settle must be given back.
func (m *blobMeter) begin(user id.ID, reserve int64) (int64, error) {
	if m == nil {
		return 0, nil
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	u := m.refill(user)
	if m.perMinute > 0 && u.requests < 1 {
		return 0, server.RateLimitedAfter(time.Duration((1 - u.requests) * 60 / m.perMinute * float64(time.Second)))
	}
	held := float64(reserve)
	if m.perDay <= 0 {
		held = 0
	} else if held > m.perDay {
		// A reservation larger than the whole budget could never be met; the body
		// limit still bounds what one upload writes.
		held = m.perDay
	}
	if held > 0 && u.bytes < held {
		return 0, server.RateLimitedAfter(time.Duration((held - u.bytes) * 86400 / m.perDay * float64(time.Second)))
	}
	if m.perMinute > 0 {
		u.requests--
	}
	u.bytes -= held
	return int64(held), nil
}

// settle gives back what begin held beyond the bytes the upload actually read.
func (m *blobMeter) settle(user id.ID, held, used int64) {
	if m == nil || m.perDay <= 0 {
		return
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	u := m.refill(user)
	u.bytes = math.Min(m.perDay, u.bytes+float64(held-used))
}
