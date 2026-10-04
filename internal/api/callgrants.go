package api

import (
	"context"
	"errors"
	"fmt"

	"github.com/jonasthim/dilla/internal/id"
	"github.com/jonasthim/dilla/internal/sfu"
	"github.com/jonasthim/dilla/internal/store"
)

// grantDeps is what a grant reconciliation reads and drives: the store, the resolver over it and
// the SFU. The routes use their own; SyncCallGrants is handed the caller's.
type grantDeps struct {
	repo   store.Repository
	res    *Resolver
	tokens CallTokens
}

func (h *Calls) deps() grantDeps { return grantDeps{repo: h.repo, res: h.res, tokens: h.sfu} }

// SyncCallGrants re-pushes the live call grants a role or overwrite change may have moved (gap G26).
// It runs after the commit, beside the six materialisers of roles.go, with the scope of the change:
// one user of a community (grant, revoke), every member of one channel (an overwrite), or every
// member of every channel (a role's bits or its deletion). For each live call in scope it takes the
// call's lock, re-reads the call, drives the call's pending repairs, and reconciles each participant
// in scope from bits resolved under the lock (reconcile). LiveKit's MatchesPermission makes an
// unchanged permission a no-op, so over-calling is safe.
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
	d := grantDeps{repo: repo, res: res, tokens: tokens}
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
			if err := h.syncRoomGrants(ctx, d, ch, row, userID); err != nil {
				errs = append(errs, err)
			}
		}
	}
	return errors.Join(errs...)
}

func (h *Calls) syncRoomGrants(ctx context.Context, d grantDeps, ch store.ChannelRow, row store.VoiceSessionRow, userID *id.ID) error {
	unlock := h.leases.lockCall(row.CallID)
	defer unlock()
	cur, live, err := h.liveRow(ctx, d.repo, row)
	if err != nil || !live {
		return err
	}
	retried := h.drainPending(ctx, d, ch, cur)
	parts, err := d.tokens.Participants(ctx, cur.LivekitRoom)
	if err != nil {
		return err
	}
	var errs []error
	for _, p := range parts {
		if retried[p.GetIdentity()] {
			continue
		}
		errs = append(errs, h.reconcile(ctx, d, ch, cur, p.GetIdentity(), userID, false))
	}
	return errors.Join(errs...)
}

// reconcile brings one participant of row's room within what it is entitled to now; the caller holds
// the call's lock, so the bits it resolves and the push it makes are one step against every share,
// unshare and other sync of the call. It fails closed (DEV-44, the spec's "the SFU session is cut
// immediately on kick"):
//
//   - an identity that is no device of this instance (a "#" shadow, a foreign name, an id naming no
//     device) is removed by its exact identity, whatever userID scopes;
//   - a device whose lookup or resolution fails is pushed the no-publish grant;
//   - a device whose user lost view_channel or connect is cut from the room at once with every "#"
//     shadow of it (the leaf Remove still follows through the delivery service);
//   - otherwise the device is pushed its complete permission, the camera and screen sources only
//     while it holds a slot and dropSlot is false; a device that keeps neither video nor
//     screen_share (or dropSlot) loses its slot once the push landed.
//
// A cut or push that does not land is recorded as a pending repair and the error returned; the slot
// stays held while it is pending, and the token mint and the /rtc gate refuse the device for the
// call. One that lands clears the repair. A participant the SFU no longer holds needs nothing and
// loses its slot.
func (h *Calls) reconcile(ctx context.Context, d grantDeps, ch store.ChannelRow, row store.VoiceSessionRow,
	identity string, userID *id.ID, dropSlot bool) error {
	pending := func(err error, drop bool) error {
		h.leases.markPending(row.CallID, identity, pendingRepair{Room: row.LivekitRoom, DropSlot: drop})
		return err
	}
	dev, err := id.Parse(identity)
	if err != nil {
		return h.cutIdentity(ctx, d, row, identity, pending)
	}
	dv, err := d.repo.GetDevice(ctx, dev)
	if errors.Is(err, store.ErrNotFound) {
		return h.cutIdentity(ctx, d, row, identity, pending)
	}
	if err != nil {
		return pending(errors.Join(fmt.Errorf("device %s: %w", dev, err), h.pushNone(ctx, d, row, dev)), dropSlot)
	}
	_, wasPending := h.leases.pendingOf(row.CallID)[identity]
	if userID != nil && dv.UserID != *userID && !wasPending {
		return nil
	}
	bits, err := d.res.Resolve(ctx, dv.UserID, ch)
	if err != nil {
		return pending(errors.Join(fmt.Errorf("device %s: %w", dev, err), h.pushNone(ctx, d, row, dev)), dropSlot)
	}
	if !bits.Has(PermViewChannel) || !bits.Has(PermConnect) {
		if err := d.tokens.RemoveParticipants(ctx, row.LivekitRoom, dev); err != nil {
			return pending(errors.Join(fmt.Errorf("cut device %s: %w", dev, err), h.pushNone(ctx, d, row, dev)), true)
		}
		h.leases.release(row.CallID, dev)
		h.leases.clearPending(row.CallID, identity)
		if h.counters != nil {
			h.counters.CallCut()
		}
		return nil
	}
	leased := h.leases.held(row.CallID, dev) && !dropSlot
	keepsSlot := (bits.Has(PermVideo) || bits.Has(PermScreenShare)) && !dropSlot
	perm := sfu.PublishGrant(bits.Has(PermSpeak), bits.Has(PermVideo) && leased, bits.Has(PermScreenShare) && leased)
	if err := d.tokens.UpdatePermission(ctx, row.LivekitRoom, identity, perm); err != nil {
		if !errors.Is(err, sfu.ErrNoParticipant) {
			return pending(fmt.Errorf("push the permission of %s: %w", dev, err), dropSlot)
		}
		keepsSlot = false // the room no longer holds it: it publishes nothing
	}
	if !keepsSlot {
		h.leases.release(row.CallID, dev)
	}
	h.leases.clearPending(row.CallID, identity)
	return nil
}

