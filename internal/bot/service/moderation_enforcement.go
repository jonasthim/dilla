package service

import (
	"context"
	"crypto/sha256"
	"errors"
	"math"
	"time"

	"github.com/jonasthim/dilla/internal/bot/client"
	"github.com/jonasthim/dilla/internal/bot/moderation"
	"github.com/jonasthim/dilla/internal/bot/moderation/operationid"
	"github.com/jonasthim/dilla/internal/bot/native"
	"github.com/jonasthim/dilla/internal/id"
)

var (
	ErrModerationActionUnsupported = errors.New("moderation action is unsupported by this enforcement adapter")
	ErrModerationActionSource      = errors.New("moderation action lacks an authoritative bound source")
	// ErrModerationActionRefused is a definitive server-side refusal (for
	// example a revoked capability). The source event may be consumed safely.
	ErrModerationActionRefused = errors.New("moderation action definitively refused")
)

type moderationRemovalSigner interface {
	Binding() native.Binding
	SignRemoval(context.Context, id.ID, id.ID, uint64, uint64, uint64) ([]byte, error)
}

type moderationRemovalSession interface {
	AcceptModerationRemoval(context.Context, id.ID, []byte) (client.ModerationRemovalReceipt, error)
}

type moderationActionSession interface {
	AcceptBotModerationAction(context.Context, id.ID, id.ID, id.ID, uint64, string, []string, uint64, uint64) (client.ModerationActionReceipt, error)
}

// ModerationRemovalBackend sends signed removals and installation-bound warn
// or timeout decisions. The server rechecks the active installation capability,
// current moderation permission and hierarchy for every accepted action.
type ModerationRemovalBackend struct {
	native  moderationRemovalSigner
	session interface {
		moderationRemovalSession
		moderationActionSession
	}
	binding native.Binding
}

func NewModerationRemovalBackend(n *native.Client, session *client.Session) (*ModerationRemovalBackend, error) {
	if n == nil || session == nil {
		return nil, ErrModerationEnforcementUnavailable
	}
	return newModerationRemovalBackend(n, session)
}

func newModerationRemovalBackend(n moderationRemovalSigner, session interface {
	moderationRemovalSession
	moderationActionSession
}) (*ModerationRemovalBackend, error) {
	if n == nil || session == nil {
		return nil, ErrModerationEnforcementUnavailable
	}
	binding := n.Binding()
	if binding.Instance.IsZero() || binding.Community.IsZero() || binding.Installation.IsZero() {
		return nil, ErrModerationCaseBinding
	}
	return &ModerationRemovalBackend{native: n, session: session, binding: binding}, nil
}

func (b *ModerationRemovalBackend) EnforceModerationAction(ctx context.Context, action ModerationAction) error {
	_, err := b.AcceptModerationAction(ctx, action)
	return err
}

