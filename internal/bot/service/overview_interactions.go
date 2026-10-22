package service

import (
	"context"
	"errors"

	"github.com/jonasthim/dilla/internal/bot/client"
	"github.com/jonasthim/dilla/internal/bot/protocol"
	"github.com/jonasthim/dilla/internal/cborx"
	"github.com/jonasthim/dilla/internal/id"
)

const overviewInteractionDataLimit = 128

type overviewActorAuthority interface {
	BotActorAuthority(context.Context, id.ID, id.ID) (client.ActorAuthority, bool, error)
}

// OverviewInteractions returns only the requesting actor's current community
// authority. The authenticated bot session resolves membership and role state
// afresh for every request; only owners and administrators may inspect it.
type OverviewInteractions struct {
	Authority   overviewActorAuthority
	CommunityID id.ID
}

func (h OverviewInteractions) Handlers() map[protocol.Operation]InteractionHandlerSpec {
	return map[protocol.Operation]InteractionHandlerSpec{
		protocol.OpOverviewGet: {Handle: h.get},
	}
}

func (h OverviewInteractions) get(ctx context.Context, actor InteractionActor, request protocol.Request) (InteractionResult, error) {
	if h.Authority == nil || h.CommunityID.IsZero() || request.CommunityID != h.CommunityID || actor.User.IsZero() || actor.Kind != 0 {
		return InteractionResult{}, errors.New("missing overview authority or context")
	}
	authority, present, err := h.Authority.BotActorAuthority(ctx, h.CommunityID, actor.User)
	if err != nil {
		return InteractionResult{}, err
	}
	if !present || (!authority.Owner && !authority.Administrator) {
		return InteractionResult{Status: interactionStatusForbidden}, nil
	}
	owner, admin := uint64(0), uint64(0)
	if authority.Owner {
		owner = 1
	}
	if authority.Administrator {
		admin = 1
	}
	data, err := cborx.Marshal([]any{uint64(1), actor.User, authority.EffectiveBits, owner, admin})
	if err != nil {
		return InteractionResult{}, err
	}
	if len(data) > overviewInteractionDataLimit {
		return InteractionResult{}, errors.New("overview interaction result exceeds size limit")
	}
	return InteractionResult{Status: 0, Data: data}, nil
}