// cutIdentity removes a participant that is no device of this instance by its exact identity.
func (h *Calls) cutIdentity(ctx context.Context, d grantDeps, row store.VoiceSessionRow, identity string,
	pending func(error, bool) error) error {
	if err := d.tokens.RemoveParticipant(ctx, row.LivekitRoom, identity); err != nil {
		return pending(fmt.Errorf("remove %q: %w", identity, err), true)
	}
	h.leases.clearPending(row.CallID, identity)
	if h.counters != nil {
		h.counters.CallCut()
	}
	return nil
}

// pushNone pushes dev the no-publish grant: the fallback of a cut or a lookup that failed. Its own
// failure is reported; the caller records the repair either way.
func (h *Calls) pushNone(ctx context.Context, d grantDeps, row store.VoiceSessionRow, dev id.ID) error {
	err := d.tokens.UpdatePermission(ctx, row.LivekitRoom, dev.String(), sfu.PublishGrant(false, false, false))
	if err != nil && !errors.Is(err, sfu.ErrNoParticipant) {
		return fmt.Errorf("fail-closed demotion of %s: %w", dev, err)
	}
	return nil
}

// drainPending retries every pending repair of row's call — the call's next event drives them as
// the ticker does — and answers the identities it retried. The caller holds the call's lock.
// Repairs recorded for an older room of the call are dropped: that room is closed.
func (h *Calls) drainPending(ctx context.Context, d grantDeps, ch store.ChannelRow, row store.VoiceSessionRow) map[string]bool {
	retried := map[string]bool{}
	if d.tokens == nil {
		return retried
	}
	for identity, r := range h.leases.pendingOf(row.CallID) {
		if r.Room != row.LivekitRoom {
			h.leases.clearPending(row.CallID, identity)
			continue
		}
		retried[identity] = true
		if h.counters != nil {
			h.counters.CallGrantRetry()
		}
		h.log.WarnContext(ctx, "retrying a call grant repair", "device", identity, "room", r.Room, "drop_slot", r.DropSlot)
		if err := h.reconcile(ctx, d, ch, row, identity, nil, r.DropSlot); err != nil {
			h.log.WarnContext(ctx, "a call grant repair did not land; it stays pending", "device", identity, "room", r.Room, "err", err)
		}
	}
	return retried
}

// RetryPending drives every call's pending repairs once: the composition root calls it on its
// maintenance tick, so a cut or demotion the SFU refused converges without waiting for another event
// in the call. A call that has ended loses its repairs (its room is closed).
func (h *Calls) RetryPending(ctx context.Context) {
	if h.sfu == nil {
		return
	}
	for _, call := range h.leases.pendingCalls() {
		h.retryCall(ctx, call)
	}
}

func (h *Calls) retryCall(ctx context.Context, call id.ID) {
	if len(h.leases.pendingOf(call)) == 0 {
		return
	}
	unlock := h.leases.lockCall(call)
	defer unlock()
	row, err := h.repo.GetVoiceSession(ctx, call)
	if errors.Is(err, store.ErrNotFound) || (err == nil && row.Ended != nil) {
		h.leases.dropCall(call)
		return
	}
	if err != nil {
		h.log.WarnContext(ctx, "reading a call for its grant repairs failed", "call", call, "err", err)
		return
	}
	ch, err := h.repo.GetChannel(ctx, row.ChannelID)
	if err != nil {
		h.log.WarnContext(ctx, "reading a call's channel for its grant repairs failed", "call", call, "err", err)
		return
	}
	h.drainPending(ctx, h.deps(), ch, row)
}
