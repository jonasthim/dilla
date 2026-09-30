package api

import (
	"context"
	"errors"
	"fmt"

	"github.com/jonasthim/dilla/internal/ds"
	"github.com/jonasthim/dilla/internal/id"
	"github.com/jonasthim/dilla/internal/store"
)

// StructureChannels is the real ds.Channels: invariant 1's channel-mode source
// and the registration ACL, backed by the channels, communities and members
// tables. It replaces Plan 1's ds.PermissiveChannels{}, which reported "no
// channel row" for every target and admitted every registration so that part
// 1b could ship before the channels table existed (Plan 1 NV-B5 and follow-up
// card 14). It lives in internal/api, not internal/ds, because internal/ds must
// not learn the channel vocabulary it deliberately keeps behind the seam.
type StructureChannels struct{ Repo store.Repository }

var _ ds.Channels = StructureChannels{}

// Group kinds, protocol/01 "Group kinds".
const (
	groupText        uint8 = 0
	groupCall        uint8 = 1
	groupPairing     uint8 = 2
	groupInteraction uint8 = 3
)

// Channel returns the channel's visibility and mode. A target that is not a
// channel — a DM pairing group, an interaction group — is ds.ErrNoChannel, NOT
// an error: that is the contract Plan 1's checkChannelMode reads, and returning
// store.ErrNotFound here would 500 every such registration.
func (c StructureChannels) Channel(ctx context.Context, targetID id.ID) (uint8, uint8, error) {
	row, err := c.Repo.GetChannel(ctx, targetID)
	if errors.Is(err, store.ErrNotFound) {
		return 0, 0, ds.ErrNoChannel
	}
	if err != nil {
		return 0, 0, err
	}
	return row.Visibility, row.Mode, nil
}

// MayRegister is the registration ACL (Plan 1 follow-up card 14): before it, any
// enrolled device could register a group for any target. The rules, by group
// kind (protocol/01 § dilla_binding):
//
//   - text and call: when the target is a live channel, the binding's
//     community_id must be the channel's, the channel's kind must carry that
//     group kind (a text group on a text channel, a call group on a voice
//     channel; a DM carries both), and the user must hold, in that channel and
//     through the permission resolver, what ResolverACL requires of a joiner:
//     PermViewChannel for a text group, PermViewChannel|PermConnect for a call
//     group. A text or call group whose binding names a community but whose
//     target is not a live channel of it is refused: target_id is the channel id
//     for both kinds (protocol/01 dilla_binding; R9 keeps a call's id in a
//     companion column), and ResolverACL refuses the same group to a joiner.
//   - text and call with no community: a DM or group DM. Their membership is
//     channel_members, which task 6 creates; until then they are refused, which
//     is the conservative answer, not a permanent one.
//   - pairing and interaction: not channel groups. Pairing is gated by the
//     session scope rules of auth, and interaction groups have no structure row
//     to check; both are admitted here.
//
// A refusal wraps ds.ErrNotEligible (403 E_FORBIDDEN) or ds.ErrBindingTarget (400
// E_BINDING_INVALID); any other error is the store's.
func (c StructureChannels) MayRegister(ctx context.Context, userID id.ID, b ds.Binding) error {
	switch b.Kind {
	case groupPairing, groupInteraction:
		return nil
	case groupText, groupCall:
	default:
		return fmt.Errorf("%w: unknown group kind %d", ds.ErrBindingTarget, b.Kind)
	}

	row, err := c.Repo.GetChannel(ctx, b.TargetID)
	switch {
	case errors.Is(err, store.ErrNotFound):
		return mayRegisterWithoutChannel(b)
	case err != nil:
		return err
	}

	if row.CommunityID == nil {
		if b.CommunityID != nil {
			return fmt.Errorf("%w: the target is a DM, which has no community", ds.ErrBindingTarget)
		}
		return fmt.Errorf("%w: DM membership arrives with channel_members (Plan 2 task 6)", ds.ErrNotEligible)
	}
	if b.CommunityID == nil || *b.CommunityID != *row.CommunityID {
		return fmt.Errorf("%w: the target channel belongs to another community", ds.ErrBindingTarget)
	}
	switch {
	case b.Kind == groupText && row.Kind != ChannelText:
		return fmt.Errorf("%w: a text group is bound to a text channel", ds.ErrBindingTarget)
	case b.Kind == groupCall && row.Kind != ChannelVoice:
		return fmt.Errorf("%w: a call group is bound to a voice channel", ds.ErrBindingTarget)
	}
	bits, err := NewResolver(c.Repo).Resolve(ctx, userID, row)
	if err != nil {
		return err
	}
	if !bits.Has(groupBits(b.Kind)) {
		return fmt.Errorf("%w: not permitted in this channel", ds.ErrNotEligible)
	}
	return nil
}

// groupBits is what a channel group of kind needs, the same set ResolverACL
// requires of a joiner.
func groupBits(kind uint8) Bits {
	if kind == groupCall {
		return callGroupBits
	}
	return textGroupBits
}

// mayRegisterWithoutChannel is MayRegister for a text or call group whose target
// has no live channel row.
func mayRegisterWithoutChannel(b ds.Binding) error {
	if b.CommunityID == nil {
		return fmt.Errorf("%w: DM membership arrives with channel_members (Plan 2 task 6)", ds.ErrNotEligible)
	}
	return fmt.Errorf("%w: a community channel group must name a live channel of that community", ds.ErrBindingTarget)
}
