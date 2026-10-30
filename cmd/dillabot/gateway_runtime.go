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

type botGatewayRuntime struct {
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
	startedAt   uint64

	// pending holds the interaction groups messaged since the last fast poll, per installation
	// (guarded by pendingMu: the per-installation gateway goroutines write it).
	pendingMu          sync.Mutex
	pending            map[id.ID]map[id.ID]bool
	interactionPollers map[id.ID]func(context.Context, id.ID) error
}

func newBotGatewayRuntime(ctx context.Context, api *client.Client, loopback bool, log *slog.Logger) *botGatewayRuntime {
	return &botGatewayRuntime{startedAt: unixSecondsOrZero(time.Now()) * 1000, ctx: ctx, api: api, loopback: loopback, log: log, entries: map[id.ID]*botGatewayEntry{}, wake: make(chan struct{}, 1), interaction: make(chan struct{}, 1), pollers: map[id.ID]func(context.Context) error{}}
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

// PollInteractions syncs up to interactionGroupCap messaged interaction groups and dispatches
// their events, and reports how many it synced so the caller charges its budget per group. An
// installation with no fast path registered falls back to the general wake and its full sweep.
func (r *botGatewayRuntime) PollInteractions(ctx context.Context) int {
	type work struct{ installation, group id.ID }
	var batch []work
	r.pendingMu.Lock()
	total := 0
	for _, groups := range r.pending {
		total += len(groups)
	}
	if total > interactionGroupFallback {
		r.pending = nil
		r.pendingMu.Unlock()
		r.notify()
		return 0
	}
	for installation, groups := range r.pending {
		for group := range groups {
			if len(batch) == interactionGroupCap {
				break
			}
			batch = append(batch, work{installation, group})
			delete(groups, group)
		}
		if len(groups) == 0 {
			delete(r.pending, installation)
		}
	}
	more := len(r.pending) > 0
	r.pendingMu.Unlock()
	if more {
		select {
		case r.interaction <- struct{}{}:
		default:
		}
	}
	synced := 0
	for _, w := range batch {
		poll := r.interactionPollers[w.installation]
		if poll == nil {
			r.notify()
			continue
		}
		synced++
		if err := poll(ctx, w.group); err != nil && ctx.Err() == nil {
			r.log.Warn("bot interaction command intake deferred", "installation_id", w.installation.String())
			r.notify()
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
			delete(r.interactionPollers, installation)
		}
	}
	gateway, err := gatewayclient.New(gatewayclient.Config{Client: r.api, AllowLoopbackHTTP: r.loopback, ExpectedDeviceID: device, ExpectedUserID: user})
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
			delete(r.interactionPollers, installation)
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
		delete(r.interactionPollers, installation)
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
	for installation, poll := range r.pollers {
		if err := poll(ctx); err != nil && ctx.Err() == nil {
			r.log.Warn("bot text command intake deferred", "installation_id", installation.String())
		}
	}
}
