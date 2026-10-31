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
// another at that spacing; each group refills at two tokens per second. The global spacing and per-poll cap
// also bound a flood spread over many groups.
const (
	interactionSpacing = 250 * time.Millisecond
	interactionBurst   = 10
	interactionRefill  = time.Second / 2
)

// interactionBudget is one interaction group's token bucket for fast-path work. Each synced
// group spends its own token, so one member's flood does not slow another's commands, even in
// the same installation. It outlives one wait, so
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
	b.tokens += float64(now.Sub(b.at)) / float64(interactionRefill)
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
		if refill := time.Duration((1 - b.tokens) * float64(interactionRefill)); refill > d {
			d = refill
		}
	}
	return d
}

// spend charges tokens for a poll that began at now. Each group sync spends one token.
func (b *interactionBudget) spend(now time.Time, groups int) {
	b.refill(now)
	b.tokens -= float64(groups)
	b.last = now
}

// reconcileWait is what the service loop does between two reconciliation passes: it polls text
// sources when the gateway hints at new input and returns when the interval has passed, so the
// interval stays the safety net for a lost notification.
//
// A participant's message in a private interaction group (interaction) is a command waiting for
// an answer. It takes the fast path, pollInteraction, which reads only the messaged groups and
// dispatches their events; nextInteraction says when the groups' own interactionBudgets
// next allow it, which keeps a flood of messages from turning it into back-to-back work. Every
// other hint (wake) takes the full text sweep, poll, at most once per gatewayWakeThrottle.
type reconcileWait struct {
	interval        time.Duration
	resume          bool
	wake            <-chan struct{}
	interaction     <-chan struct{}
	poll            func(context.Context)
	nextInteraction func(time.Time) (time.Duration, bool)
	pollInteraction func(context.Context, time.Time) int
	now             func() time.Time
	after           func(time.Duration) <-chan time.Time
}

// wait returns true when the interval elapses or a yielded pass can resume,
// and false when ctx ends. started is when the previous pass began.
func (w reconcileWait) wait(ctx context.Context, started time.Time) bool {
	next := w.after(w.interval)
	resumeAt := started.Add(time.Second)
	var spacing <-chan time.Time
	if w.resume && w.now().Before(resumeAt) {
		spacing = w.after(resumeAt.Sub(w.now()))
	}
	var general, fast <-chan time.Time
	// arm (re)times the fast poll for the earliest group its budget allows; a new signal can
	// bring it forward (another community's command must not wait behind a flooded one).
	arm := func() {
		if d, ok := w.nextInteraction(w.now()); ok {
			fast = w.after(d)
		} else {
			fast = nil
		}
	}
	// A prior wait may have consumed the gateway hint before its interval fired.
	// Re-arm durable pending work when a sweep returns, including a yielded sweep.
	arm()
	for {
		// A yielded pass resumes after its pending interaction batch drains,
		// at least one second after the previous pass started.
		// Ineligible pending groups retain the existing spacing/flood budget.
		if w.resume && !w.now().Before(resumeAt) {
			if _, pending := w.nextInteraction(w.now()); !pending {
				return true
			}
		}
		select {
		case <-ctx.Done():
			return false
		case <-spacing:
			spacing = nil
		case <-next:
			if w.resume && w.now().Before(resumeAt) {
				next = w.after(resumeAt.Sub(w.now()))
				continue
			}
			return true
		case <-w.wake:
			if general == nil {
				general = w.after(gatewayWakeThrottle - w.now().Sub(started))
			}
		case <-w.interaction:
			arm()
		case <-general:
			general = nil
			w.poll(ctx)
			started = w.now()
		case <-fast:
			// Each group polls only with its own token in hand; global spacing and
			// interactionGroupCap bound work even when many groups have fresh allowances.
			if d, ok := w.nextInteraction(w.now()); ok && d <= 0 {
				w.pollInteraction(ctx, w.now())
			}
			arm()
		}
	}
}
