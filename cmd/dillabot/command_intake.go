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
// interaction group: it ingests that group's ciphertext and dispatches durable events, and nothing
// else. The text-channel sweep, trust and the other interaction groups stay on the throttled
// general wake and on reconciliation. Drain acknowledges an event only after its handled reply,
// as on every other path.
func newInteractionIntakePoller(sync interactionGroupSync, session *client.Session, events commandEventDrainer) func(context.Context, id.ID) error {
	return func(ctx context.Context, group id.ID) error {
		if _, err := sync.ReconcileInteractionGroupOnce(ctx, session, group); err != nil {
			return err
		}
		_, err := events.Drain(ctx)
		return err
	}
}
