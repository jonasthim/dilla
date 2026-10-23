package client

import (
	"context"
	"errors"
	"fmt"
	"net/http"

	"github.com/jonasthim/dilla/internal/id"
)

// MusicCapability is the approved Music bit in a managed installation capability mask.
const MusicCapability uint64 = 1 << 0

// MusicDJRolePolicy is the fresh DJ policy returned for one ready, Music-enabled
// installation to its enrolled Bot session.
type MusicDJRolePolicy struct {
	CommunityID, InstallationID id.ID
	Capabilities                uint64
	RoleIDs                     []id.ID
}

func (s *Session) MusicDJRolePolicy(ctx context.Context, installation id.ID) (MusicDJRolePolicy, error) {
	var out MusicDJRolePolicy
	if s == nil || s.c == nil || installation.IsZero() {
		return out, ErrInvalidConfig
	}
	installationPath, err := pathID(installation)
	if err != nil {
		return out, err
	}
	raw, status, err := s.c.do(ctx, s.token, http.MethodGet, "bot-runtime/installations/"+installationPath+"/music/dj-roles", nil, nil, MaxSmallBody, false)
	if err != nil {
		return out, fmt.Errorf("bot client: DJ policy HTTP %d: %w", status, err)
	}
	a, err := decode(raw, 4)
	if err != nil {
		return out, err
	}
	if out.CommunityID, _ = asID(a[0]); out.CommunityID.IsZero() {
		return MusicDJRolePolicy{}, ErrProtocol
	}
	if out.InstallationID, _ = asID(a[1]); out.InstallationID != installation {
		return MusicDJRolePolicy{}, ErrProtocol
	}
	if out.Capabilities, _ = asUint(a[2]); out.Capabilities&MusicCapability == 0 {
		return MusicDJRolePolicy{}, errors.New("bot client: Music capability unavailable")
	}
	roles, ok := a[3].([]any)
	if !ok || len(roles) > 4096 {
		return MusicDJRolePolicy{}, ErrProtocol
	}
	seen := make(map[id.ID]struct{}, len(roles))
	out.RoleIDs = make([]id.ID, len(roles))
	for i, value := range roles {
		role, valid := asID(value)
		if !valid || role.IsZero() {
			return MusicDJRolePolicy{}, ErrProtocol
		}
		if _, exists := seen[role]; exists {
			return MusicDJRolePolicy{}, ErrProtocol
		}
		seen[role] = struct{}{}
		out.RoleIDs[i] = role
	}
	return out, nil
}
