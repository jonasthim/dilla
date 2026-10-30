//go:build linux

package main

import (
	"context"
	"io"
	"log/slog"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jonasthim/dilla/internal/auth"
	"github.com/jonasthim/dilla/internal/bot/client"
	"github.com/jonasthim/dilla/internal/bot/native"
	"github.com/jonasthim/dilla/internal/gateway"
	"github.com/jonasthim/dilla/internal/id"
	"github.com/jonasthim/dilla/internal/store"
)

type presenceTestStore struct{}

func (presenceTestStore) GroupsForDevice(context.Context, id.ID) ([]id.ID, error) { return nil, nil }
func (presenceTestStore) GetCursor(context.Context, id.ID, id.ID) (store.CursorRow, error) {
	return store.CursorRow{}, nil
}
func (presenceTestStore) CountKeyPackages(context.Context, id.ID, int64) (int64, error) {
	return 0, nil
}

type presenceTestAuth struct{ session auth.Session }

func (a presenceTestAuth) Resolve(context.Context, string) (auth.Session, error) {
	return a.session, nil
}
func (presenceTestAuth) RecordCapabilities(context.Context, []byte, uint64, uint64, uint64) error {
	return nil
}
func TestBotGatewayRuntimePublishesPresenceAndStopsOnRemoval(t *testing.T) {
	instance, device, user, installation := id.New(), id.New(), id.New(), id.New()
	gw := gateway.New(gateway.Options{InstanceID: instance, Generation: 1, WireVersions: []uint64{3}, E2EEVersions: []uint64{1}, MediaVersions: []uint64{1}, Store: presenceTestStore{}, Auth: presenceTestAuth{auth.Session{UserID: user, DeviceID: device, Scope: auth.ScopeEnrolled, TokenHash: make([]byte, 32)}}, TrustedOrigins: []string{"*"}, Log: slog.New(slog.NewTextHandler(io.Discard, nil))})
	server := httptest.NewServer(gw.Handler())
	defer server.Close()
	defer gw.Shutdown(context.Background())
	api, err := client.New(client.Config{BaseURL: server.URL, InstanceID: instance, AllowLoopbackHTTP: true})
	if err != nil {
		t.Fatal(err)
	}
	runtime := newBotGatewayRuntime(t.Context(), api, true, slog.New(slog.NewTextHandler(io.Discard, nil)))
	defer runtime.Close()
	if err := runtime.Ensure(installation, device, user, "session"); err != nil {
		t.Fatal(err)
	}
	select {
	case <-runtime.Wake():
	case <-time.After(3 * time.Second):
		t.Fatal("gateway did not wake durable polling on Ready")
	}
	deadline := time.Now().Add(2 * time.Second)
	for gw.PresenceStatus(user, 0) == 0 && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	if gw.PresenceStatus(user, 0) == 0 {
		t.Fatal("bot remained offline")
	}
	runtime.RetainOnly(nil)
	deadline = time.Now().Add(2 * time.Second)
	for gw.PresenceStatus(user, 0) != 0 && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	if gw.PresenceStatus(user, 0) != 0 {
		t.Fatal("removed installation retained gateway presence")
	}
}

type lateNotificationStore struct {
	presenceTestStore
	joined atomic.Bool
	group  id.ID
}

func (s *lateNotificationStore) GroupsForDevice(context.Context, id.ID) ([]id.ID, error) {
	if s.joined.Load() {
		return []id.ID{s.group}, nil
	}
	return nil, nil
}

func (s *lateNotificationStore) GroupResource(context.Context, id.ID) (gateway.GroupResource, error) {
	return gateway.GroupResource{Kind: 3}, nil
}
func (s *lateNotificationStore) ChannelCommunity(context.Context, id.ID) (*id.ID, error) {
	return nil, nil
}
func (s *lateNotificationStore) Enabled(context.Context, id.ID) (bool, error) {
	return true, nil
}

type privateNotificationSource struct{ group id.ID }

func (s privateNotificationSource) Groups(context.Context) ([]native.GroupInfo, error) {
	return nil, nil
}
func (s privateNotificationSource) InteractionGroups(context.Context) ([]native.InteractionGroupDescriptor, error) {
	return []native.InteractionGroupDescriptor{{Group: s.group, State: 2}}, nil
}

