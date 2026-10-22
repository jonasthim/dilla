package client

import (
	"context"
	"net/http"

	"github.com/jonasthim/dilla/internal/id"
)

// Community reads one community by ID. Managed bot sessions may use this
// member-scoped route for their bound community without listing memberships.
func (s *Session) Community(ctx context.Context, community id.ID) (Community, error) {
	var out Community
	if s == nil || s.c == nil {
		return out, ErrInvalidConfig
	}
	cid, err := pathID(community)
	if err != nil {
		return out, err
	}
	raw, _, err := s.c.do(ctx, s.token, http.MethodGet, "communities/"+cid, nil, nil, MaxSmallBody, false)
	if err != nil {
		return out, err
	}
	a, err := decode(raw, 8)
	if err != nil {
		return out, err
	}
	var ok bool
	if out.ID, ok = asID(a[0]); !ok || out.ID.IsZero() {
		return Community{}, ErrProtocol
	}
	if out.OwnerID, ok = asID(a[1]); !ok || out.OwnerID.IsZero() {
		return Community{}, ErrProtocol
	}
	if out.Name, ok = a[2].(string); !ok || out.Name == "" {
		return Community{}, ErrProtocol
	}
	if _, ok = a[3].([]byte); !ok {
		return Community{}, ErrProtocol
	}
	if out.PolicyVersion, ok = asUint(a[4]); !ok {
		return Community{}, ErrProtocol
	}
	for _, flag := range a[5:7] {
		if _, ok = asUint(flag); !ok {
			return Community{}, ErrProtocol
		}
	}
	switch a[7].(type) {
	case int64, uint64:
	default:
		return Community{}, ErrProtocol
	}
	return out, nil
}
