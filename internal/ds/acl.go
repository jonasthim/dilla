package ds

import (
	"context"

	"github.com/jonasthim/dilla/internal/id"
	"github.com/jonasthim/dilla/internal/store"
)

// ACL is the eligibility half of invariant 4's Add clause: "a credential whose user is eligible
// under the channel's ACL". The resolver is Plan 2's — permissions live with the structure tables
// — so the clause is an injected seam and Plan 1 supplies DenyUnlessMember, which admits a user
// only where the instance can already see them in the group. That is deliberately conservative: a
// permissive stub would leave a security clause of invariant 4 silently unimplemented, which is
// the one outcome worse than a strict one. NV-B6 names Plan 2 task 3 as the step that replaces it.
//
// It is declared here, with its Plan-1 stub, because ds.Options names the seam (deviation D16),
// so the package does not build without it. Task 20's brief
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
