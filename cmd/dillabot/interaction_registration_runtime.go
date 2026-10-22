//go:build linux

package main

import (
	"context"
	"crypto/sha256"
	"errors"

	"github.com/jonasthim/dilla/internal/bot/protocol"
	"github.com/jonasthim/dilla/internal/bot/service"
	"github.com/jonasthim/dilla/internal/id"
)

type interactionRegistrationRequestFunc func(context.Context, service.InteractionRegistrationRequest) error

// interactionRegistrationEventHandler stages one durable kind-3 registration
// per member-join episode. Admission and the signed context still decide
// eligibility; the structural event only supplies stable candidate IDs.
func interactionRegistrationEventHandler(installation id.ID, register interactionRegistrationRequestFunc) service.StructuralEventHandler {
	return func(ctx context.Context, event protocol.Event) error {
		if event.Kind != protocol.EventMemberJoin {
			return nil
		}
		if installation.IsZero() || register == nil || len(event.Data) != 2 {
			return errors.New("invalid member-join interaction registration event")
		}
		user, userOK := event.Data[0].(id.ID)
		device, deviceOK := event.Data[1].(id.ID)
		if !userOK || !deviceOK || user.IsZero() || device.IsZero() || event.ID.IsZero() || event.CommunityID.IsZero() {
			return errors.New("member-join event lacks exact user, device, or event identifiers")
		}
		group := interactionRegistrationGroupID(installation, event.CommunityID, event.ID, user, device)
		err := register(ctx, service.InteractionRegistrationRequest{Group: group, ParticipantUser: user, ParticipantDevice: device})
		if errors.Is(err, service.ErrInteractionNotEligible) {
			return nil
		}
		return err
	}
}

func interactionRegistrationGroupID(installation, community, episode, user, device id.ID) id.ID {
	hash := sha256.New()
	_, _ = hash.Write([]byte("dilla bot interaction group v1\x00"))
	_, _ = hash.Write(installation[:])
	_, _ = hash.Write(community[:])
	_, _ = hash.Write(episode[:])
	_, _ = hash.Write(user[:])
	_, _ = hash.Write(device[:])
	digest := hash.Sum(nil)
	var group id.ID
	copy(group[:], digest[:len(group)])
	group[6] = (group[6] & 0x0f) | 0x50
	group[8] = (group[8] & 0x3f) | 0x80
	return group
}

func newInteractionRegistrationHandler(coordinator *service.InteractionRegistrationCoordinator, installation id.ID) (service.StructuralEventHandler, error) {
	if coordinator == nil || installation.IsZero() {
		return nil, errors.New("missing interaction registration coordinator")
	}
	return interactionRegistrationEventHandler(installation, func(ctx context.Context, req service.InteractionRegistrationRequest) error {
		_, err := coordinator.Register(ctx, req)
		return err
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
