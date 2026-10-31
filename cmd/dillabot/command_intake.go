//go:build linux

package main

import (
	"context"

	"github.com/jonasthim/dilla/internal/bot/client"
	"github.com/jonasthim/dilla/internal/bot/service"
	"github.com/jonasthim/dilla/internal/id"
)

// holdingEventDrainer drains durable events while holding those of unrefreshed senders
// (service.HoldUnrefreshedSenders); *interactionEventRuntime implements it.
type holdingEventDrainer interface {
	DrainHolding(context.Context, map[id.ID]bool) (service.GroupEventPollResult, error)
}

// intakeTrust is the trust pass command intake runs (*service.SourceTrust implements it).
type intakeTrust interface {
	RefreshPendingLeaves(context.Context, *client.Session) (service.TrustRefresh, error)
}

// countSkipped reports how many events a drain acknowledged as undeliverable, as a count only, so
// the intake paths log skips without any event's delivery ID, sender or cause.
type countSkipped struct {
	holdingEventDrainer
	report func(int)
}

func (c countSkipped) DrainHolding(ctx context.Context, unrefreshed map[id.ID]bool) (service.GroupEventPollResult, error) {
	result, err := c.holdingEventDrainer.DrainHolding(ctx, unrefreshed)
	if n := len(result.Skipped); n > 0 {
		c.report(n)
	}
	return result, err
}

// refreshTrust runs the trust pass before Drain and fails closed. The trust pass is where a
// published revocation or key change is applied, so:
//   - a failure that is not scoped to one sender (reading the pending leaves, a server or API
//     failure, a native-core refusal or limit, group revalidation, the clock) ends the poll before
//     Drain, exactly as before: nothing is dispatched;
//   - a sender whose signed device-list history is stale is reported in Unrefreshed. Its new
//     messages stay held by the native core as pending leaves, and the caller holds its
//     already-queued events (DrainHolding). The queue is ordered: other senders' events ahead of
//     the held event are dispatched; the held event blocks the queue until its sender is
//     refreshed or the held-event age limit (service.HeldEventMaxPendingAge) drops it, never
//     dispatched.
func refreshTrust(ctx context.Context, trust intakeTrust, session *client.Session, report func(service.TrustRefresh)) (map[id.ID]bool, error) {
	refresh, err := trust.RefreshPendingLeaves(ctx, session)
	if err != nil {
		return nil, err
	}
	if len(refresh.Unrefreshed) != 0 {
		report(refresh)
	}
	return refresh.Unrefreshed, nil
}

// A gateway hint must ingest private ciphertext before dispatching durable events.
// Installation readiness and restore proofs remain on full reconciliation.
func newCommandIntakePoller(membership installationMembership, trust intakeTrust, session *client.Session, subscribe func(context.Context) error, events holdingEventDrainer, report func(service.TrustRefresh)) func(context.Context) error {
	return func(ctx context.Context) error {
		if _, err := membership.ReconcileOnce(ctx, session); err != nil {
			return err
		}
		unrefreshed, err := refreshTrust(ctx, trust, session, report)
		if err != nil {
			return err
		}
		if _, err := membership.ReconcileInteractionGroupsOnce(ctx, session); err != nil {
			return err
		}
		if err := subscribe(ctx); err != nil {
			return err
		}
		result, err := events.DrainHolding(ctx, unrefreshed)
		if err == nil && result.RateLimited != nil {
			return result.RateLimited
		}
		return err
	}
}

type interactionGroupSync interface {
	ReconcileInteractionGroupOnce(context.Context, *client.Session, id.ID) (service.MembershipResult, error)
}

// newInteractionIntakePoller is the fast path for a participant's message in one private
// interaction group: it ingests that group's ciphertext, refreshes trust and dispatches durable
// events. The trust pass is required: the native core holds a message from a leaf whose signed
// device list is pending (app_pending_history) until the pass revalidates it, so without it a
// command from a participant's newly listed device would wait for the full path. The pass fails
// closed (refreshTrust). The text-channel sweep and the other interaction groups stay on the
// throttled general wake and on reconciliation. Drain acknowledges an event only after its handled
// reply, as on every path.
func newInteractionIntakePoller(sync interactionGroupSync, trust intakeTrust, session *client.Session, events holdingEventDrainer, report func(service.TrustRefresh)) func(context.Context, id.ID) error {
	return func(ctx context.Context, group id.ID) error {
		if _, err := sync.ReconcileInteractionGroupOnce(client.WithInteractive(ctx), session, group); err != nil {
			return err
		}
		// Installation-wide work is background, but this fast-path turn must
		// not yield to the gateway hint it is currently consuming.
		ctx = client.WithoutBackgroundYield(ctx)
		unrefreshed, err := refreshTrust(ctx, trust, session, report)
		if err != nil {
			return err
		}
		result, err := events.DrainHolding(ctx, unrefreshed)
		if err == nil && result.RateLimited != nil {
			return result.RateLimited
		}
		return err
	}
}
