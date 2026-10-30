//go:build linux

package main

import (
	"context"

	"github.com/jonasthim/dilla/internal/bot/client"
	"github.com/jonasthim/dilla/internal/bot/service"
	"github.com/jonasthim/dilla/internal/id"
)

type commandEventDrainer interface {
	Drain(context.Context) (service.GroupEventPollResult, error)
}

// A gateway hint must ingest private ciphertext before dispatching durable events.
// Installation readiness and restore proofs remain on full reconciliation.
func newCommandIntakePoller(membership installationMembership, trust installationTrust, session *client.Session, subscribe func(context.Context) error, events commandEventDrainer) func(context.Context) error {
	return func(ctx context.Context) error {
		if _, err := membership.ReconcileOnce(ctx, session); err != nil {
			return err
		}
		if _, err := trust.TrustPendingLeaves(ctx, session); err != nil {
			return err
		}
		if _, err := membership.ReconcileInteractionGroupsOnce(ctx, session); err != nil {
			return err
		}
		if err := subscribe(ctx); err != nil {
			return err
		}
		_, err := events.Drain(ctx)
		return err
	}
}

type interactionGroupSync interface {
	ReconcileInteractionGroupOnce(context.Context, *client.Session, id.ID) (service.MembershipResult, error)
}

// newInteractionIntakePoller is the fast path for a participant's message in one private
// interaction group: it ingests that group's ciphertext, refreshes trust and dispatches durable
// events. The trust pass is required: the native core holds a message from a leaf whose signed
// device list is pending (app_pending_history) until TrustPendingLeaves revalidates it, so without
// it a command from a participant's newly listed device would wait for the full path. The
// text-channel sweep and the other interaction groups stay on the throttled general wake and on
// reconciliation. Drain acknowledges an event only after its handled reply, as on every path.
func newInteractionIntakePoller(sync interactionGroupSync, trust installationTrust, session *client.Session, events commandEventDrainer) func(context.Context, id.ID) error {
	return func(ctx context.Context, group id.ID) error {
		if _, err := sync.ReconcileInteractionGroupOnce(ctx, session, group); err != nil {
			return err
		}
		if _, err := trust.TrustPendingLeaves(ctx, session); err != nil {
			return err
		}
		_, err := events.Drain(ctx)
		return err
	}
}
