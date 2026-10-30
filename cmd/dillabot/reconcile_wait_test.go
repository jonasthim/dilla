//go:build linux

package main

import (
	"context"
	"io"
	"log/slog"
	"sync"
	"testing"
	"time"

	"github.com/jonasthim/dilla/internal/id"
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

// waitHarness runs reconcileWait against the real gateway runtime's interaction queue and
// per-installation budgets, with fake pollers that count the groups each installation synced.
type waitHarness struct {
	clock   *fakeWaitClock
	runtime *botGatewayRuntime
	wake    chan struct{}
	full    chan struct{}
	mu      sync.Mutex
	synced  map[id.ID]int
	done    chan bool
}

func startWait(t *testing.T, installations ...id.ID) *waitHarness {
	t.Helper()
	h := &waitHarness{clock: &fakeWaitClock{now: time.Unix(1_800_000_000, 0)}, wake: make(chan struct{}, 1),
		full: make(chan struct{}, 64), synced: map[id.ID]int{}, done: make(chan bool, 1)}
	h.runtime = newBotGatewayRuntime(t.Context(), nil, true, slog.New(slog.NewTextHandler(io.Discard, nil)))
	for _, installation := range installations {
		h.runtime.SetInteractionPoller(installation, func(context.Context, id.ID) error {
			h.mu.Lock()
			defer h.mu.Unlock()
			h.synced[installation]++
			return nil
		})
	}
	// The general wake is the test's own channel, so the runtime's fallback signals are counted
	// separately (fallbacks) instead of starting the full sweep here.
	w := reconcileWait{interval: 30 * time.Second, wake: h.wake, interaction: h.runtime.Interaction(),
		poll:            func(context.Context) { h.full <- struct{}{} },
		nextInteraction: h.runtime.NextInteraction, pollInteraction: h.runtime.PollInteractions,
		now: h.clock.Now, after: h.clock.After}
	// The reconciliation pass that just ended started 1 s ago.
	started := h.clock.Now().Add(-time.Second)
	go func() { h.done <- w.wait(t.Context(), started) }()
	return h
}

// settle lets the wait loop take what was sent and arm its timers.
func settle() { time.Sleep(20 * time.Millisecond) }

func (h *waitHarness) step(d time.Duration) { settle(); h.clock.Advance(d); settle() }

// take returns and resets the groups the installation synced since the last call.
func (h *waitHarness) take(installation id.ID) int {
	h.mu.Lock()
	defer h.mu.Unlock()
	n := h.synced[installation]
	h.synced[installation] = 0
	return n
}

func count(ch <-chan struct{}) int {
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
	a, group := id.New(), id.New()
	h := startWait(t, a)
	h.runtime.notifyInteraction(a, group)
	h.step(interactionSpacing)
	if got := h.take(a); got != 1 {
		t.Fatalf("groups synced = %d, want the command polled within %v", got, interactionSpacing)
	}
	h.runtime.notifyInteraction(a, group)
	h.step(interactionSpacing)
	if got := h.take(a); got != 1 {
		t.Fatalf("second command groups synced = %d, want 1 within the spacing", got)
	}
	if got := count(h.full); got != 0 {
		t.Fatalf("the interaction fast path ran the full sweep %d times", got)
	}
}

// A burst of signals inside the spacing gap coalesces into exactly one poll after the gap.
func TestInteractionBurstCoalescesIntoOnePoll(t *testing.T) {
	a, group := id.New(), id.New()
	h := startWait(t, a)
	h.runtime.notifyInteraction(a, group)
	settle() // polled at once: no poll came before it
	if got := h.take(a); got != 1 {
		t.Fatalf("first command groups synced = %d, want 1", got)
	}
	// The burst starts inside the spacing gap that poll opened.
	for range 20 {
		h.runtime.notifyInteraction(a, group)
		h.step(interactionSpacing / 20)
	}
	h.step(interactionSpacing)
	if got := h.take(a); got != 1 {
		t.Fatalf("burst groups synced = %d, want 1", got)
	}
	h.step(10 * time.Second)
	if got := h.take(a); got != 0 {
		t.Fatalf("a coalesced burst polled again later: %d", got)
	}
}

// A sustained flood in one group falls back to the general throttle rate once the burst is used.
func TestInteractionFloodIsLimitedToTheThrottleRate(t *testing.T) {
	a, group := id.New(), id.New()
	h := startWait(t, a)
	const flood = 20 * time.Second
	for elapsed := time.Duration(0); elapsed < flood; elapsed += interactionSpacing {
		h.runtime.notifyInteraction(a, group)
		h.step(interactionSpacing)
	}
	limit := interactionBurst + int(flood/gatewayWakeThrottle) + 1
	if got := h.take(a); got > limit || got < int(flood/gatewayWakeThrottle) {
		t.Fatalf("groups synced under a %v flood = %d, want between %d and %d", flood, got, int(flood/gatewayWakeThrottle), limit)
	}
}

// The budget is charged per group synced, not per poll: a flood across many groups syncs groups
// no faster than the throttle rate after the burst, and what does not fit falls back to the
// throttled general wake.
func TestInteractionFloodAcrossManyGroupsIsChargedPerGroup(t *testing.T) {
	a := id.New()
	h := startWait(t, a)
	const flood = 20 * time.Second
	for elapsed := time.Duration(0); elapsed < flood; elapsed += interactionSpacing {
		for range interactionGroupCap {
			h.runtime.notifyInteraction(a, id.New())
		}
		h.step(interactionSpacing)
	}
	// The first poll may overdraw the burst by at most one cap; after that, one group per refill.
	limit := interactionBurst + interactionGroupCap + int(flood/gatewayWakeThrottle)
	if got := h.take(a); got > limit {
		t.Fatalf("groups synced on the fast path under a %v many-group flood = %d, want at most %d", flood, got, limit)
	}
}

// Each installation has its own budget: a flood that spends one community's allowance does not
// delay another community's command.
func TestOneInstallationsFloodDoesNotDelayAnother(t *testing.T) {
	a, b := id.New(), id.New()
	h := startWait(t, a, b)
	for range 6 {
		for range interactionGroupCap {
			h.runtime.notifyInteraction(a, id.New())
		}
		h.step(interactionSpacing)
	}
	h.take(a)
	// a's flood has spent its allowance: its next command waits for a refill.
	h.runtime.notifyInteraction(a, id.New())
	settle()
	if d, ok := h.runtime.NextInteraction(h.clock.Now()); !ok || d <= interactionSpacing {
		t.Fatalf("a's next poll in %v (pending %v), want its spent budget to hold it back", d, ok)
	}
	h.runtime.notifyInteraction(b, id.New())
	h.step(interactionSpacing)
	if got := h.take(b); got != 1 {
		t.Fatalf("b's command after a's flood synced %d groups within %v, want 1", got, interactionSpacing)
	}
}

// Other gateway hints still refresh text sources at most once per 5 s with the full sweep.
func TestGeneralGatewayWakeStaysThrottled(t *testing.T) {
	h := startWait(t)
	h.wake <- struct{}{}
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
