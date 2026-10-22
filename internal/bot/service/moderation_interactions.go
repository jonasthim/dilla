package service

import (
	"context"
	"errors"
	"math"

	"github.com/jonasthim/dilla/internal/bot/moderation"
	"github.com/jonasthim/dilla/internal/bot/protocol"
	"github.com/jonasthim/dilla/internal/cborx"
	"github.com/jonasthim/dilla/internal/id"
)

const (
	moderationInteractionPageSize  = 8
	moderationInteractionDataLimit = 2400
)

type moderationCaseListReader interface {
	List(context.Context, id.ID, []byte, uint64) ([]ModerationCase, []byte, error)
}

// ModerationInteractions exposes one bounded, freshly authorized encrypted
// case page through the typed interaction dispatcher. The current protocol's
// case-list argument has no cursor field, so only its initial page is served.
type ModerationInteractions struct {
	Reader      moderationCaseListReader
	CommunityID id.ID
}

func (h ModerationInteractions) Handlers() map[protocol.Operation]InteractionHandlerSpec {
	return map[protocol.Operation]InteractionHandlerSpec{
		protocol.OpModerationCases: {Handle: h.listCases},
	}
}

func (h ModerationInteractions) listCases(ctx context.Context, actor InteractionActor, request protocol.Request) (InteractionResult, error) {
	if h.Reader == nil || h.CommunityID.IsZero() || request.CommunityID != h.CommunityID || actor.User.IsZero() {
		return InteractionResult{}, errors.New("missing moderation interaction authority or context")
	}
	if len(request.Args) != 1 {
		return InteractionResult{Status: interactionStatusUnavailable}, nil
	}
	offset, ok := request.Args[0].(uint64)
	if !ok || offset != 0 {
		return InteractionResult{Status: interactionStatusUnavailable}, nil
	}
	rows, _, err := h.Reader.List(ctx, actor.User, nil, moderationInteractionPageSize)
	if err != nil {
		return InteractionResult{}, err
	}
	page := make([]any, 0, len(rows))
	var data []byte
	for _, row := range rows {
		if row.SourceRevision > math.MaxInt64 || row.ReceivedAt.Unix() <= 0 || !moderationActionAllowed(row.Action) || len(row.Excerpt) > moderation.ExcerptMaxBytes {
			return InteractionResult{}, ErrModerationCaseState
		}
		candidate := append(page, []any{row.Community, row.Group, row.Channel, row.Actor, row.Message,
			row.SourceRevision, row.Reason(), string(row.Action), row.Excerpt, uint64(row.ReceivedAt.Unix())})
		encoded, marshalErr := cborx.Marshal([]any{uint64(1), candidate})
		if marshalErr != nil {
			return InteractionResult{}, marshalErr
		}
		if len(encoded) > moderationInteractionDataLimit {
			break
		}
		page, data = candidate, encoded
	}
	if data == nil {
		data, err = cborx.Marshal([]any{uint64(1), []any{}})
		if err != nil {
			return InteractionResult{}, err
		}
	}
	return InteractionResult{Status: 0, Data: data}, nil
}

func moderationActionAllowed(action moderation.Action) bool {
	return action == moderation.ActionLog || action == moderation.ActionRemove || action == moderation.ActionWarn || action == moderation.ActionTimeout
}
