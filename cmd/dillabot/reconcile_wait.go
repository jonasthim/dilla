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

// reconcileWait is what the service loop does between two reconciliation passes: it polls text
// sources when the gateway hints at new input and returns when the interval has passed, so the
// interval stays the safety net for a lost notification.
//
// A participant's message in a private interaction group (interaction) is a command waiting for
// an answer and is polled at once, also cutting short a general hint held by the throttle. The
// channel holds one signal, so a burst of commands coalesces into the next poll, which drains
// every pending event.
type reconcileWait struct {
	interval    time.Duration
	wake        <-chan struct{}
	interaction <-chan struct{}
	poll        func(context.Context)
	now         func() time.Time
	after       func(time.Duration) <-chan time.Time
}

// wait returns true when the interval elapsed and false when ctx ended. started is when the
// previous reconciliation pass began.
func (w reconcileWait) wait(ctx context.Context, started time.Time) bool {
	next := w.after(w.interval)
	for {
		select {
		case <-ctx.Done():
			return false
		case <-next:
			return true
		case <-w.interaction:
		case <-w.wake:
			if delay := gatewayWakeThrottle - w.now().Sub(started); delay > 0 {
				select {
				case <-ctx.Done():
					return false
				case <-w.after(delay):
				case <-w.interaction:
				}
			}
		}
		w.poll(ctx)
		started = w.now()
	}
}
