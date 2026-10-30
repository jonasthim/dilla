//go:build linux

package main

import (
	"context"
	"sync"
	"testing"
	"time"
)

// fakeWaitClock fires the timers it handed out when the test advances it.
type fakeWaitClock struct {
	mu     sync.Mutex
	now    time.Time
	timers []*fakeWaitTimer
}
type fakeWaitTimer struct {
	at    time.Time
	ch    chan time.Time
	fired bool
}

func (c *fakeWaitClock) Now() time.Time { c.mu.Lock(); defer c.mu.Unlock(); return c.now }
func (c *fakeWaitClock) After(d time.Duration) <-chan time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	t := &fakeWaitTimer{at: c.now.Add(d), ch: make(chan time.Time, 1)}
	if d <= 0 {
		t.fired = true
		t.ch <- c.now
	}
	c.timers = append(c.timers, t)
	return t.ch
}
func (c *fakeWaitClock) Advance(d time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.now = c.now.Add(d)
	for _, t := range c.timers {
		if !t.fired && !t.at.After(c.now) {
			t.fired = true
			t.ch <- c.now
		}
	}
}

type waitHarness struct {
	clock       *fakeWaitClock
	wake        chan struct{}
	interaction chan struct{}
	full, fast  chan struct{}
	done        chan bool
}

func startWait(t *testing.T) *waitHarness {
	t.Helper()
	h := &waitHarness{clock: &fakeWaitClock{now: time.Unix(1_800_000_000, 0)}, wake: make(chan struct{}, 1), interaction: make(chan struct{}, 1),
		full: make(chan struct{}, 64), fast: make(chan struct{}, 64), done: make(chan bool, 1)}
	w := reconcileWait{interval: 30 * time.Second, wake: h.wake, interaction: h.interaction,
		poll:            func(context.Context) { h.full <- struct{}{} },
		pollInteraction: func(context.Context) { h.fast <- struct{}{} },
		budget:          &interactionBudget{}, now: h.clock.Now, after: h.clock.After}
	// The reconciliation pass that just ended started 1 s ago.
	started := h.clock.Now().Add(-time.Second)
	go func() { h.done <- w.wait(t.Context(), started) }()
	return h
}

// settle lets the wait loop take what was sent and arm its timers.
func settle() { time.Sleep(20 * time.Millisecond) }

func (h *waitHarness) signal(ch chan struct{}) {
	select {
	case ch <- struct{}{}:
	default: // coalesced, as the runtime's one-slot channel does
	}
}
func (h *waitHarness) step(d time.Duration) { settle(); h.clock.Advance(d); settle() }
func count(ch chan struct{}) int {
	n := 0
	for {
		select {
		case <-ch:
			n++
		default:
			return n
		}
	}
}

// CT 144, 2026-10-30: the provider-status panel sends operation 24 as soon as operation 0's reply
// arrives, within the general 5 s gateway throttle. A participant's command is polled within the
// fast-path spacing, and the fast path does not run the full text sweep.
func TestInteractionCommandIsPolledWithinTheSpacingWithoutTheFullSweep(t *testing.T) {
	h := startWait(t)
	h.signal(h.interaction)
	h.step(interactionSpacing)
	if got := count(h.fast); got != 1 {
		t.Fatalf("fast polls = %d, want the command polled within %v", got, interactionSpacing)
	}
	h.signal(h.interaction)
	h.step(interactionSpacing)
	if got := count(h.fast); got != 1 {
		t.Fatalf("second command fast polls = %d, want 1 within the spacing", got)
	}
	if got := count(h.full); got != 0 {
		t.Fatalf("the interaction fast path ran the full sweep %d times", got)
	}
}

// A burst of signals inside the spacing gap coalesces into exactly one poll after the gap.
func TestInteractionBurstCoalescesIntoOnePoll(t *testing.T) {
	h := startWait(t)
	h.signal(h.interaction)
	settle() // polled at once: no poll came before it
	if got := count(h.fast); got != 1 {
		t.Fatalf("first command fast polls = %d, want 1", got)
	}
	// The burst starts inside the spacing gap that poll opened.
	for range 20 {
		h.signal(h.interaction)
		h.step(interactionSpacing / 20)
	}
	h.step(interactionSpacing)
	if got := count(h.fast); got != 1 {
		t.Fatalf("burst fast polls = %d, want 1", got)
	}
	h.step(10 * time.Second)
	if got := count(h.fast); got != 0 {
		t.Fatalf("a coalesced burst polled again later: %d", got)
	}
}

// A sustained flood falls back to the general throttle rate once the small burst allowance is used.
func TestInteractionFloodIsLimitedToTheThrottleRate(t *testing.T) {
	h := startWait(t)
	const flood = 20 * time.Second
	for elapsed := time.Duration(0); elapsed < flood; elapsed += interactionSpacing {
		h.signal(h.interaction)
		h.step(interactionSpacing)
	}
	limit := interactionBurst + int(flood/gatewayWakeThrottle) + 1
	if got := count(h.fast); got > limit || got < int(flood/gatewayWakeThrottle) {
		t.Fatalf("fast polls under a %v flood = %d, want between %d and %d", flood, got, int(flood/gatewayWakeThrottle), limit)
	}
}

// Other gateway hints still refresh text sources at most once per 5 s with the full sweep.
func TestGeneralGatewayWakeStaysThrottled(t *testing.T) {
	h := startWait(t)
	h.signal(h.wake)
	h.step(time.Second)
	if got := count(h.full); got != 0 {
		t.Fatalf("a general hint 2 s after the pass started polled %d times, want the 5 s throttle", got)
	}
	h.step(3 * time.Second)
	if got := count(h.full); got != 1 {
		t.Fatalf("general polls after the throttle = %d, want 1", got)
	}
}

// The interval still ends the wait, so full reconciliation stays the safety net.
func TestReconcileIntervalEndsTheWait(t *testing.T) {
	h := startWait(t)
	h.step(30 * time.Second)
	select {
	case again := <-h.done:
		if !again {
			t.Fatal("the interval ended the wait as a shutdown")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("the reconcile interval did not end the wait")
	}
}