func TestPrivateGroupJoinedAfterReadyWakesCommandIntake(t *testing.T) {
	instance, device, user, installation, group := id.New(), id.New(), id.New(), id.New(), id.New()
	store := &lateNotificationStore{group: group}
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	gw := gateway.New(gateway.Options{InstanceID: instance, Generation: 1, WireVersions: []uint64{3}, E2EEVersions: []uint64{1}, MediaVersions: []uint64{1}, Store: store, ScopeResolver: store, CommunityCompatibility: store, Auth: presenceTestAuth{auth.Session{UserID: user, DeviceID: device, Scope: auth.ScopeEnrolled, TokenHash: make([]byte, 32)}}, TrustedOrigins: []string{"*"}, Log: log})
	server := httptest.NewServer(gw.Handler())
	defer server.Close()
	defer gw.Shutdown(context.Background())
	api, err := client.New(client.Config{BaseURL: server.URL, InstanceID: instance, AllowLoopbackHTTP: true})
	if err != nil {
		t.Fatal(err)
	}
	runtime := newBotGatewayRuntime(t.Context(), api, true, log)
	defer runtime.Close()
	if err := runtime.Ensure(installation, device, user, "session"); err != nil {
		t.Fatal(err)
	}
	select {
	case <-runtime.Wake():
	case <-time.After(3 * time.Second):
		t.Fatal("gateway did not become ready")
	}
	store.joined.Store(true)
	gw.SetGroupMembers(group, []id.ID{device})
	if err := runtime.SubscribeNativeGroups(t.Context(), installation, privateNotificationSource{group}); err != nil {
		t.Fatal(err)
	}
	// Bot uploads are already durably processed locally. Echoing its own reply
	// must not trigger another complete source sweep (and another reply wake).
	ownPayload, err := gateway.MessageCTPayload(1, 1, device, []byte("own reply"), make([]byte, 32), 1, nil)
	if err != nil {
		t.Fatal(err)
	}
	ownDeadline := time.NewTimer(200 * time.Millisecond)
	defer ownDeadline.Stop()
	ownTicker := time.NewTicker(10 * time.Millisecond)
	defer ownTicker.Stop()
ownEcho:
	for {
		gw.DeliverGroup(group, gateway.Frame{Op: gateway.OpMessageCT, GroupID: &group, Payload: ownPayload, Replay: true})
		select {
		case <-runtime.Wake():
			t.Fatal("own ciphertext echo woke command intake")
		case <-runtime.Interaction():
			t.Fatal("own ciphertext echo woke interaction intake")
		case <-ownDeadline.C:
			break ownEcho
		case <-ownTicker.C:
		}
	}
	payload, err := gateway.MessageCTPayload(1, 1, id.New(), []byte("ciphertext"), make([]byte, 32), 1, nil)
	if err != nil {
		t.Fatal(err)
	}
	// Sending Subscribe completes before the server necessarily consumes it.
	ticker := time.NewTicker(10 * time.Millisecond)
	defer ticker.Stop()
	timeout := time.NewTimer(3 * time.Second)
	defer timeout.Stop()
	for {
		gw.DeliverGroup(group, gateway.Frame{Op: gateway.OpMessageCT, GroupID: &group, Payload: payload, Replay: true})
		select {
		case <-runtime.Interaction():
			// A participant's message in a private interaction group is a command: it takes
			// the unthrottled interaction wake, not the general 5 s throttled one.
			select {
			case <-runtime.Wake():
				t.Fatal("an interaction-group message also took the throttled general wake")
			default:
			}
			return
		case <-runtime.Wake():
			t.Fatal("an interaction-group message took the throttled general wake")
		case <-ticker.C:
		case <-timeout.C:
			t.Fatal("new private group did not wake command intake")
		}
	}
}

