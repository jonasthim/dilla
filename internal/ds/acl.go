package ds

import (
	"context"

	"github.com/jonasthim/dilla/internal/id"
	"github.com/jonasthim/dilla/internal/store"
)

// PermissiveChannels is the Plan-1 stand-in for the channel-mode source of invariant 1. It
// reports "no channel row" for every target, which is the honest answer while the `channels`
// table does not exist: Plan 2 task 2 creates it (`006_structure.sql`) and replaces this with the
// real `store.Structure`, which is when the mode rule starts refusing anything in production.
// NV-B5 tracks the hand-over.
//
// It is NOT a mock of the delivery service. `checkChannelMode` — the rule itself — runs against
// it exactly as it runs against Plan 2's implementation; only the data source differs.
type PermissiveChannels struct{}

func (PermissiveChannels) Channel(_ context.Context, _ id.ID) (visibility, mode uint8, err error) {
	return 0, 0, ErrNoChannel
}

// ACL is the eligibility half of invariant 4's Add clause: "a credential whose user is eligible
// under the channel's ACL". The resolver is Plan 2's — permissions live with the structure tables
// — so the clause is an injected seam and Plan 1 supplies DenyUnlessMember, which admits a user
// only where the instance can already see them in the group. That is deliberately conservative: a
// permissive stub would leave a security clause of invariant 4 silently unimplemented, which is
// the one outcome worse than a strict one. NV-B6 names Plan 2 task 3 as the step that replaces it.
//
// It is declared here, with its Plan-1 stub, for the same reason PermissiveChannels is (deviation
// D16): ds.Options names the seam, so the package does not build without it. Task 20's brief
// re-declares this interface beside checkAddedMember, which is its first caller; that step is a
// check against this declaration, not a second one.
type ACL interface {
	// Eligible reports whether userID may be added to groupID. An error means "the resolver
	// cannot answer", which every caller treats as a refusal, never as a pass.
	Eligible(ctx context.Context, groupID, userID id.ID) (bool, error)
}

// DenyUnlessMember is the Plan-1 ACL: a user is eligible only where the instance can already see
// them as a member of the group. That admits the ordinary re-add of a device belonging to a user
// already in the group and refuses everything else (NV-B6). Plan 2 task 3 replaces it with the
// permission resolver.
type DenyUnlessMember struct{ Store store.Repository }

func (a DenyUnlessMember) Eligible(ctx context.Context, groupID, userID id.ID) (bool, error) {
	members, err := a.Store.ListMembers(ctx, groupID)
	if err != nil {
		return false, err
	}
	for _, m := range members {
		if m.UserID == userID && m.RemovedEpoch == nil {
			return true, nil
		}
	}
	return false, nil
}
