// Package clock is the one seam between dillad and real time. Every package
// that sleeps, expires or schedules takes a Clock, so a test advances time
// instead of waiting for it.
package clock

import (
	"sync"
	"time"
)

// Timer is what a Clock hands back. It is an interface, not *time.Timer,
// because since Go 1.23 a time.Timer carries an unexported initTimer field and
// both Stop and Reset PANIC on a hand-built value
// (/home/thim/.local/go/src/time/sleep.go:61-64, 85-90, 138-144:
// `panic("time: Stop called on uninitialized Timer")`). A fake therefore cannot
// return a *time.Timer at all, and every idiomatic caller writes
// `t := clk.NewTimer(d); defer t.Stop()`. Deviation ID8.
type Timer interface {
	C() <-chan time.Time
	Stop() bool
	Reset(time.Duration) bool
}

// Clock is what dillad knows about time.
type Clock interface {
	Now() time.Time
	Since(time.Time) time.Duration
	NewTimer(time.Duration) Timer
	Sleep(time.Duration)
}

type systemClock struct{}

func (systemClock) Now() time.Time                  { return time.Now() }
func (systemClock) Since(t time.Time) time.Duration { return time.Since(t) }
func (systemClock) NewTimer(d time.Duration) Timer  { return &realTimer{t: time.NewTimer(d)} }
func (systemClock) Sleep(d time.Duration)           { time.Sleep(d) }

// System returns the wall clock.
func System() Clock { return systemClock{} }

// realTimer adapts *time.Timer to Timer.
type realTimer struct{ t *time.Timer }

func (r *realTimer) C() <-chan time.Time        { return r.t.C }
func (r *realTimer) Stop() bool                 { return r.t.Stop() }
func (r *realTimer) Reset(d time.Duration) bool { return r.t.Reset(d) }

type fakeTimer struct {
	f       *Fake
	at      time.Time
	c       chan time.Time
	stopped bool
}

func (t *fakeTimer) C() <-chan time.Time { return t.c }

// Stop removes the timer from its Fake. It reports whether the timer was still
// pending, exactly as time.Timer.Stop does, and it is safe to call twice.
func (t *fakeTimer) Stop() bool {
	t.f.mu.Lock()
	defer t.f.mu.Unlock()
	if t.stopped {
		return false
	}
	t.stopped = true
	for i, other := range t.f.timers {
		if other == t {
			t.f.timers = append(t.f.timers[:i], t.f.timers[i+1:]...)
			return true
		}
	}
	return false
}

// Reset re-arms the timer d from the Fake's current time.
func (t *fakeTimer) Reset(d time.Duration) bool {
	t.f.mu.Lock()
	defer t.f.mu.Unlock()
	was := false
	for _, other := range t.f.timers {
		if other == t {
			was = true
		}
	}
	t.at = t.f.now.Add(d)
	if !was {
		t.f.timers = append(t.f.timers, t)
	}
	t.stopped = false
	return was
}

// Fake is a clock a test drives by hand. It is safe for concurrent use.
type Fake struct {
	mu     sync.Mutex
	now    time.Time
	timers []*fakeTimer
}

// NewFake returns a Fake reading t.
func NewFake(t time.Time) *Fake { return &Fake{now: t} }

// Now returns the current fake time.
func (f *Fake) Now() time.Time {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.now
}

// Since returns the fake elapsed time.
func (f *Fake) Since(t time.Time) time.Duration { return f.Now().Sub(t) }

// NewTimer returns a timer that fires when the fake clock passes now+d. The
// channel is buffered, so Advance never blocks on an unread timer.
func (f *Fake) NewTimer(d time.Duration) Timer {
	f.mu.Lock()
	defer f.mu.Unlock()
	t := &fakeTimer{f: f, at: f.now.Add(d), c: make(chan time.Time, 1)}
	f.timers = append(f.timers, t)
	return t
}

// Sleep advances the fake clock rather than blocking: a fake clock has no other
// source of progress, so a blocking Sleep would deadlock every test that used it.
func (f *Fake) Sleep(d time.Duration) { f.Advance(d) }

// Advance moves the clock forward and fires every timer it passes.
func (f *Fake) Advance(d time.Duration) {
	f.mu.Lock()
	f.now = f.now.Add(d)
	now := f.now
	due := f.timers[:0]
	var fire []*fakeTimer
	for _, t := range f.timers {
		if !t.at.After(now) {
			t.stopped = true // a fired timer is no longer pending, as Stop reports
			fire = append(fire, t)
			continue
		}
		due = append(due, t)
	}
	f.timers = due
	f.mu.Unlock()
	for _, t := range fire {
		select {
		case t.c <- now:
		default:
		}
	}
}

var _ Clock = (*Fake)(nil)
