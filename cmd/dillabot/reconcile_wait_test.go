//go:build linux

package main

import (
	"context"
	"sync"
	"testing"
	"time"
)

// fakeWaitClock hands out timers the test fires by hand and records what was asked for.
type fakeWaitClock struct {
	mu     sync.Mutex
	now    time.Time
	timers []fakeWaitTimer
}
type fakeWaitTimer struct {
	d  time.Duration
	ch chan time.Time
}

func (c *fakeWaitClock) Now() time.Time { c.mu.Lock(); defer c.mu.Unlock(); return c.now }
func (c *fakeWaitClock) After(d time.Duration) <-chan time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	ch := make(chan time.Time, 1)
	c.timers = append(c.timers, fakeWaitTimer{d: d, ch: ch})
	return ch
}
func (c *fakeWaitClock) asked() []time.Duration {
	c.mu.Lock()
	defer c.mu.Unlock()
	out := make([]time.Duration, len(c.timers))
	for i, t := range c.timers {
		out[i] = t.d
	}
	return out
}
func (c *fakeWaitClock) fire(d time.Duration) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	for _, t := range c.timers {
		if t.d == d {
			t.ch <- c.now
			return true
		}
	}
	return false
}

type waitHarness struct {
	clock       *fakeWaitClock
	wake        chan struct{}
	interaction chan struct{}
	polls       chan struct{}
	done        chan bool
	cancel      context.CancelFunc
}

func startWait(t *testing.T, interval time.Duration) *waitHarness {
	t.Helper()
	h := &waitHarness{clock: &fakeWaitClock{now: time.Unix(1_800_000_000, 0)}, wake: make(chan struct{}, 1), interaction: make(chan struct{}, 1), polls: make(chan struct{}, 8), done: make(chan bool, 1)}
	ctx, cancel := context.WithCancel(t.Context())
	h.cancel = cancel
	w := reconcileWait{interval: interval, wake: h.wake, interaction: h.interaction,
		poll: func(context.Context) { h.polls <- struct{}{} }, now: h.clock.Now, after: h.clock.After}
	// The reconciliation pass that just ended started 1 s ago.
	started := h.clock.Now().Add(-time.Second)
	go func() { h.done <- w.wait(ctx, started) }()
	t.Cleanup(cancel)
	return h
}

func (h *waitHarness) expectPoll(t *testing.T, why string) {
	t.Helper()
	select {
	case <-h.polls:
	case <-time.After(2 * time.Second):
		t.Fatalf("no text intake poll: %s (timers asked: %v)", why, h.clock.asked())
	}
}

func (h *waitHarness) expectNoPoll(t *testing.T, why string) {
	t.Helper()
	select {
	case <-h.polls:
		t.Fatalf("text intake polled: %s", why)
	case <-time.After(100 * time.Millisecond):
	}
}

// CT 144, 2026-10-30: the provider-status panel sends operation 24 as soon as operation 0's reply
// arrives, which is within the general 5 s gateway throttle of the poll that answered operation 0.
// A participant's message in a private interaction group is a command waiting for an answer, so it
// is polled at once.
func TestInteractionGroupMessagePollsWithoutTheGatewayThrottle(t *testing.T) {
	h := startWait(t, 30*time.Second)
	h.interaction <- struct{}{}
	h.expectPoll(t, "an interaction-group message must not wait for the 5 s gateway throttle")
	h.interaction <- struct{}{}
	h.expectPoll(t, "a second command right after the first must not wait either")
}

// Other gateway hints (welcomes, epochs, channel messages) still refresh text sources at most once
// per 5 s; only the interval timer runs full reconciliation.
func TestGeneralGatewayWakeStaysThrottled(t *testing.T) {
	h := startWait(t, 30*time.Second)
	h.wake <- struct{}{}
	h.expectNoPoll(t, "a general hint 1 s after the pass must wait out the 5 s throttle")
	deadline := time.Now().Add(2 * time.Second)
	for !h.clock.fire(4*time.Second) && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	h.expectPoll(t, "the throttle elapsed")
}

// An interaction-group message that arrives while a general hint is held by the throttle cuts the
// throttle short.
func TestInteractionMessageCutsAGeneralThrottleShort(t *testing.T) {
	h := startWait(t, 30*time.Second)
	h.wake <- struct{}{}
	h.expectNoPoll(t, "a general hint is throttled")
	h.interaction <- struct{}{}
	h.expectPoll(t, "the interaction message must not wait behind the throttled hint")
}

// The interval still ends the wait, so full reconciliation stays the safety net.
func TestReconcileIntervalEndsTheWait(t *testing.T) {
	h := startWait(t, 30*time.Second)
	deadline := time.Now().Add(2 * time.Second)
	for !h.clock.fire(30*time.Second) && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	select {
	case again := <-h.done:
		if !again {
			t.Fatal("the interval ended the wait as a shutdown")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("the reconcile interval did not end the wait")
	}
	h.cancel()
}
