//go:build linux

package main

import (
	"context"

	"github.com/jonasthim/dilla/internal/bot/client"
	"github.com/jonasthim/dilla/internal/bot/service"
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
