package service

import (
	"context"
	"crypto/sha256"
	"errors"
	"math"

	"github.com/jonasthim/dilla/internal/bot/client"
	"github.com/jonasthim/dilla/internal/bot/moderation"
	"github.com/jonasthim/dilla/internal/bot/native"
	"github.com/jonasthim/dilla/internal/id"
)

var (
	ErrModerationActionUnsupported = errors.New("moderation action is unsupported by this enforcement adapter")
	ErrModerationActionSource      = errors.New("moderation action lacks an authoritative bound source")
)

type moderationRemovalSigner interface {
	Binding() native.Binding
	SignRemoval(context.Context, id.ID, id.ID, uint64, uint64, uint64) ([]byte, error)
}

type moderationRemovalSession interface {
	AcceptModerationRemoval(context.Context, id.ID, []byte) (client.ModerationRemovalReceipt, error)
}

// ModerationRemovalBackend enforces only signed message removal. Warn and
// timeout remain unavailable until the server exposes authoritative endpoints.
// The server checks the installation capability and current manage_messages
// permission while accepting each signed removal.
type ModerationRemovalBackend struct {
	native  moderationRemovalSigner
	session moderationRemovalSession
	binding native.Binding
}

func NewModerationRemovalBackend(n *native.Client, session *client.Session) (*ModerationRemovalBackend, error) {
	if n == nil || session == nil {
		return nil, ErrModerationEnforcementUnavailable
	}
	return newModerationRemovalBackend(n, session)
}

func newModerationRemovalBackend(n moderationRemovalSigner, session moderationRemovalSession) (*ModerationRemovalBackend, error) {
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
	if b == nil || ctx == nil {
		return ErrModerationActionSource
	}
	if action.Decision.Action != moderation.ActionRemove {
		return ErrModerationActionUnsupported
	}
	if len(action.Decision.Rules) == 0 || action.Decision.Timeout != 0 {
		return ErrModerationActionSource
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
		return ErrModerationActionSource
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	request := moderationRemovalOperationID(group, message, action.SourceRevision)
	now := uint64(action.ReceivedAt.Unix())
	expires := now + 30
	signed, err := b.native.SignRemoval(ctx, request, group, action.SourceRevision, expires, now)
	if err != nil {
		return err
	}
	_, err = b.session.AcceptModerationRemoval(ctx, group, signed)
	return err
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
