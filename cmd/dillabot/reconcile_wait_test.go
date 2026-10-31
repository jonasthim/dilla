//go:build linux

package main

import (
	"context"
	"io"
	"log/slog"
	"sync"
	"testing"
	"testing/synctest"
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
// per-group budgets, with fake pollers that count the groups each installation synced.
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

// A sustained flood stays bounded by the group's burst plus two tokens per second.
func TestInteractionFloodIsLimitedToTheGroupRefillRate(t *testing.T) {
	a, group := id.New(), id.New()
	h := startWait(t, a)
	const flood = 20 * time.Second
	for elapsed := time.Duration(0); elapsed < flood; elapsed += interactionSpacing {
		h.runtime.notifyInteraction(a, group)
		h.step(interactionSpacing)
	}
	limit := interactionBurst + int(flood/interactionRefill)
	if got := h.take(a); got > limit || got < int(flood/interactionRefill) {
		t.Fatalf("groups synced under a %v flood = %d, want between %d and %d", flood, got, int(flood/interactionRefill), limit)
	}
}

// New groups have independent allowances, but the poll spacing and batch cap still bound work.
func TestInteractionFloodAcrossManyGroupsStaysWithinSchedulingCap(t *testing.T) {
	a := id.New()
	h := startWait(t, a)
	const flood = 20 * time.Second
	for elapsed := time.Duration(0); elapsed < flood; elapsed += interactionSpacing {
		for range interactionGroupCap {
			h.runtime.notifyInteraction(a, id.New())
		}
		h.step(interactionSpacing)
	}
	limit := interactionGroupCap * (1 + int(flood/interactionSpacing))
	if got := h.take(a); got > limit || got == 0 {
		t.Fatalf("groups synced on the fast path under a %v many-group flood = %d, want 1..%d", flood, got, limit)
	}
}

// Every group has its own budget, including groups in the same installation.
func TestOneGroupsFloodDoesNotDelayAnother(t *testing.T) {
	for _, sameInstallation := range []bool{true, false} {
		t.Run(map[bool]string{true: "same installation", false: "different installation"}[sameInstallation], func(t *testing.T) {
			a, b, flooded, quiet := id.New(), id.New(), id.New(), id.New()
			if sameInstallation {
				b = a
			}
			h := startWait(t, a, b)
			for range 2 * interactionBurst {
				h.runtime.notifyInteraction(a, flooded)
				h.step(interactionSpacing)
			}
			quietPolled := make(chan struct{}, 1)
			h.runtime.SetInteractionPoller(b, func(_ context.Context, group id.ID) error {
				if group == quiet {
					quietPolled <- struct{}{}
				}
				return nil
			})
			h.runtime.notifyInteraction(a, flooded)
			h.runtime.notifyInteraction(b, quiet)
			h.step(interactionSpacing)
			if !drainSignal(quietPolled) {
				t.Fatalf("quiet command after flood was not polled within %v", interactionSpacing)
			}
		})
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

func TestReconcileWaitResumesPendingInteractionAfterYield(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		ctx, cancel := context.WithTimeout(t.Context(), time.Second)
		defer cancel()
		r := newBotGatewayRuntime(ctx, nil, false, slog.New(slog.NewTextHandler(io.Discard, nil)))
		installation, group := id.New(), id.New()
		calls := 0
		r.SetInteractionPoller(installation, func(context.Context, id.ID) error { calls++; cancel(); return nil })
		r.notifyInteraction(installation, group)
		<-r.Interaction() // an earlier wait consumed the hint before its reconcile timer fired
		w := reconcileWait{interval: 30 * time.Second, interaction: r.Interaction(), nextInteraction: r.NextInteraction,
			pollInteraction: r.PollInteractions, now: time.Now, after: time.After}
		start := time.Now()
		w.wait(ctx, start)
		if calls != 1 || time.Since(start) > 250*time.Millisecond {
			t.Fatalf("pending command after yield: calls=%d latency=%s", calls, time.Since(start))
		}
	})
}

func TestYieldedPassResumesWithoutReconcileInterval(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		ctx, cancel := context.WithTimeout(t.Context(), time.Minute)
		defer cancel()
		pending := true
		polls := 0
		start := time.Now()
		var polledAt time.Time
		w := reconcileWait{interval: 30 * time.Second, resume: true, now: time.Now, after: time.After,
			nextInteraction: func(time.Time) (time.Duration, bool) { return 0, pending },
			pollInteraction: func(context.Context, time.Time) int { pending = false; polls++; polledAt = time.Now(); return 1 }}
		if !w.wait(ctx, start) || polls != 1 || polledAt != start || time.Since(start) != time.Second {
			t.Fatalf("resume waited for interval: polls=%d delay=%s", polls, time.Since(start))
		}
	})
}

func TestYieldedPassResumeHasMinimumSpacing(t *testing.T) {
	for _, elapsed := range []time.Duration{0, 400 * time.Millisecond, 2 * time.Second} {
		t.Run(elapsed.String(), func(t *testing.T) {
			synctest.Test(t, func(t *testing.T) {
				now := time.Now()
				w := reconcileWait{interval: 30 * time.Second, resume: true, now: time.Now, after: time.After,
					nextInteraction: func(time.Time) (time.Duration, bool) { return 0, false }}
				if !w.wait(t.Context(), now.Add(-elapsed)) {
					t.Fatal("resume cancelled")
				}
				if waited := time.Since(now); waited != max(time.Second-elapsed, 0) {
					t.Fatalf("resume spacing=%s after %s pass, want %s", waited, elapsed, max(time.Second-elapsed, 0))
				}
			})
		})
	}
}

func TestInteractionBudgetBurstAndTwoTokensPerSecond(t *testing.T) {
	now := time.Unix(1800000000, 0)
	var budget interactionBudget
	budget.spend(now, 10)
	if delay := budget.delay(now); delay != 500*time.Millisecond {
		t.Fatalf("empty burst delay=%s, want 500ms", delay)
	}
	if delay := budget.delay(now.Add(250 * time.Millisecond)); delay != 250*time.Millisecond {
		t.Fatalf("partial refill delay=%s", delay)
	}
	if delay := budget.delay(now.Add(500 * time.Millisecond)); delay > 0 {
		t.Fatalf("refilled token delay=%s", delay)
	}
	budget.spend(now.Add(500*time.Millisecond), 1)
	if delay := budget.delay(now.Add(500 * time.Millisecond)); delay != 500*time.Millisecond {
		t.Fatalf("second token delay=%s", delay)
	}
	budget.refill(now.Add(time.Hour))
	if budget.tokens != 10 {
		t.Fatalf("idle burst=%v, want cap10", budget.tokens)
	}
}
