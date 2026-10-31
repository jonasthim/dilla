//go:build linux

package main

import (
	"context"
	"sync"
	"time"

	"github.com/jonasthim/dilla/internal/bot/client"
	"github.com/jonasthim/dilla/internal/id"
)

const commandWorkerCap = 4

type commandJob struct {
	work       interactionWork
	ctx        context.Context
	cancel     context.CancelFunc
	poll       func(context.Context, id.ID) error
	background bool
}
type commandWorkers struct {
	ctx        context.Context
	cancel     context.CancelFunc
	jobs       chan commandJob
	finished   chan struct{}
	wg         sync.WaitGroup
	active     map[id.ID]context.CancelFunc // gateway pendingMu protects reservations
	background map[id.ID]bool
	retry      map[interactionWork]time.Time
}

// StartCommandWorkers starts bounded execution independently of reconciliation.
// One active job per installation preserves its cumulative durable journal cursor
// and therefore per-group ordering; independent installations use up to four slots.
func (r *botGatewayRuntime) StartCommandWorkers() {
	r.pendingMu.Lock()
	if r.commands != nil || r.commandsClosed {
		r.pendingMu.Unlock()
		return
	}
	ctx, cancel := context.WithCancel(r.ctx)
	pool := &commandWorkers{ctx: ctx, cancel: cancel, jobs: make(chan commandJob, commandWorkerCap), finished: make(chan struct{}, commandWorkerCap), active: make(map[id.ID]context.CancelFunc), background: make(map[id.ID]bool), retry: make(map[interactionWork]time.Time)}
	r.commands = pool
	pool.wg.Add(commandWorkerCap + 1)
	r.pendingMu.Unlock()
	for range commandWorkerCap {
		go r.commandWorker(pool)
	}
	go r.commandDriver(pool)
	r.signalCommands()
}
func (r *botGatewayRuntime) commandsRunning() bool {
	r.pendingMu.Lock()
	defer r.pendingMu.Unlock()
	return r.commands != nil
}
func (r *botGatewayRuntime) stopCommandWorkers() {
	r.pendingMu.Lock()
	r.commandsClosed = true
	pool := r.commands
	r.pendingMu.Unlock()
	if pool != nil {
		pool.cancel()
		pool.wg.Wait()
	}
}

func (r *botGatewayRuntime) commandDriver(pool *commandWorkers) {
	defer pool.wg.Done()
	defer close(pool.jobs)
	timer := time.NewTimer(time.Hour)
	defer timer.Stop()
	for {
		if pool.ctx.Err() != nil {
			return
		}
		jobs, delay, pending := r.commandBatch(pool, time.Now())
		for _, job := range jobs {
			select {
			case pool.jobs <- job:
			case <-pool.ctx.Done():
				job.cancel()
				return
			}
		}
		var wake <-chan time.Time
		if pending {
			if !timer.Stop() {
				select {
				case <-timer.C:
				default:
				}
			}
			timer.Reset(max(delay, time.Millisecond))
			wake = timer.C
		}
		select {
		case <-pool.ctx.Done():
			return
		case <-r.interaction:
		case <-pool.finished:
		case <-wake:
		}
	}
}

func (r *botGatewayRuntime) commandBatch(pool *commandWorkers, now time.Time) ([]commandJob, time.Duration, bool) {
	r.pendingMu.Lock()
	defer r.pendingMu.Unlock()
	var jobs []commandJob
	var next time.Duration
	pending := false
	remaining := r.pendingOrder[:0]
	for _, work := range r.pendingOrder {
		if !r.pending[work.installation][work.group] {
			continue
		}
		poll := r.interactionPollers[work.installation]
		if poll == nil || pool.active[work.installation] != nil || len(pool.active) >= commandWorkerCap {
			remaining = append(remaining, work)
			continue
		}
		delay := max(r.interactionDelayLocked(work.installation, work.group, now), pool.retry[work].Sub(now))
		if delay > 0 {
			remaining = append(remaining, work)
			if !pending || delay < next {
				next = delay
			}
			pending = true
			continue
		}
		background := r.backgroundPending[work]
		ctx := client.WithoutBackgroundYield(pool.ctx)
		if !background {
			ctx = client.WithInteractive(ctx)
		}
		ctx, cancel := context.WithCancel(ctx)
		pool.active[work.installation] = cancel
		pool.background[work.installation] = background
		r.budgetLocked(work.installation, work.group).spend(now, 1)
		delete(r.pending[work.installation], work.group)
		if len(r.pending[work.installation]) == 0 {
			delete(r.pending, work.installation)
		}
		delete(pool.retry, work)
		delete(r.backgroundPending, work)
		jobs = append(jobs, commandJob{work: work, ctx: ctx, cancel: cancel, poll: poll, background: background})
	}
	r.pendingOrder = remaining
	for _, job := range jobs {
		r.lastInteractionPoll[job.work.installation] = now
	}
	return jobs, next, pending
}

func (r *botGatewayRuntime) commandWorker(pool *commandWorkers) {
	defer pool.wg.Done()
	for {
		select {
		case <-pool.ctx.Done():
			return
		case job, ok := <-pool.jobs:
			if !ok {
				return
			}
			err := job.ctx.Err()
			if err == nil {
				err = job.poll(job.ctx, job.work.group)
			}
			cancelled := job.ctx.Err() != nil
			job.cancel()
			r.pendingMu.Lock()
			delete(pool.active, job.work.installation)
			delete(pool.background, job.work.installation)
			retry := err != nil && pool.ctx.Err() == nil && r.interactionPollers[job.work.installation] != nil
			if retry {
				delay := interactionRefill
				if cancelled {
					delay = 0
				}
				if refusal := client.RateLimitError(err); refusal != nil {
					delay = time.Second
					if refusal.RetryAfterMS != nil {
						delay = time.Duration(min(*refusal.RetryAfterMS, uint64(30000))) * time.Millisecond
					}
					delay = min(max(delay, interactionSpacing), 30*time.Second)
					if r.deferred == nil {
						r.deferred = make(map[id.ID]time.Time)
					}
					r.deferred[job.work.installation] = time.Now().Add(delay)
				}
				pool.retry[job.work] = time.Now().Add(delay)
				if job.background {
					r.queueBackgroundInteractionLocked(job.work.installation, job.work.group)
				} else {
					r.queueInteractionLocked(job.work.installation, job.work.group)
				}
			}
			r.pendingMu.Unlock()
			if retry {
				r.signalCommands()
			}
			select {
			case pool.finished <- struct{}{}:
			case <-pool.ctx.Done():
				return
			}
		}
	}
}
