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
// makes an unchanged one a no-op, so over-calling is safe.
//
// It fails closed (DEV-44, the spec's "the SFU session is cut immediately on kick"):
//
//   - a device whose user lost view_channel or connect is cut from the room at once, with every "#"
//     shadow of it, and loses its sharing slot; the leaf Remove still follows through the delivery
//     service, and the /rtc gate refuses its rejoin meanwhile;
//   - a participant whose identity is no device of this instance is removed by its exact identity;
//   - a device whose lookup or resolution fails is pushed the no-publish grant and loses its slot,
//     and the failure is reported;
//   - a user who lost both video and screen_share loses the slot after the demotion is pushed.
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
		identity := p.GetIdentity()
		dev, err := id.Parse(identity)
		if err != nil {
			// A "#" shadow or a foreign identity: the /rtc gate admits neither, so one in a call room
			// is removed by its exact identity, whatever the scope of the change.
			errs = append(errs, h.cutIdentity(ctx, tokens, row, identity))
			continue
		}
		d, err := repo.GetDevice(ctx, dev)
		if errors.Is(err, store.ErrNotFound) {
			errs = append(errs, h.cutIdentity(ctx, tokens, row, identity))
			continue
		}
		if err != nil {
			errs = append(errs, fmt.Errorf("device %s: %w", dev, err), h.failClosed(ctx, tokens, row, dev))
			continue
		}
		if userID != nil && d.UserID != *userID {
			continue
		}
		bits, err := res.Resolve(ctx, d.UserID, ch)
		if err != nil {
			errs = append(errs, fmt.Errorf("device %s: %w", dev, err), h.failClosed(ctx, tokens, row, dev))
			continue
		}
		if !bits.Has(PermViewChannel) || !bits.Has(PermConnect) {
			errs = append(errs, h.cutDevice(ctx, tokens, row, dev))
			continue
		}
		keepsSlot := bits.Has(PermVideo) || bits.Has(PermScreenShare)
		perm := h.grantFor(bits, row.CallID, dev)
		if !keepsSlot {
			perm = sfu.PublishGrant(bits.Has(PermSpeak), false, false)
		}
		if err := tokens.UpdatePermission(ctx, row.LivekitRoom, identity, perm); err != nil && !errors.Is(err, sfu.ErrNoParticipant) {
			errs = append(errs, err)
			continue
		}
		if !keepsSlot {
			h.leases.release(row.CallID, dev)
		}
	}
	return errors.Join(errs...)
}

// cutDevice takes dev out of row's room at once — the participant and every "#" shadow of it — and
// frees its sharing slot. When the SFU will not remove it, dev is pushed the no-publish grant
// instead, so a device that stays in the room never keeps what it was cut for.
func (h *Calls) cutDevice(ctx context.Context, tokens CallTokens, row store.VoiceSessionRow, dev id.ID) error {
	if err := tokens.RemoveParticipants(ctx, row.LivekitRoom, dev); err != nil {
		return errors.Join(fmt.Errorf("cut device %s: %w", dev, err), h.failClosed(ctx, tokens, row, dev))
	}
	h.leases.release(row.CallID, dev)
	if h.counters != nil {
		h.counters.CallCut()
	}
	return nil
}

// cutIdentity removes a participant that is no device of this instance by its exact identity.
func (h *Calls) cutIdentity(ctx context.Context, tokens CallTokens, row store.VoiceSessionRow, identity string) error {
	if err := tokens.RemoveParticipant(ctx, row.LivekitRoom, identity); err != nil {
		return fmt.Errorf("remove %q: %w", identity, err)
	}
	if h.counters != nil {
		h.counters.CallCut()
	}
	return nil
}

// failClosed pushes dev the no-publish grant and frees its slot once the SFU holds it (or no longer
// holds dev). A demotion that fails keeps the slot: a device that may still publish video keeps
// counting against livekit.max_publishers.
func (h *Calls) failClosed(ctx context.Context, tokens CallTokens, row store.VoiceSessionRow, dev id.ID) error {
	err := tokens.UpdatePermission(ctx, row.LivekitRoom, dev.String(), sfu.PublishGrant(false, false, false))
	if err != nil && !errors.Is(err, sfu.ErrNoParticipant) {
		return fmt.Errorf("fail-closed demotion of %s: %w", dev, err)
	}
	h.leases.release(row.CallID, dev)
	return nil
}
