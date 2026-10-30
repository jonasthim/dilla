//go:build linux

package main

import (
	"context"
	"time"
)

// gatewayWakeThrottle spaces text-source refreshes that a general gateway hint (a welcome, an
// epoch change, a channel message) starts. Full reconciliation includes proof POSTs for every
// private group and stays on its own interval.
const gatewayWakeThrottle = 5 * time.Second

// interactionSpacing is the least time between two interaction fast-path polls: signals inside
// the gap coalesce into one poll after it. interactionBurst is how many fast polls may follow one
// another at that spacing; the allowance refills at one per gatewayWakeThrottle, so a sustained
// flood of participant messages is polled no faster than the general throttle.
const (
	interactionSpacing = 250 * time.Millisecond
	interactionBurst   = 3
)

// interactionBudget is a token bucket for interaction fast-path polls. It outlives one wait, so
// a flood cannot reset it by spanning a reconciliation pass.
type interactionBudget struct {
	tokens   float64
	at, last time.Time
	used     bool
}

func (b *interactionBudget) refill(now time.Time) {
	if !b.used {
		b.tokens, b.at, b.used = interactionBurst, now, true
		return
	}
	b.tokens += float64(now.Sub(b.at)) / float64(gatewayWakeThrottle)
	if b.tokens > interactionBurst {
		b.tokens = interactionBurst
	}
	b.at = now
}

// delay is how long the next fast poll must wait: the spacing since the last one, and while the
// allowance is spent, until a token has refilled.
func (b *interactionBudget) delay(now time.Time) time.Duration {
	b.refill(now)
	d := interactionSpacing - now.Sub(b.last)
	if b.tokens < 1 {
		if refill := time.Duration((1 - b.tokens) * float64(gatewayWakeThrottle)); refill > d {
			d = refill
		}
	}
	return d
}

func (b *interactionBudget) spend(now time.Time) {
	b.refill(now)
	b.tokens--
	b.last = now
}

// reconcileWait is what the service loop does between two reconciliation passes: it polls text
// sources when the gateway hints at new input and returns when the interval has passed, so the
// interval stays the safety net for a lost notification.
//
// A participant's message in a private interaction group (interaction) is a command waiting for
// an answer. It takes the fast path, pollInteraction, which reads only the messaged groups and
// dispatches their events; the bound in interactionBudget keeps a flood of messages from turning
// it into back-to-back work. Every other hint (wake) takes the full text sweep, poll, at most once
// per gatewayWakeThrottle.
type reconcileWait struct {
	interval        time.Duration
	wake            <-chan struct{}
	interaction     <-chan struct{}
	poll            func(context.Context)
	pollInteraction func(context.Context)
	budget          *interactionBudget
	now             func() time.Time
	after           func(time.Duration) <-chan time.Time
}

// wait returns true when the interval elapsed and false when ctx ended. started is when the
// previous reconciliation pass began.
func (w reconcileWait) wait(ctx context.Context, started time.Time) bool {
	next := w.after(w.interval)
	var general, fast <-chan time.Time
	for {
		select {
		case <-ctx.Done():
			return false
		case <-next:
			return true
		case <-w.wake:
			if general == nil {
				general = w.after(gatewayWakeThrottle - w.now().Sub(started))
			}
		case <-w.interaction:
			if fast == nil {
				fast = w.after(w.budget.delay(w.now()))
			}
		case <-general:
			general = nil
			w.poll(ctx)
			started = w.now()
		case <-fast:
			fast = nil
			// The allowance may have been read before a refill was due; re-check it.
			if d := w.budget.delay(w.now()); d > 0 {
				fast = w.after(d)
				continue
			}
			w.budget.spend(w.now())
			w.pollInteraction(ctx)
		}
	}
}