// Interaction signals carry their installation and group. Repeated messages in one group coalesce
// into one narrow poll of that group; an installation without a fast-path poller (mid
// reconciliation) falls back to the throttled general wake.
func TestInteractionSignalsCoalescePerGroup(t *testing.T) {
	runtime := newBotGatewayRuntime(t.Context(), nil, true, slog.New(slog.NewTextHandler(io.Discard, nil)))
	installation, unpolled, a, b := id.New(), id.New(), id.New(), id.New()
	var polled []id.ID
	runtime.SetInteractionPoller(installation, func(_ context.Context, group id.ID) error { polled = append(polled, group); return nil })
	for range 10 {
		runtime.notifyInteraction(installation, a)
	}
	runtime.notifyInteraction(installation, b)
	select {
	case <-runtime.Interaction():
	default:
		t.Fatal("no interaction signal")
	}
	t0 := time.Unix(1_800_000_000, 0)
	runtime.PollInteractions(t.Context(), t0)
	inOrder := len(polled) == 2 && polled[0] == a && polled[1] == b
	reversed := len(polled) == 2 && polled[0] == b && polled[1] == a
	if !inOrder && !reversed {
		t.Fatalf("polled %v, want each messaged group once", polled)
	}
	if n := runtime.PollInteractions(t.Context(), t0.Add(time.Minute)); n != 0 || len(polled) != 2 {
		t.Fatalf("a drained signal polled again: %v (%d synced)", polled, n)
	}
	runtime.notifyInteraction(unpolled, a)
	runtime.PollInteractions(t.Context(), t0)
	select {
	case <-runtime.Wake():
	default:
		t.Fatal("an installation without a fast-path poller did not fall back to the general wake")
	}
}

// A removed installation leaves no fast-path state behind: RetainOnly forgets its pending groups and
// its budget. Drop (a manager's Restart) keeps the budget, so a restart cannot reset a flood's bound.
func TestRetainOnlyForgetsRemovedInstallationsInteractionState(t *testing.T) {
	runtime := newBotGatewayRuntime(t.Context(), nil, true, slog.New(slog.NewTextHandler(io.Discard, nil)))
	kept, removed := id.New(), id.New()
	t0 := time.Unix(1_800_000_000, 0)
	for _, installation := range []id.ID{kept, removed} {
		runtime.SetInteractionPoller(installation, func(context.Context, id.ID) error { return nil })
		runtime.notifyInteraction(installation, id.New())
	}
	runtime.PollInteractions(t.Context(), t0) // creates both budgets
	runtime.notifyInteraction(removed, id.New())
	runtime.notifyInteraction(kept, id.New())
	state := func(installation id.ID) (budget, pending bool) {
		runtime.pendingMu.Lock()
		defer runtime.pendingMu.Unlock()
		return runtime.budgets[installation] != nil, len(runtime.pending[installation]) > 0
	}
	runtime.RetainOnly([]id.ID{kept})
	if budget, pending := state(removed); budget || pending {
		t.Fatalf("removed installation kept budget=%v pending=%v", budget, pending)
	}
	if budget, pending := state(kept); !budget || !pending {
		t.Fatalf("retained installation lost budget=%v pending=%v", budget, pending)
	}
	runtime.Drop(kept)
	if budget, _ := state(kept); !budget {
		t.Fatal("Drop (restart) reset the installation's budget")
	}
}

func drainSignal(ch <-chan struct{}) bool {
	select {
	case <-ch:
		return true
	default:
		return false
	}
}

// One fast poll syncs at most interactionGroupCap groups; the rest stay pending, re-signalled for
// the next allowed poll, so a member writing into many groups cannot make one poll do O(N) syncs.
func TestInteractionPollSyncsAtMostTheCapAndRequeuesTheRest(t *testing.T) {
	runtime := newBotGatewayRuntime(t.Context(), nil, true, slog.New(slog.NewTextHandler(io.Discard, nil)))
	installation := id.New()
	seen := map[id.ID]int{}
	runtime.SetInteractionPoller(installation, func(_ context.Context, group id.ID) error { seen[group]++; return nil })
	const groups = interactionGroupCap + 2 // above the cap, at or below the fallback
	for range groups {
		runtime.notifyInteraction(installation, id.New())
	}
	drainSignal(runtime.Interaction())
	t0 := time.Unix(1_800_000_000, 0)
	if n := runtime.PollInteractions(t.Context(), t0); n != interactionGroupCap || len(seen) != interactionGroupCap {
		t.Fatalf("first poll synced %d groups (%d distinct), want the cap %d", n, len(seen), interactionGroupCap)
	}
	if !drainSignal(runtime.Interaction()) {
		t.Fatal("the requeued groups were not re-signalled for the next poll")
	}
	// The first poll was charged four groups against a burst of three: the installation's next
	// poll waits for its budget, then takes the rest.
	if n := runtime.PollInteractions(t.Context(), t0.Add(interactionSpacing)); n != 0 {
		t.Fatalf("the installation polled again with a spent budget (%d groups)", n)
	}
	drainSignal(runtime.Interaction())
	if n := runtime.PollInteractions(t.Context(), t0.Add(2*gatewayWakeThrottle)); n != groups-interactionGroupCap || len(seen) != groups {
		t.Fatalf("second poll synced %d, %d distinct in all; want the remaining %d", n, len(seen), groups-interactionGroupCap)
	}
	for group, n := range seen {
		if n != 1 {
			t.Fatalf("group %s synced %d times", group, n)
		}
	}
	if drainSignal(runtime.Interaction()) || drainSignal(runtime.Wake()) {
		t.Fatal("nothing should be left pending")
	}
}

