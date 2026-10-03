package api

import (
	"context"
	"errors"
	"fmt"

	"github.com/jonasthim/dilla/internal/id"
	"github.com/jonasthim/dilla/internal/sfu"
	"github.com/jonasthim/dilla/internal/store"
)

// SyncCallGrants re-pushes the live call grants a role or overwrite change may have moved (gap G26).
// It runs after the commit, beside the six materialisers of roles.go, with the scope of the change:
// one user of a community (grant, revoke), every member of one channel (an overwrite), or every
// member of every channel (a role's bits or its deletion). For each live call in scope it resolves
// each participant device's bits and pushes the complete permission; LiveKit's MatchesPermission
// makes an unchanged one a no-op, so over-calling is safe. A user who lost view_channel or connect
// is skipped — the leaf Remove and the call evictor take that device out of the room — and a user
// who lost both video and screen_share loses the sharing slot after the demotion is pushed.
func SyncCallGrants(ctx context.Context, repo store.Repository, res *Resolver, tokens CallTokens, h *Calls,
	communityID id.ID, userID *id.ID, channelID *id.ID) error {
	if tokens == nil || h == nil {
		return nil
	}
	var channels []store.ChannelRow
	if channelID != nil {
		ch, err := repo.GetChannel(ctx, *channelID)
		if err != nil {
			return err
		}
		channels = []store.ChannelRow{ch}
	} else {
		all, err := repo.ListChannels(ctx, communityID)
		if err != nil {
			return err
		}
		channels = all
	}
	var errs []error
	for _, ch := range channels {
		if !CallGroupAllowed(ch) {
			continue
		}
		rows, err := repo.ListLiveVoiceSessions(ctx, ch.ID)
		if err != nil {
			errs = append(errs, err)
			continue
		}
		for _, row := range rows {
			if err := syncRoomGrants(ctx, repo, res, tokens, h, ch, row, userID); err != nil {
				errs = append(errs, err)
			}
		}
	}
	return errors.Join(errs...)
}

func syncRoomGrants(ctx context.Context, repo store.Repository, res *Resolver, tokens CallTokens, h *Calls,
	ch store.ChannelRow, row store.VoiceSessionRow, userID *id.ID) error {
	parts, err := tokens.Participants(ctx, row.LivekitRoom)
	if err != nil {
		return err
	}
	var errs []error
	for _, p := range parts {
		dev, err := id.Parse(p.GetIdentity())
		if err != nil {
			continue // a "#" shadow or a foreign identity: the /rtc gate refuses those, RemoveParticipants takes them
		}
		d, err := repo.GetDevice(ctx, dev)
		if err != nil {
			errs = append(errs, fmt.Errorf("device %s: %w", dev, err))
			continue
		}
		if userID != nil && d.UserID != *userID {
			continue
		}
		bits, err := res.Resolve(ctx, d.UserID, ch)
		if err != nil {
			errs = append(errs, err)
			continue
		}
		if !bits.Has(PermViewChannel) || !bits.Has(PermConnect) {
			continue
		}
		keepsSlot := bits.Has(PermVideo) || bits.Has(PermScreenShare)
		perm := h.grantFor(bits, row.CallID, dev)
		if !keepsSlot {
			perm = sfu.PublishGrant(bits.Has(PermSpeak), false, false)
		}
		if err := tokens.UpdatePermission(ctx, row.LivekitRoom, p.GetIdentity(), perm); err != nil && !errors.Is(err, sfu.ErrNoParticipant) {
			errs = append(errs, err)
			continue
		}
		if !keepsSlot {
			h.leases.release(row.CallID, dev)
		}
	}
	return errors.Join(errs...)
}
