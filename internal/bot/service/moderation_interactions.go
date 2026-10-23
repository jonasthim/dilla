package service

import (
	"context"
	"errors"
	"math"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/jonasthim/dilla/internal/bot/moderation"
	"github.com/jonasthim/dilla/internal/bot/protocol"
	"github.com/jonasthim/dilla/internal/cborx"
	"github.com/jonasthim/dilla/internal/id"
)

const (
	moderationInteractionPageSize  = 8
	moderationInteractionDataLimit = 2400
	moderationInteractionCursorMax = 256
)

type moderationCaseListReader interface {
	List(context.Context, id.ID, []byte, uint64) ([]ModerationCase, []byte, error)
}

// AcceptedManualRemovalReceipt is returned only by the authenticated server
// lookup for an immutable, previously accepted moderator removal.
type AcceptedManualRemovalReceipt struct {
	ActionID, CommunityID, GroupID, ActorUserID, ActorDeviceID id.ID
	TargetSequence, Revision                                   uint64
	AcceptedAt                                                 int64
}

type manualRemovalReceiptLookup interface {
	AcceptedManualRemoval(context.Context, id.ID, id.ID) (AcceptedManualRemovalReceipt, error)
}

type manualEvidenceWriter interface {
	BoundTo(id.ID, id.ID) bool
	Save(context.Context, moderation.EvidenceInput) error
}

// ModerationInteractions exposes bounded, freshly authorized encrypted case
// pages through the typed interaction dispatcher.
type ModerationInteractions struct {
	Reader              moderationCaseListReader
	CommunityID         id.ID
	InstallationID      id.ID
	ManualRemovalLookup manualRemovalReceiptLookup
	EvidenceWriter      manualEvidenceWriter
}

func (h ModerationInteractions) Handlers() map[protocol.Operation]InteractionHandlerSpec {
	return map[protocol.Operation]InteractionHandlerSpec{
		protocol.OpModerationCases:    {RecomputeOnReplay: true, Handle: h.listCases},
		protocol.OpModerationEvidence: {Handle: h.saveManualEvidence},
	}
}

func (h ModerationInteractions) saveManualEvidence(ctx context.Context, actor InteractionActor, request protocol.Request) (InteractionResult, error) {
	if ctx == nil || h.CommunityID.IsZero() || request.CommunityID != h.CommunityID || actor.User.IsZero() || actor.Device.IsZero() ||
		h.InstallationID.IsZero() || h.ManualRemovalLookup == nil || h.EvidenceWriter == nil ||
		!h.EvidenceWriter.BoundTo(h.InstallationID, h.CommunityID) || len(request.Args) != 3 {
		return InteractionResult{Status: interactionStatusUnavailable}, nil
	}
	requestID, ok := request.Args[0].(id.ID)
	reason, reasonOK := request.Args[1].(string)
	excerpt, excerptOK := request.Args[2].(string)
	if !ok || requestID.IsZero() || !reasonOK || !excerptOK || !utf8.ValidString(reason) || len(reason) == 0 || len(reason) > moderation.MaxEvidenceReasonBytes ||
		strings.TrimSpace(reason) == "" || !utf8.ValidString(excerpt) || len(excerpt) > moderation.ExcerptMaxBytes {
		return InteractionResult{Status: interactionStatusUnavailable}, nil
	}
	receipt, err := h.ManualRemovalLookup.AcceptedManualRemoval(ctx, h.InstallationID, requestID)
	if err != nil || receipt.ActionID.IsZero() || receipt.CommunityID != h.CommunityID || receipt.GroupID.IsZero() ||
		receipt.ActorUserID != actor.User || receipt.ActorDeviceID != actor.Device || receipt.TargetSequence == 0 || receipt.TargetSequence > math.MaxInt64 ||
		receipt.Revision == 0 || receipt.Revision > math.MaxInt64 || receipt.AcceptedAt <= 0 || receipt.AcceptedAt > time.Now().Add(5*time.Minute).Unix() {
		return InteractionResult{Status: interactionStatusUnavailable}, nil
	}
	if err := h.EvidenceWriter.Save(ctx, moderation.EvidenceInput{
		OperationID: requestID, Action: moderation.ActionRemove, Rule: moderation.RuleManual,
		Reason: reason, Excerpt: excerpt, CreatedAt: time.Unix(receipt.AcceptedAt, 0).UTC(),
		AcceptedActionID: receipt.ActionID, AcceptedRevision: receipt.Revision,
		ActorUserID: receipt.ActorUserID, ActorDeviceID: receipt.ActorDeviceID, GroupID: receipt.GroupID, TargetSequence: receipt.TargetSequence,
	}); err != nil {
		return InteractionResult{Status: interactionStatusUnavailable}, nil
	}
	return InteractionResult{Status: 0}, nil
}

