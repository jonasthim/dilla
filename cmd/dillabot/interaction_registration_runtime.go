//go:build linux

package main

import (
	"context"
	"errors"

	"github.com/jonasthim/dilla/internal/bot/protocol"
	"github.com/jonasthim/dilla/internal/bot/service"
	"github.com/jonasthim/dilla/internal/id"
)

type interactionRegistrationStageFunc func(context.Context, id.ID, id.ID) error

// interactionRegistrationEventHandler stages one durable kind-3 registration
// per member-join episode. Admission and the signed context still decide
// eligibility; the structural event only supplies stable candidate IDs.
func interactionRegistrationEventHandler(installation id.ID, stage interactionRegistrationStageFunc) service.StructuralEventHandler {
	return func(ctx context.Context, event protocol.Event) error {
		if event.Kind != protocol.EventMemberJoin {
			return nil
		}
		if installation.IsZero() || stage == nil || len(event.Data) != 2 {
			return errors.New("invalid member-join interaction registration event")
		}
		user, userOK := event.Data[0].(id.ID)
		episode, episodeOK := event.Data[1].(id.ID)
		if !userOK || !episodeOK || user.IsZero() || episode.IsZero() || event.ID.IsZero() || event.CommunityID.IsZero() {
			return errors.New("member-join event lacks exact user, episode, or event identifiers")
		}
		return stage(ctx, user, episode)
	}
}

func newInteractionRegistrationHandler(coordinator *service.InteractionRegistrationCoordinator, installation id.ID) (service.StructuralEventHandler, error) {
	if coordinator == nil || installation.IsZero() {
		return nil, errors.New("missing interaction registration coordinator")
	}
	return interactionRegistrationEventHandler(installation, func(ctx context.Context, user, episode id.ID) error {
		return coordinator.QueueMemberJoin(ctx, user, episode)
	}), nil
}

func composeStructuralEventHandlers(handlers ...service.StructuralEventHandler) service.StructuralEventHandler {
	return func(ctx context.Context, event protocol.Event) error {
		for _, handler := range handlers {
			if handler == nil {
				continue
			}
			if err := handler(ctx, event); err != nil {
				return err
			}
		}
		return nil
	}
}
