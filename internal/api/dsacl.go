package api

import (
	"context"
	"errors"

	"github.com/jonasthim/dilla/internal/ds"
	"github.com/jonasthim/dilla/internal/id"
	"github.com/jonasthim/dilla/internal/store"
)

// ResolverACL is the real ds.ACL: invariant 4's "a credential whose user is
// eligible under the channel's ACL", answered by the permission resolver over
// roles and channel overwrites. It replaces Plan 1's ds.DenyUnlessMember (NV-B6)
// as the eligibility check for an Add, for a join by external commit (resync)
// and for the GroupInfo and tree a joiner reads. Like StructureChannels it lives
// in internal/api, because internal/ds must not learn the permission vocabulary
// it keeps behind the seam.
//
// The rules, by the group's kind (protocol/01 "Group kinds"):
//
//   - text, in a community: the group's target is a live channel of the group's
//     community and the user holds PermViewChannel in it, overwrites applied.
//   - call, in a community: the same with PermViewChannel|PermConnect when the
//     target is a voice channel; when the target is the call rather than the
//     channel (R9, and voice_sessions is task 16's table), the user holds the
//     two bits community-wide.
//   - everything else — a DM or group DM (no community; its participants are
//     task 6's channel_members), a pairing group, an interaction group — keeps
//     Plan 1's rule: eligible only where the user is already in the group.
//
// An error means "cannot answer", which every caller in internal/ds treats as a
// refusal.
type ResolverACL struct{ Repo store.Repository }

var _ ds.ACL = ResolverACL{}

// The bits each channel group needs.
const (
	textGroupBits = PermViewChannel
	callGroupBits = PermViewChannel | PermConnect
)

func (a ResolverACL) Eligible(ctx context.Context, groupID, userID id.ID) (bool, error) {
	g, err := a.Repo.GetGroup(ctx, groupID)
	if errors.Is(err, store.ErrNotFound) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	if g.CommunityID == nil || (g.Kind != groupText && g.Kind != groupCall) {
		return ds.DenyUnlessMember{Store: a.Repo}.Eligible(ctx, groupID, userID)
	}
	want := textGroupBits
	if g.Kind == groupCall {
		want = callGroupBits
	}
	ch, err := a.Repo.GetChannel(ctx, g.TargetID)
	switch {
	case errors.Is(err, store.ErrNotFound):
		if g.Kind == groupText {
			return false, nil // a community text group whose channel is gone
		}
		return communityHas(ctx, a.Repo, *g.CommunityID, userID, want)
	case err != nil:
		return false, err
	}
	if ch.CommunityID == nil || *ch.CommunityID != *g.CommunityID {
		return false, nil
	}
	bits, err := NewResolver(a.Repo).Resolve(ctx, userID, ch)
	if err != nil {
		return false, err
	}
	return bits.Has(want), nil
}

// communityHas reports whether userID is a member of the live community and
// holds want community-wide.
func communityHas(ctx context.Context, repo store.Repository, communityID, userID id.ID, want Bits) (bool, error) {
	if _, err := repo.GetMember(ctx, communityID, userID); err != nil {
		if errors.Is(err, store.ErrNotFound) {
			return false, nil
		}
		return false, err
	}
	snap, err := LoadSnapshot(ctx, repo, communityID, userID, nil)
	if errors.Is(err, store.ErrNotFound) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return snap.Resolve(userID).Has(want), nil
}
