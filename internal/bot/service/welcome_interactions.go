package service

import (
	"context"
	"errors"

	"github.com/jonasthim/dilla/internal/bot/community/welcome"
	"github.com/jonasthim/dilla/internal/bot/protocol"
	"github.com/jonasthim/dilla/internal/cborx"
	"github.com/jonasthim/dilla/internal/id"
)

// WelcomeInteractions previews a template in the encrypted Bot interaction
// group. The authenticated actor is supplied by InteractionDispatcher.
type WelcomeInteractions struct {
	Authority   AnnouncementInteractionAuthority
	CommunityID id.ID
}

func (h WelcomeInteractions) Handlers() map[protocol.Operation]InteractionHandlerSpec {
	return map[protocol.Operation]InteractionHandlerSpec{
		protocol.OpWelcomePreview: {RecomputeOnReplay: true, Handle: h.preview},
	}
}

func (h WelcomeInteractions) preview(ctx context.Context, actor InteractionActor, request protocol.Request) (InteractionResult, error) {
	if h.Authority == nil || h.CommunityID.IsZero() || actor.User.IsZero() {
		return InteractionResult{}, errors.New("missing welcome preview authority")
	}
	if request.CommunityID != h.CommunityID {
		return InteractionResult{Status: interactionStatusForbidden}, nil
	}
	allowed, err := h.Authority.CanManageCommunity(ctx, actor.User, h.CommunityID)
	if err != nil {
		return InteractionResult{}, err
	}
	if !allowed {
		return InteractionResult{Status: interactionStatusForbidden}, nil
	}
	if len(request.Args) != 1 {
		return InteractionResult{Status: interactionStatusUnavailable}, nil
	}
	template, ok := request.Args[0].(string)
	if !ok {
		return InteractionResult{Status: interactionStatusUnavailable}, nil
	}
	text, err := welcome.Preview(template, "member", "server", "channel")
	if err != nil {
		return InteractionResult{Status: interactionStatusUnavailable}, nil
	}
	data, err := cborx.Marshal([]any{uint64(1), text})
	if err != nil {
		return InteractionResult{}, err
	}
	return InteractionResult{Status: 0, Data: data}, nil
}