// AcceptModerationAction returns a typed, source-bound record only after the
// server reports the immutable accepted action ID and community revision.
func (b *ModerationRemovalBackend) AcceptModerationAction(ctx context.Context, action ModerationAction) (AcceptedModerationAction, error) {
	if b == nil || ctx == nil {
		return AcceptedModerationAction{}, ErrModerationActionSource
	}
	if action.Decision.Action != moderation.ActionRemove && action.Decision.Action != moderation.ActionWarn && action.Decision.Action != moderation.ActionTimeout {
		return AcceptedModerationAction{}, ErrModerationActionUnsupported
	}
	if !action.runtimeGenerated || len(action.Decision.Rules) == 0 || (action.Decision.Action != moderation.ActionTimeout && action.Decision.Timeout != 0) ||
		(action.Decision.Action == moderation.ActionTimeout && (action.Decision.Timeout <= 0 || action.Decision.Timeout > moderation.MaxTimeout)) {
		return AcceptedModerationAction{}, ErrModerationActionSource
	}
	community, communityErr := id.Parse(action.Community)
	group, groupErr := id.Parse(action.Group)
	channel, channelErr := id.Parse(action.Channel)
	actor, actorErr := id.Parse(action.Actor)
	message, messageErr := id.Parse(action.Message)
	if communityErr != nil || groupErr != nil || channelErr != nil || actorErr != nil || messageErr != nil ||
		community.IsZero() || group.IsZero() || channel.IsZero() || actor.IsZero() || message.IsZero() || community != b.binding.Community ||
		action.SourceRevision == 0 || action.SourceRevision > math.MaxInt64 || action.ReceivedAt.IsZero() ||
		action.ReceivedAt.Unix() <= 0 || action.ReceivedAt.Unix() > math.MaxInt64-30 {
		return AcceptedModerationAction{}, ErrModerationActionSource
	}
	if err := ctx.Err(); err != nil {
		return AcceptedModerationAction{}, err
	}
	var request id.ID
	var accepted client.ModerationActionReceipt
	if action.Decision.Action == moderation.ActionRemove {
		request = moderationRemovalOperationID(group, message, action.SourceRevision)
		now := uint64(action.ReceivedAt.Unix())
		expires := now + 30
		signed, err := b.native.SignRemoval(ctx, request, group, action.SourceRevision, expires, now)
		if err != nil {
			return AcceptedModerationAction{}, err
		}
		receipt, err := b.session.AcceptModerationRemoval(ctx, group, signed)
		var apiErr *client.APIError
		if errors.As(err, &apiErr) && apiErr.Code == "E_REMOVAL_PROOF_EXPIRED" {
			currentUnix := time.Now().Unix()
			if currentUnix <= 0 || currentUnix > math.MaxInt64-30 {
				return AcceptedModerationAction{}, err
			}
			current := uint64(currentUnix)
			signed, signErr := b.native.SignRemoval(ctx, request, group, action.SourceRevision, current+30, current)
			if signErr != nil {
				return AcceptedModerationAction{}, signErr
			}
			receipt, err = b.session.AcceptModerationRemoval(ctx, group, signed)
		}
		if err != nil {
			return AcceptedModerationAction{}, err
		}
		if receipt.ActionID.IsZero() || receipt.Revision == 0 || receipt.Revision > math.MaxInt64 {
			return AcceptedModerationAction{}, client.ErrProtocol
		}
		return AcceptedModerationAction{actionID: receipt.ActionID, serverRevision: receipt.Revision, community: community,
			group: group, targetSequence: action.SourceRevision, operationID: request, action: moderation.ActionRemove}, nil
	}
	request = operationid.Automatic(group, action.SourceRevision)
	if request.IsZero() {
		return AcceptedModerationAction{}, ErrModerationActionSource
	}
	rules := make([]string, len(action.Decision.Rules))
	for i, rule := range action.Decision.Rules {
		switch rule {
		case moderation.RuleRate:
			rules[i] = "message_rate"
		case moderation.RuleDuplicate:
			rules[i] = "duplicate_body"
		case moderation.RuleMentions:
			rules[i] = "mention_count"
		default:
			return AcceptedModerationAction{}, ErrModerationActionSource
		}
	}
	for i := 1; i < len(rules); i++ {
		for j := i; j > 0 && rules[j] < rules[j-1]; j-- {
			rules[j], rules[j-1] = rules[j-1], rules[j]
		}
	}
	now := time.Now().Unix()
	if now <= 0 || now > math.MaxInt64-30 {
		return AcceptedModerationAction{}, ErrModerationActionSource
	}
	var timeoutMillis uint64
	if action.Decision.Action == moderation.ActionTimeout {
		timeoutMillis = uint64(action.Decision.Timeout / time.Millisecond)
	}
	accepted, err := b.session.AcceptBotModerationAction(ctx, b.binding.Installation, request, group, action.SourceRevision, string(action.Decision.Action), rules, timeoutMillis, uint64(now+30))
	if err != nil {
		var apiErr *client.APIError
		if errors.As(err, &apiErr) && apiErr.Outcome == client.OutcomeDefinitive && apiErr.Code == "E_FORBIDDEN" {
			return AcceptedModerationAction{}, ErrModerationActionRefused
		}
		return AcceptedModerationAction{}, err
	}
	if accepted.ActionID.IsZero() || accepted.Revision == 0 || accepted.Revision > math.MaxInt64 {
		return AcceptedModerationAction{}, client.ErrProtocol
	}
	return AcceptedModerationAction{actionID: accepted.ActionID, serverRevision: accepted.Revision, community: community,
		group: group, targetSequence: action.SourceRevision, operationID: request, action: action.Decision.Action}, nil

}

func moderationRemovalOperationID(group, message id.ID, revision uint64) id.ID {
	var encoded [8]byte
	for i := range encoded {
		encoded[7-i] = byte(revision >> (8 * i))
	}
	sum := sha256.Sum256(append(append(append([]byte("dilla:automod:remove:v1\x00"), group[:]...), message[:]...), encoded[:]...))
	var operation id.ID
	copy(operation[:], sum[:len(operation)])
	if operation.IsZero() {
		operation[15] = 1
	}
	return operation
}

var _ ModerationEnforcementBackend = (*ModerationRemovalBackend)(nil)