func (h ModerationInteractions) listCases(ctx context.Context, actor InteractionActor, request protocol.Request) (InteractionResult, error) {
	if h.Reader == nil || h.CommunityID.IsZero() || request.CommunityID != h.CommunityID || actor.User.IsZero() {
		return InteractionResult{}, errors.New("missing moderation interaction authority or context")
	}
	if len(request.Args) != 1 {
		return InteractionResult{Status: interactionStatusUnavailable}, nil
	}
	after, ok := decodeModerationInteractionCursor(request.Args[0], h.CommunityID)
	if !ok {
		return InteractionResult{Status: interactionStatusUnavailable}, nil
	}
	rows, next, err := h.Reader.List(ctx, actor.User, after, moderationInteractionPageSize)
	if err != nil {
		return InteractionResult{}, err
	}
	if len(next) > moderationCaseMaxCursor {
		return InteractionResult{}, ErrModerationCaseState
	}
	page := make([]any, 0, len(rows))
	var data []byte
	for i, row := range rows {
		if row.SourceRevision > math.MaxInt64 || row.ReceivedAt.Unix() <= 0 || !moderationActionAllowed(row.Action) || len(row.Excerpt) > moderation.ExcerptMaxBytes {
			return InteractionResult{}, ErrModerationCaseState
		}
		candidate := append(page, []any{row.Community, row.Group, row.Channel, row.Actor, row.Message,
			row.SourceRevision, row.Reason(), string(row.Action), row.Excerpt, uint64(row.ReceivedAt.Unix())})
		cursorAfter := next
		if i < len(rows)-1 {
			cursorAfter = moderationCaseKey(row.Message, row.SourceRevision)
		}
		var cursorToken []byte
		if len(cursorAfter) > 0 {
			cursorToken, ok = encodeModerationInteractionCursor(h.CommunityID, cursorAfter)
			if !ok {
				return InteractionResult{}, ErrModerationCaseState
			}
		}
		encoded, marshalErr := cborx.Marshal([]any{uint64(1), candidate, cursorToken})
		if marshalErr != nil {
			return InteractionResult{}, marshalErr
		}
		if len(encoded) > moderationInteractionDataLimit {
			if len(page) == 0 {
				return InteractionResult{}, ErrModerationCaseState
			}
			break
		}
		page, data = candidate, encoded
	}
	if data == nil {
		var cursorToken []byte
		if len(next) > 0 {
			cursorToken, ok = encodeModerationInteractionCursor(h.CommunityID, next)
			if !ok {
				return InteractionResult{}, ErrModerationCaseState
			}
		}
		data, err = cborx.Marshal([]any{uint64(1), []any{}, cursorToken})
		if err != nil {
			return InteractionResult{}, err
		}
	}
	return InteractionResult{Status: 0, Data: data}, nil
}

func encodeModerationInteractionCursor(community id.ID, after []byte) ([]byte, bool) {
	if community.IsZero() || len(after) == 0 || len(after) > moderationCaseMaxCursor {
		return nil, false
	}
	cursor, err := cborx.Marshal([]any{uint64(1), community[:], after})
	return cursor, err == nil && len(cursor) <= moderationInteractionCursorMax
}

func decodeModerationInteractionCursor(value any, community id.ID) ([]byte, bool) {
	if value == nil {
		return nil, true
	}
	cursor, ok := value.([]byte)
	if !ok || len(cursor) == 0 || len(cursor) > moderationInteractionCursorMax || cborx.CheckDeterministic(cursor) != nil {
		return nil, false
	}
	var fields []any
	if cborx.Unmarshal(cursor, &fields) != nil || len(fields) != 3 || fields[0] != uint64(1) {
		return nil, false
	}
	boundCommunityBytes, communityOK := fields[1].([]byte)
	after, afterOK := fields[2].([]byte)
	if !communityOK || len(boundCommunityBytes) != len(community) || !afterOK || len(after) == 0 || len(after) > moderationCaseMaxCursor {
		return nil, false
	}
	var boundCommunity id.ID
	copy(boundCommunity[:], boundCommunityBytes)
	if boundCommunity != community {
		return nil, false
	}
	return append([]byte(nil), after...), true
}

func moderationActionAllowed(action moderation.Action) bool {
	return action == moderation.ActionLog || action == moderation.ActionRemove || action == moderation.ActionWarn || action == moderation.ActionTimeout
}
