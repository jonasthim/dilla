//go:build linux

package main

import (
	"context"
	"errors"
	"log/slog"
	"sync"
	"time"

	"github.com/jonasthim/dilla/internal/bot/client"
	"github.com/jonasthim/dilla/internal/bot/gatewayclient"
	"github.com/jonasthim/dilla/internal/bot/native"
	"github.com/jonasthim/dilla/internal/bot/service"
	"github.com/jonasthim/dilla/internal/id"
)

type botGatewayEntry struct {
	mu           sync.Mutex
	token        string
	device, user id.ID
	cancel       context.CancelFunc
	done         chan struct{}
	client       *gatewayclient.Client
	// private is the installation's current private interaction groups (guarded by mu).
	private map[id.ID]bool
}

func (e *botGatewayEntry) setPrivate(groups map[id.ID]bool) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.private = groups
}

func (e *botGatewayEntry) isPrivate(group *id.ID) bool {
	if group == nil {
		return false
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.private[*group]
}

type interactionWork struct{ installation, group id.ID }

type botGatewayRuntime struct {
	now      func() time.Time
	ctx      context.Context
	api      *client.Client
	loopback bool
	log      *slog.Logger
	entries  map[id.ID]*botGatewayEntry
	wake     chan struct{}
	// interaction carries a participant's message in a private interaction group: a command
	// waiting for an answer, which reconcileWait polls without the general throttle.
	interaction chan struct{}
	pollers     map[id.ID]func(context.Context) error
	maintenance map[id.ID]backgroundMaintenance
	startedAt   uint64

	// pending holds the interaction groups messaged since the last fast poll, per installation
	// (guarded by pendingMu: the per-installation gateway goroutines write it).
	pendingMu           sync.Mutex
	pending             map[id.ID]map[id.ID]bool
	deferred            map[id.ID]time.Time
	idlePolls           map[id.ID]*service.InteractionPollSchedule
	budgets             map[id.ID]map[id.ID]*interactionBudget // per group, outliving reconcile passes
	pendingOrder        []interactionWork                      // FIFO: a noisy group rejoins behind existing work
	lastInteractionPoll time.Time
	interactionPollers  map[id.ID]func(context.Context, id.ID) error
}

func newBotGatewayRuntime(ctx context.Context, api *client.Client, loopback bool, log *slog.Logger) *botGatewayRuntime {
	return &botGatewayRuntime{now: time.Now, startedAt: unixSecondsOrZero(time.Now()) * 1000, ctx: client.WithoutBackgroundYield(ctx), api: api, loopback: loopback, log: log, entries: map[id.ID]*botGatewayEntry{}, wake: make(chan struct{}, 1), interaction: make(chan struct{}, 1), pollers: map[id.ID]func(context.Context) error{}}
}

// InteractionPollSchedule survives the short-lived reconciler built each tick.
func (r *botGatewayRuntime) InteractionPollSchedule(installation id.ID) *service.InteractionPollSchedule {
	if r.idlePolls == nil {
		r.idlePolls = map[id.ID]*service.InteractionPollSchedule{}
	}
	if r.idlePolls[installation] == nil {
		r.idlePolls[installation] = &service.InteractionPollSchedule{}
	}
	return r.idlePolls[installation]
}

func (r *botGatewayRuntime) Wake() <-chan struct{}        { return r.wake }
func (r *botGatewayRuntime) Interaction() <-chan struct{} { return r.interaction }
func (r *botGatewayRuntime) notify() {
	select {
	case r.wake <- struct{}{}:
	default:
	}
}
func (r *botGatewayRuntime) notifyInteraction(installation, group id.ID) {
	r.pendingMu.Lock()
	if r.pending == nil {
		r.pending = map[id.ID]map[id.ID]bool{}
	}
	if r.pending[installation] == nil {
		r.pending[installation] = map[id.ID]bool{}
	}
	if !r.pending[installation][group] {
		r.pendingOrder = append(r.pendingOrder, interactionWork{installation, group})
	}
	r.pending[installation][group] = true
	r.pendingMu.Unlock()
	select {
	case r.interaction <- struct{}{}:
	default:
	}
}

// SetInteractionPoller registers the installation's fast path for interaction-group messages;
// nil removes it while reconciliation rebuilds the installation.
func (r *botGatewayRuntime) SetInteractionPoller(installation id.ID, poll func(context.Context, id.ID) error) {
	r.pendingMu.Lock()
	defer r.pendingMu.Unlock()
	if r.interactionPollers == nil {
		r.interactionPollers = map[id.ID]func(context.Context, id.ID) error{}
	}
	if poll == nil {
		delete(r.interactionPollers, installation)
	} else {
		r.interactionPollers[installation] = poll
	}
}

// interactionGroupCap is the most interaction groups one fast poll syncs; the rest stay pending
// for the next poll the budget allows. Past interactionGroupFallback pending groups, the fast path
// syncs none and hands the work to the throttled general wake, whose one full sweep covers every
// group: a member writing into many groups cannot turn the fast path into N single-group syncs.
const (
	interactionGroupCap      = 4
	interactionGroupFallback = 2 * interactionGroupCap
)

// budgetLocked is the group's token bucket; pendingMu must be held. A flood in one
// interaction group does not spend any other group's allowance.
func (r *botGatewayRuntime) budgetLocked(installation, group id.ID) *interactionBudget {
	if r.budgets == nil {
		r.budgets = map[id.ID]map[id.ID]*interactionBudget{}
	}
	if r.budgets[installation] == nil {
		r.budgets[installation] = map[id.ID]*interactionBudget{}
	}
	b := r.budgets[installation][group]
	if b == nil {
		b = &interactionBudget{}
		r.budgets[installation][group] = b
	}
	return b
}

func (r *botGatewayRuntime) interactionDelayLocked(installation, group id.ID, now time.Time) time.Duration {
	return max(r.budgetLocked(installation, group).delay(now), r.deferred[installation].Sub(now), interactionSpacing-now.Sub(r.lastInteractionPoll))
}

// NextInteraction reports how long until the next fast poll may run for some group with
// messaged groups, and false when no group is pending.
func (r *botGatewayRuntime) NextInteraction(now time.Time) (time.Duration, bool) {
	r.pendingMu.Lock()
	defer r.pendingMu.Unlock()
	var next time.Duration
	found := false
	for installation, groups := range r.pending {
		if len(groups) == 0 {
			continue
		}
		for group := range groups {
			if d := r.interactionDelayLocked(installation, group, now); !found || d < next {
				next, found = d, true
			}
		}
	}
	return next, found
}

// backgroundYieldReady is checked on the service goroutine between requests.
// suspended is a prior fast path temporarily removed during a reconcile pass;
// that path is restored when local pacing defers the pass.
func (r *botGatewayRuntime) backgroundYieldReady(now time.Time, suspended id.ID) bool {
	r.pendingMu.Lock()
	defer r.pendingMu.Unlock()
	for installation, groups := range r.pending {
		if r.interactionPollers[installation] == nil && installation != suspended {
			continue
		}
		for group := range groups {
			if r.interactionDelayLocked(installation, group, now) <= 0 {
				return true
			}
		}
	}
	return false
}

// PollInteractions syncs up to interactionGroupCap groups in notification order.
// Ineligible groups keep their position while eligible work can pass them. A polled
// group with more messages rejoins at the tail, so floods cannot starve quieter groups.
// Past interactionGroupFallback pending groups per installation, or without a poller,
// work falls back to the throttled general sweep. HTTP refusal deferrals remain shared
// per installation because its device credentials share the server's rate limits.
func (r *botGatewayRuntime) PollInteractions(ctx context.Context, now time.Time) int {
	var batch []interactionWork
	fallback := false
	r.pendingMu.Lock()
	for installation, groups := range r.pending {
		if len(groups) > interactionGroupFallback {
			delete(r.pending, installation)
			fallback = true
		}
	}
	remaining := r.pendingOrder[:0]
	for _, w := range r.pendingOrder {
		groups := r.pending[w.installation]
		if !groups[w.group] {
			continue
		}
		if len(batch) == interactionGroupCap || r.interactionDelayLocked(w.installation, w.group, now) > 0 {
			remaining = append(remaining, w)
			continue
		}
		batch = append(batch, w)
		delete(groups, w.group)
		if len(groups) == 0 {
			delete(r.pending, w.installation)
		}
	}
	r.pendingOrder = remaining
	if len(batch) > 0 {
		r.lastInteractionPoll = now
	}
	more := len(r.pending) > 0
	r.pendingMu.Unlock()
	if fallback {
		r.notify()
	}
	if more {
		select {
		case r.interaction <- struct{}{}:
		default:
		}
	}
	synced := 0
	blocked := map[id.ID]bool{}
	for _, w := range batch {
		if blocked[w.installation] {
			r.notifyInteraction(w.installation, w.group)
			continue
		}
		poll := r.interactionPollers[w.installation]
		if poll == nil {
			r.notify()
			continue
		}
		r.pendingMu.Lock()
		r.budgetLocked(w.installation, w.group).spend(now, 1)
		r.pendingMu.Unlock()
		synced++
		if err := poll(ctx, w.group); err != nil && ctx.Err() == nil {
			if refusal := client.RateLimitError(err); refusal != nil {
				logBotRateLimit(r.log, w.installation, refusal)
				blocked[w.installation] = true
				completed := now
				if r.now != nil {
					completed = r.now()
				}
				r.pendingMu.Lock()
				if r.deferred == nil {
					r.deferred = map[id.ID]time.Time{}
				}
				delay := time.Second
				if refusal.RetryAfterMS != nil {
					delay = time.Duration(min(*refusal.RetryAfterMS, uint64((1<<63-1)/int64(time.Millisecond)))) * time.Millisecond
				}
				r.deferred[w.installation] = completed.Add(min(max(delay, interactionSpacing), 30*time.Second))
				r.pendingMu.Unlock()
				r.notifyInteraction(w.installation, w.group)
			} else {
				r.log.Warn("bot interaction command intake deferred", "installation_id", w.installation.String())
				r.notify()
			}
		}
	}
	return synced
}
func (r *botGatewayRuntime) Ensure(installation, device, user id.ID, token string) error {
	if e := r.entries[installation]; e != nil {
		select {
		case <-e.done:
			delete(r.entries, installation)
		default:
			if e.device == device && e.user == user {
				e.mu.Lock()
				e.token = token
				e.mu.Unlock()
				return nil
			}
			e.cancel()
			<-e.done
			delete(r.entries, installation)
			delete(r.pollers, installation)
			r.SetInteractionPoller(installation, nil)
			delete(r.maintenance, installation)
		}
	}
	gateway, err := gatewayclient.New(gatewayclient.Config{Client: r.api, AllowLoopbackHTTP: r.loopback, ExpectedDeviceID: device, ExpectedUserID: user, Logger: r.log.With("installation_id", installation.String())})
	if err != nil {
		return err
	}
	ctx, cancel := context.WithCancel(r.ctx)
	e := &botGatewayEntry{token: token, device: device, user: user, cancel: cancel, done: make(chan struct{}), client: gateway}
	r.entries[installation] = e
	go func() {
		defer close(e.done)
		finished := make(chan error, 1)
		go func() {
			finished <- gateway.Run(ctx, func(context.Context) (string, error) { e.mu.Lock(); defer e.mu.Unlock(); return e.token, nil })
		}()
		for delivery := range gateway.Events() {
			switch delivery.Frame.Op {
			case gatewayclient.OpReady:
				if ready := delivery.Frame.Ready; ready != nil && len(ready.Groups) > 0 {
					groups := make([]id.ID, 0, len(ready.Groups))
					for _, g := range ready.Groups {
						groups = append(groups, g.GroupID)
					}
					if err := gateway.Subscribe(ctx, groups); err != nil && ctx.Err() == nil {
						r.log.Warn("bot gateway group notifications unavailable", "installation_id", installation.String())
					}
				}
				r.notify()
			case gatewayclient.OpMessageCT:
				// Outgoing ciphertext is already processed by the native sender.
				// Its gateway echo must not start another full intake sweep.
				if message := delivery.Frame.MessageCT; message == nil || message.UploaderDevice != device {
					// A participant's message in a private interaction group is a command
					// waiting for an answer; it skips the general throttle.
					if e.isPrivate(delivery.Frame.GroupID) {
						r.notifyInteraction(installation, *delivery.Frame.GroupID)
					} else {
						r.notify()
					}
				}
			case gatewayclient.OpMessagePlain, gatewayclient.OpWelcome, gatewayclient.OpHandshake, gatewayclient.OpEpochChanged, gatewayclient.OpCommunityChanged, gatewayclient.OpVoiceState:
				r.notify()
			}
			// Gateway deliveries are wake-up hints only. MLS source cursors and bot
			// event acknowledgements advance independently after durable HTTP intake.
			if err := acknowledgeGatewayHint(delivery); err != nil && !errors.Is(err, gatewayclient.ErrStaleDelivery) && ctx.Err() == nil {
				r.log.Warn("bot gateway notification acknowledgement deferred", "installation_id", installation.String())
			}
		}
		if err := <-finished; err != nil && ctx.Err() == nil {
			r.log.Warn("bot gateway requires session reconciliation", "installation_id", installation.String())
			r.notify()
		}
	}()
	return nil
}
func (r *botGatewayRuntime) RetainOnly(active []id.ID) {
	keep := map[id.ID]bool{}
	for _, v := range active {
		keep[v] = true
	}
	for installation, e := range r.entries {
		if !keep[installation] {
			e.cancel()
			<-e.done
			delete(r.entries, installation)
			delete(r.pollers, installation)
			r.SetInteractionPoller(installation, nil)
			delete(r.maintenance, installation)
		}
	}
	// The removed installations' gateway goroutines have ended (<-e.done above), so nothing adds
	// to their interaction state any more: forget their pending groups and budgets. Drop (a
	// restart) deliberately keeps the budget, so a restart cannot reset a flood's bound.
	r.pendingMu.Lock()
	for installation := range r.pending {
		if !keep[installation] {
			delete(r.pending, installation)
		}
	}
	for installation := range r.budgets {
		if !keep[installation] {
			delete(r.budgets, installation)
			delete(r.deferred, installation)
		}
	}
	remaining := r.pendingOrder[:0]
	for _, w := range r.pendingOrder {
		if keep[w.installation] {
			remaining = append(remaining, w)
		}
	}
	r.pendingOrder = remaining
	r.pendingMu.Unlock()
	for installation := range r.interactionPollers {
		if !keep[installation] {
			r.SetInteractionPoller(installation, nil)
			delete(r.maintenance, installation)
		}
	}
	for installation := range r.maintenance {
		if !keep[installation] {
			delete(r.maintenance, installation)
		}
	}
	for installation := range r.idlePolls {
		if !keep[installation] {
			delete(r.idlePolls, installation)
		}
	}
}
func (r *botGatewayRuntime) Close() { r.RetainOnly(nil) }

// Drop closes one installation's gateway connection; the next Ensure opens a fresh one (Task 10c
// restart).
func (r *botGatewayRuntime) Drop(installation id.ID) {
	if e, ok := r.entries[installation]; ok {
		e.cancel()
		<-e.done
		delete(r.entries, installation)
		delete(r.pollers, installation)
		r.SetInteractionPoller(installation, nil)
		delete(r.maintenance, installation)
	}
}

func (r *botGatewayRuntime) SubscribeGroups(ctx context.Context, installation id.ID, groups []id.ID) {
	if e := r.entries[installation]; e != nil && len(groups) > 0 {
		// The initial Ready may precede MLS membership reconciliation. Subscribe the
		// current native groups too, so newly joined text channels wake the poller.
		_ = e.client.Subscribe(ctx, groups)
	}
}

type notificationGroupSource interface {
	Groups(context.Context) ([]native.GroupInfo, error)
	InteractionGroups(context.Context) ([]native.InteractionGroupDescriptor, error)
}

func (r *botGatewayRuntime) SubscribeNativeGroups(ctx context.Context, installation id.ID, source notificationGroupSource) error {
	groups, err := source.Groups(ctx)
	if err != nil {
		return err
	}
	private, err := source.InteractionGroups(ctx)
	if err != nil {
		return err
	}
	ids := make([]id.ID, 0, len(groups)+len(private))
	for _, group := range groups {
		if group.State == 2 && group.Kind == 0 {
			ids = append(ids, group.ID)
		}
	}
	// Generic Groups deliberately excludes kind 3; discover private interaction
	// groups through the native API that authenticates their installation binding.
	active := make(map[id.ID]bool, len(private))
	for _, group := range private {
		if group.State == 2 {
			ids = append(ids, group.Group)
			active[group.Group] = true
		}
	}
	if e := r.entries[installation]; e != nil {
		e.setPrivate(active)
	}
	r.SubscribeGroups(ctx, installation, ids)
	return nil
}

func acknowledgeGatewayHint(delivery gatewayclient.Delivery) error {
	if delivery.Frame.N == 0 {
		return nil
	}
	return delivery.Ack()
}

func (r *botGatewayRuntime) SetTextPoller(installation id.ID, poll func(context.Context) error) {
	if poll == nil {
		delete(r.pollers, installation)
	} else {
		r.pollers[installation] = poll
	}
}
func (r *botGatewayRuntime) PollText(ctx context.Context) {
	ctx = client.WithBackgroundYield(client.WithoutBackgroundYield(ctx), func() bool { return r.backgroundYieldReady(time.Now(), id.ID{}) })
	for installation, poll := range r.pollers {
		if err := poll(ctx); err != nil && ctx.Err() == nil {
			if errors.Is(err, client.ErrBackgroundYield) {
				r.log.Info("bot background pass yielded to a command", "stage", "text_sources")
				return
			}
			if refusal := client.RateLimitError(err); refusal != nil {
				logBotRateLimit(r.log, installation, refusal)
			} else {
				r.log.Warn("bot text command intake deferred", "installation_id", installation.String())
			}
		}
	}
}