// Past interactionGroupFallback pending groups, the fast path does no single-group syncs at all:
// it hands the work to the throttled general wake, whose one full sweep covers every group.
func TestManyPendingInteractionGroupsFallBackToOneThrottledSweep(t *testing.T) {
	runtime := newBotGatewayRuntime(t.Context(), nil, true, slog.New(slog.NewTextHandler(io.Discard, nil)))
	installation := id.New()
	synced := 0
	runtime.SetInteractionPoller(installation, func(context.Context, id.ID) error { synced++; return nil })
	for range 20 {
		runtime.notifyInteraction(installation, id.New())
	}
	drainSignal(runtime.Interaction())
	t0 := time.Unix(1_800_000_000, 0)
	if n := runtime.PollInteractions(t.Context(), t0); n != 0 || synced != 0 {
		t.Fatalf("20 pending groups caused %d single-group syncs, want 0 (fallback)", synced)
	}
	if !drainSignal(runtime.Wake()) {
		t.Fatal("20 pending groups did not fall back to the general wake")
	}
	if drainSignal(runtime.Interaction()) || runtime.PollInteractions(t.Context(), t0) != 0 {
		t.Fatal("the fallback left groups pending on the fast path")
	}
}

func TestInteractionRateLimitRequeuesForNextTick(t *testing.T) {
	runtime := newBotGatewayRuntime(t.Context(), nil, true, slog.New(slog.NewTextHandler(io.Discard, nil)))
	installation, group := id.New(), id.New()
	calls := 0
	retry := uint64(1000)
	runtime.SetInteractionPoller(installation, func(context.Context, id.ID) error {
		calls++
		if calls == 1 {
			return &client.APIError{Status: 429, Code: "E_RATE_LIMITED", Outcome: client.OutcomeDefinitive, RetryAfterMS: &retry}
		}
		return nil
	})
	runtime.notifyInteraction(installation, group)
	now := time.Unix(1800000000, 0)
	runtime.now = func() time.Time { return now }
	runtime.PollInteractions(t.Context(), now)
	if delay, pending := runtime.NextInteraction(now); !pending || delay < time.Second {
		t.Fatalf("pending=%v delay=%s", pending, delay)
	}
	runtime.PollInteractions(t.Context(), now.Add(500*time.Millisecond))
	if calls != 1 {
		t.Fatal("retried before Retry-After")
	}
	runtime.PollInteractions(t.Context(), now.Add(time.Second))
	if calls != 2 {
		t.Fatal("deferred command not resumed on the next tick")
	}
	if _, pending := runtime.NextInteraction(now.Add(time.Second)); pending {
		t.Fatal("delivered command still pending")
	}
}

func TestInteractionRateLimitStopsBatchAndDefersFromCompletion(t *testing.T) {
	runtime := newBotGatewayRuntime(t.Context(), nil, true, slog.New(slog.NewTextHandler(io.Discard, nil)))
	installation := id.New()
	now := time.Unix(1800000000, 0)
	runtime.now = func() time.Time { return now }
	retry := uint64(1000)
	calls := 0
	runtime.SetInteractionPoller(installation, func(context.Context, id.ID) error {
		calls++
		if calls == 1 {
			now = now.Add(30 * time.Second)
			return &client.APIError{Status: 429, Code: "E_RATE_LIMITED", Outcome: client.OutcomeDefinitive, RetryAfterMS: &retry}
		}
		return nil
	})
	for range 3 {
		runtime.notifyInteraction(installation, id.New())
	}
	runtime.PollInteractions(t.Context(), now)
	if calls != 1 {
		t.Fatalf("rate limit did not stop installation batch: %d calls", calls)
	}
	if delay, pending := runtime.NextInteraction(now); !pending || delay < time.Second {
		t.Fatalf("delay=%s pending=%v after 30-second HTTP retry", delay, pending)
	}
	runtime.PollInteractions(t.Context(), now.Add(time.Second))
	if calls != 4 {
		t.Fatalf("not all deferred groups resumed: %d calls", calls)
	}
}
