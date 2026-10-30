package service

import (
	"context"
	"errors"
	"testing"

	"github.com/jonasthim/dilla/internal/bot/protocol"
)

// Only a definitive denial may let the event handler acknowledge a saved read response as
// undeliverable. protocol/10-community-bot.md: 0 ok, 1 invalid, 2 forbidden, 3 expired,
// 4 conflict, 5 unavailable, 6 busy, 7 not_found, 8 upgrade_required, 9 internal.
func TestReadReplayReauthorizationDeniesOnlyForbiddenAndKeepsEveryOtherStatusPending(t *testing.T) {
	for status := uint64(1); status <= 9; status++ {
		status := status
		t.Run(protocolStatusName(status), func(t *testing.T) {
			d, event, _ := interactionFixture(t, map[protocol.Operation]InteractionHandlerSpec{
				protocol.OpOverviewGet: {RecomputeOnReplay: true, Handle: func(context.Context, InteractionActor, protocol.Request) (InteractionResult, error) {
					return InteractionResult{Status: status}, nil
				}},
			})
			event.Body = ptrString(interactionBody(t, nil, interactionID(8), protocol.OpOverviewGet, nil, nil, nil))
			err := d.ReauthorizeReadReplay(context.Background(), event)
			if status == interactionStatusForbidden {
				if !errors.Is(err, ErrInteractionReadReplayNotAuthorized) || errors.Is(err, ErrInteractionReadReplayPending) {
					t.Fatalf("forbidden read replay = %v; want the definitive denial", err)
				}
				return
			}
			if errors.Is(err, ErrInteractionReadReplayNotAuthorized) || !errors.Is(err, ErrInteractionReadReplayPending) {
				t.Fatalf("status %d read replay = %v; a non-definitive status must stay pending", status, err)
			}
		})
	}
}

func TestReadReplayReauthorizationKeepsCancelledContextPending(t *testing.T) {
	t.Run("cancelled before dispatch", func(t *testing.T) {
		calls := 0
		d, event, _ := interactionFixture(t, map[protocol.Operation]InteractionHandlerSpec{
			protocol.OpOverviewGet: {RecomputeOnReplay: true, Handle: func(context.Context, InteractionActor, protocol.Request) (InteractionResult, error) {
				calls++
				return InteractionResult{Status: interactionStatusForbidden}, nil
			}},
		})
		event.Body = ptrString(interactionBody(t, nil, interactionID(8), protocol.OpOverviewGet, nil, nil, nil))
		ctx, cancel := context.WithCancel(context.Background())
		cancel()
		err := d.ReauthorizeReadReplay(ctx, event)
		if !errors.Is(err, context.Canceled) || errors.Is(err, ErrInteractionReadReplayNotAuthorized) || calls != 0 {
			t.Fatalf("cancelled read replay = %v calls=%d; want pending cancellation", err, calls)
		}
	})
	t.Run("cancelled while the handler denies", func(t *testing.T) {
		ctx, cancel := context.WithCancel(context.Background())
		defer cancel()
		d, event, _ := interactionFixture(t, map[protocol.Operation]InteractionHandlerSpec{
			protocol.OpOverviewGet: {RecomputeOnReplay: true, Handle: func(context.Context, InteractionActor, protocol.Request) (InteractionResult, error) {
				cancel() // e.g. an authority lookup cut short answers "forbidden"
				return InteractionResult{Status: interactionStatusForbidden}, nil
			}},
		})
		event.Body = ptrString(interactionBody(t, nil, interactionID(8), protocol.OpOverviewGet, nil, nil, nil))
		err := d.ReauthorizeReadReplay(ctx, event)
		if !errors.Is(err, context.Canceled) || errors.Is(err, ErrInteractionReadReplayNotAuthorized) {
			t.Fatalf("read replay denied under cancellation = %v; want pending cancellation", err)
		}
	})
}

func protocolStatusName(status uint64) string {
	return [...]string{"ok", "invalid", "forbidden", "expired", "conflict", "unavailable", "busy", "not_found", "upgrade_required", "internal"}[status]
}
