package client

import (
	"context"
	"errors"
	"net/http"

	"github.com/jonasthim/dilla/internal/id"
)

// ActorAuthority is the minimal current community-wide authority returned for
// a current member. Bits uses the server's stable permission bit assignments.
type ActorAuthority struct {
	EffectiveBits uint64
	Owner         bool
	Administrator bool
}

const knownCommunityPermissionBits = uint64(1<<25) - 1

// BotActorAuthority asks the authenticated managed bot session to resolve one
// actor in its bound community. A 404 means the actor is not a current member.
func (s *Session) BotActorAuthority(ctx context.Context, community, actor id.ID) (ActorAuthority, bool, error) {
	var out ActorAuthority
	if s == nil || s.c == nil {
		return out, false, ErrInvalidConfig
	}
	cid, err := pathID(community)
	if err != nil {
		return out, false, err
	}
	uid, err := pathID(actor)
	if err != nil {
		return out, false, err
	}
	path := "communities/" + cid + "/bot/actors/" + uid + "/authority"
	raw, status, err := s.c.do(ctx, s.token, http.MethodGet, path, nil, nil, MaxSmallBody, false)
	if err != nil {
		var apiErr *APIError
		if errors.As(err, &apiErr) && status == http.StatusNotFound {
			return ActorAuthority{}, false, nil
		}
		return out, false, err
	}
	a, err := decode(raw, 3)
	if err != nil {
		return out, false, err
	}
	var ok bool
	if out.EffectiveBits, ok = asUint(a[0]); !ok || out.EffectiveBits & ^knownCommunityPermissionBits != 0 {
		return ActorAuthority{}, false, ErrProtocol
	}
	ownerFlag, ok := asUint(a[1])
	if !ok || ownerFlag > 1 {
		return ActorAuthority{}, false, ErrProtocol
	}
	adminFlag, ok := asUint(a[2])
	if !ok || adminFlag > 1 {
		return ActorAuthority{}, false, ErrProtocol
	}
	out.Owner, out.Administrator = ownerFlag == 1, adminFlag == 1
	return out, true, nil
}
