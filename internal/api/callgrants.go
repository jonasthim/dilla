package api

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"slices"
	"sort"
	"strings"
	"sync"
	"time"

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

// syncAfterMembership is SyncCallGrants scoped to userID after a membership change has committed —
// a kick, a leave, a ban, a group-DM removal — so the user's connected SFU sessions are cut at once
// (the MLS Remove of their leaves still follows through the delivery service). channelID scopes it
// to one channel (a DM has no community); nil walks every channel of communityID. A failure is
// logged: the change stands, and the room sweep converges what the sync could not. A nil h (no SFU)
// touches nothing.
func syncAfterMembership(ctx context.Context, h *Calls, log *slog.Logger, communityID id.ID, userID id.ID, channelID *id.ID) {
	if h == nil || h.sfu == nil {
		return
	}
	if err := SyncCallGrants(ctx, h.repo, h.res, h.sfu, h, communityID, &userID, channelID); err != nil {
		log.ErrorContext(ctx, "cutting a removed user from live calls failed; the room sweep retries it",
			"community", communityID, "user", userID, "err", err)
	}
}

// roomResync is the pending-repair key for "reconcile every participant of the room": a grant sync
// that could not take the call's lock, could not list the room, or ran out of its hold leaves it for
// the retry loop.
const roomResync = "*"

func (h *Calls) syncRoomGrants(ctx context.Context, d grantDeps, ch store.ChannelRow, row store.VoiceSessionRow, userID *id.ID) error {
	ctx, unlock, err := h.lock(ctx, row.CallID, callLockWaitBackground, callHoldBackground)
	if err != nil {
		// The change is committed; the room converges on the retry loop instead.
		h.leases.markPending(row.CallID, roomResync, pendingRepair{Room: row.LivekitRoom})
		h.reportPending()
		return fmt.Errorf("sync the grants of %s: %w", row.LivekitRoom, err)
	}
	defer unlock()
	cur, live, err := h.liveRow(ctx, d.repo, row)
	if err != nil || !live {
		return err
	}
	retried, _ := h.drainPending(ctx, d, ch, cur, maxRepairsPerTick, "")
	return h.reconcileRoom(ctx, d, ch, cur, userID, retried, nil)
}

// reconcileRoom reconciles every participant of row's room in scope — userID's devices when it is
// set, the identities match accepts when it is set — skipping the identities a drain already did.
// A room that cannot be listed, or a hold that runs out before every participant was reached, is
// left as a pending room resync. The caller holds the call's lock; ctx carries the hold's deadline.
func (h *Calls) reconcileRoom(ctx context.Context, d grantDeps, ch store.ChannelRow, row store.VoiceSessionRow,
	userID *id.ID, done map[string]bool, match func(string) bool) error {
	h.leases.dropStale(row.CallID, row.LivekitRoom)
	lctx, cancel := sfuCtx(ctx)
	parts, err := d.tokens.Participants(lctx, row.LivekitRoom)
	cancel()
	if err != nil {
		h.leases.markPending(row.CallID, roomResync, pendingRepair{Room: row.LivekitRoom})
		return err
	}
	if userID == nil && match == nil {
		h.leases.clearPending(row.CallID, roomResync)
	}
	var errs []error
	for _, p := range parts {
		identity := p.GetIdentity()
		if done[identity] || (match != nil && !match(identity)) {
			continue
		}
		if err := ctx.Err(); err != nil {
			h.leases.markPending(row.CallID, roomResync, pendingRepair{Room: row.LivekitRoom})
			errs = append(errs, fmt.Errorf("the hold on %s ran out: %w", row.LivekitRoom, err))
			break
		}
		errs = append(errs, h.reconcile(ctx, d, ch, row, identity, userID, false))
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
//   - a barred device (revoked, quarantined, or of a disabled or deleted user) and a device whose
//     user lost view_channel or connect are cut from the room at once with every "#" shadow of it
//     (the leaf Remove still follows through the delivery service);
//   - otherwise the device is pushed its complete permission, the camera and screen sources only
//     while it holds a slot of this room and dropSlot is false; a device that keeps neither video
//     nor screen_share (or dropSlot) loses its slot once the push landed.
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
	bar, err := barred(ctx, d.repo, dv)
	if err != nil {
		return pending(errors.Join(fmt.Errorf("device %s: %w", dev, err), h.pushNone(ctx, d, row, dev)), dropSlot)
	}
	var bits Bits
	if !bar {
		if bits, err = d.res.Resolve(ctx, dv.UserID, ch); err != nil {
			return pending(errors.Join(fmt.Errorf("device %s: %w", dev, err), h.pushNone(ctx, d, row, dev)), dropSlot)
		}
	}
	if bar || !bits.Has(PermViewChannel) || !bits.Has(PermConnect) {
		rctx, cancel := sfuCtx(ctx)
		err := d.tokens.RemoveParticipants(rctx, row.LivekitRoom, dev)
		cancel()
		if err != nil {
			return pending(errors.Join(fmt.Errorf("cut device %s: %w", dev, err), h.pushNone(ctx, d, row, dev)), true)
		}
		h.leases.release(row.CallID, dev)
		h.leases.clearPending(row.CallID, identity)
		if h.counters != nil {
			h.counters.CallCut()
		}
		return nil
	}
	leased := h.leases.held(row.CallID, row.LivekitRoom, dev) && !dropSlot
	keepsSlot := (bits.Has(PermVideo) || bits.Has(PermScreenShare)) && !dropSlot
	perm := sfu.PublishGrant(bits.Has(PermSpeak), bits.Has(PermVideo) && leased, bits.Has(PermScreenShare) && leased)
	pctx, cancel := sfuCtx(ctx)
	err = d.tokens.UpdatePermission(pctx, row.LivekitRoom, identity, perm)
	cancel()
	if err != nil {
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
	rctx, cancel := sfuCtx(ctx)
	err := d.tokens.RemoveParticipant(rctx, row.LivekitRoom, identity)
	cancel()
	if err != nil {
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
	pctx, cancel := sfuCtx(ctx)
	err := d.tokens.UpdatePermission(pctx, row.LivekitRoom, dev.String(), sfu.PublishGrant(false, false, false))
	cancel()
	if err != nil && !errors.Is(err, sfu.ErrNoParticipant) {
		return fmt.Errorf("fail-closed demotion of %s: %w", dev, err)
	}
	return nil
}

// drainPending retries at most limit pending repairs of row's call — only identity only's when only
// is set, which is what a request drives — and answers the identities it retried and how many
// repairs it attempted. It stops when ctx (the hold's deadline) ends. The caller holds the call's
// lock. Repairs recorded for an older room of the call are dropped: that room is closed.
func (h *Calls) drainPending(ctx context.Context, d grantDeps, ch store.ChannelRow, row store.VoiceSessionRow,
	limit int, only string) (map[string]bool, int) {
	retried := map[string]bool{}
	if d.tokens == nil {
		return retried, 0
	}
	n := 0
	for identity, r := range h.leases.pendingOf(row.CallID) {
		if r.Room != row.LivekitRoom {
			h.leases.clearPending(row.CallID, identity)
			continue
		}
		if only != "" && identity != only {
			continue
		}
		if n >= limit || ctx.Err() != nil {
			break
		}
		n++
		if h.counters != nil {
			h.counters.CallGrantRetry()
		}
		h.log.WarnContext(ctx, "retrying a call grant repair", "device", identity, "room", r.Room, "drop_slot", r.DropSlot)
		var err error
		if identity == roomResync {
			err = h.reconcileRoom(ctx, d, ch, row, nil, retried, nil)
		} else {
			retried[identity] = true
			err = h.reconcile(ctx, d, ch, row, identity, nil, r.DropSlot)
		}
		if err != nil {
			h.log.WarnContext(ctx, "a call grant repair did not land; it stays pending", "device", identity, "room", r.Room, "err", err)
		}
	}
	return retried, n
}

// RetryPending drives the pending repairs of every call once, at most maxRepairsPerTick of them, and
// forgets the slots and repairs of every call that has ended (its room is closed) and the slots of
// an older room of a live call. The retry loop (StartRetries) runs it, so a cut or demotion the SFU
// refused converges without another event in the call; a call whose lock is busy is left for the
// next pass. Each call's hold is bounded by callHoldBackground.
func (h *Calls) RetryPending(ctx context.Context) {
	budget := maxRepairsPerTick
	for _, call := range h.leases.trackedCalls() {
		if budget <= 0 || ctx.Err() != nil {
			return
		}
		n, err := h.retryTracked(ctx, call, budget)
		if err != nil {
			h.log.WarnContext(ctx, "a call's grant repairs were skipped this pass", "call", call, "err", err)
		}
		budget -= n
	}
}

// retryOwn drives dev's own pending repair in call, if it has one: what a start or the /rtc gate does
// before it decides about dev. It waits at most callLockWait for the call's lock and holds it at most
// callHoldRequest. An error is a lock that could not be taken (a *server.Error, 503) or a store
// failure.
func (h *Calls) retryOwn(ctx context.Context, call, dev id.ID) error {
	if !h.leases.isPending(call, dev) {
		return nil
	}
	ctx, unlock, err := h.lock(ctx, call, callLockWait, callHoldRequest)
	if err != nil {
		return err
	}
	defer unlock()
	row, err := h.repo.GetVoiceSession(ctx, call)
	if errors.Is(err, store.ErrNotFound) || (err == nil && row.Ended != nil) {
		h.leases.dropCall(call)
		return nil
	}
	if err != nil || h.sfu == nil {
		return err
	}
	ch, err := h.repo.GetChannel(ctx, row.ChannelID)
	if err != nil {
		return err
	}
	h.drainPending(ctx, h.deps(), ch, row, 1, dev.String())
	return nil
}

// retryTracked is the retry loop's visit of one call with a repair outstanding or a slot held: it
// forgets everything of a call that ended (its DELETE could not take the lock) and the slots of an
// older room, and drives at most limit repairs, answering how many it attempted.
func (h *Calls) retryTracked(ctx context.Context, call id.ID, limit int) (int, error) {
	ctx, unlock, err := h.lock(ctx, call, callLockWait, callHoldBackground)
	if err != nil {
		return 0, err
	}
	defer unlock()
	row, err := h.repo.GetVoiceSession(ctx, call)
	if errors.Is(err, store.ErrNotFound) || (err == nil && row.Ended != nil) {
		h.leases.dropCall(call)
		return 0, nil
	}
	if err != nil {
		return 0, err
	}
	h.leases.dropStale(call, row.LivekitRoom)
	if len(h.leases.pendingOf(call)) == 0 || h.sfu == nil {
		return 0, nil
	}
	ch, err := h.repo.GetChannel(ctx, row.ChannelID)
	if err != nil {
		return 0, err
	}
	_, n := h.drainPending(ctx, h.deps(), ch, row, limit, "")
	return n, nil
}

// SweepRooms is the room sweep: it lists the SFU's rooms and, for each, under that call's lock,
// reconciles every participant of a live call's room (reconcileRoom: a barred device, or one that
// lost view_channel or connect, is cut; an identity that is no device is removed) and deletes a room
// that belongs to no call, to an ended call or to an older room of a live call — which is also the
// retry of a DeleteRoom that failed when the call ended. It is how a change written by another
// process (`dillad admin user disable`, an admin device revoke), a membership change whose own sync
// failed and a device admitted at /rtc just before it lost access converge without an event in the
// call. A pass visits at most maxRoomsPerSweep rooms within sweepPassBudget, going on from where the
// last pass stopped; each room's hold is bounded by callHoldBackground, and a busy call is left for
// the next pass. Passes never overlap.
func (h *Calls) SweepRooms(ctx context.Context) {
	if h.sfu == nil {
		return
	}
	h.sweepMu.Lock()
	defer h.sweepMu.Unlock()
	ctx, cancel := context.WithTimeout(ctx, sweepPassBudget)
	defer cancel()
	rooms, err := h.listRooms(ctx)
	if err != nil {
		h.log.WarnContext(ctx, "listing the SFU's rooms for the sweep failed", "err", err)
		return
	}
	if len(rooms) == 0 {
		return
	}
	slices.Sort(rooms)
	start := sort.SearchStrings(rooms, h.sweepCursor)
	if start < len(rooms) && rooms[start] == h.sweepCursor {
		start++
	}
	for i := 0; i < len(rooms) && i < maxRoomsPerSweep; i++ {
		if ctx.Err() != nil {
			return
		}
		room := rooms[(start+i)%len(rooms)]
		h.sweepCursor = room
		if err := h.sweepRoom(ctx, room, nil); err != nil {
			h.log.WarnContext(ctx, "sweeping a call room did not finish; the next pass retries it", "room", room, "err", err)
		}
	}
}

// CutDevice cuts device, and every "#" shadow of it, from every live call room the SFU holds it in,
// at once: the in-process revocation and quarantine paths call it after their commit. It runs the
// same reconcile as the sweep for those identities only, so a barred device is removed with its
// slot freed (pending when the SFU refuses), and a device that is not barred keeps exactly its
// current permission. It is bounded by cutDeviceBudget; what it does not reach the sweep covers.
func (h *Calls) CutDevice(ctx context.Context, device id.ID) {
	dev := device.String()
	h.cutMatching(ctx, func(identity string) bool {
		base, _, _ := strings.Cut(identity, "#")
		return base == dev
	})
}

// CutUser is CutDevice for every device of userID: the in-process admin disable calls it.
func (h *Calls) CutUser(ctx context.Context, userID id.ID) {
	if h.sfu == nil {
		return
	}
	devices, err := h.repo.ListDevicesByUser(ctx, userID)
	if err != nil {
		h.log.WarnContext(ctx, "listing a user's devices to cut them from calls failed; the room sweep covers it",
			"user", userID, "err", err)
		return
	}
	set := make(map[string]bool, len(devices))
	for _, d := range devices {
		set[d.ID.String()] = true
	}
	h.cutMatching(ctx, func(identity string) bool {
		base, _, _ := strings.Cut(identity, "#")
		return set[base]
	})
}

func (h *Calls) cutMatching(ctx context.Context, match func(string) bool) {
	if h.sfu == nil {
		return
	}
	ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), cutDeviceBudget)
	defer cancel()
	rooms, err := h.listRooms(ctx)
	if err != nil {
		h.log.WarnContext(ctx, "listing the SFU's rooms for a cut failed; the room sweep covers it", "err", err)
		return
	}
	for _, room := range rooms {
		if ctx.Err() != nil {
			return
		}
		if err := h.sweepRoom(ctx, room, match); err != nil {
			h.log.WarnContext(ctx, "cutting a device from a call room did not finish; the room sweep retries it",
				"room", room, "err", err)
		}
	}
}

func (h *Calls) listRooms(ctx context.Context) ([]string, error) {
	lctx, cancel := sfuCtx(ctx)
	defer cancel()
	return h.sfu.Rooms(lctx)
}

// sweepRoom is one room of the sweep (match nil) or of a cut (match set). A room named for no call,
// or for a call that has ended or moved to a newer room, is deleted by the sweep and left alone by a
// cut; a live call's room is reconciled under the call's lock, every participant (sweep) or those
// match accepts (cut).
func (h *Calls) sweepRoom(ctx context.Context, room string, match func(string) bool) error {
	callHex, _, ok := strings.Cut(room, "-")
	callID, perr := id.Parse(callHex)
	if !ok || perr != nil {
		if match != nil {
			return nil
		}
		return h.deleteRoom(ctx, room)
	}
	ctx, unlock, err := h.lock(ctx, callID, callLockWait, callHoldBackground)
	if err != nil {
		return err
	}
	defer unlock()
	row, err := h.repo.GetVoiceSession(ctx, callID)
	switch {
	case errors.Is(err, store.ErrNotFound):
		if match != nil {
			return nil
		}
		return h.deleteRoom(ctx, room)
	case err != nil:
		return err
	case row.Ended != nil || row.LivekitRoom != room:
		if row.Ended != nil {
			h.leases.dropCall(callID)
		} else {
			h.leases.dropStale(callID, row.LivekitRoom)
		}
		if match != nil {
			return nil
		}
		return h.deleteRoom(ctx, room)
	}
	ch, err := h.repo.GetChannel(ctx, row.ChannelID)
	if err != nil {
		return err
	}
	return h.reconcileRoom(ctx, h.deps(), ch, row, nil, nil, match)
}

// deleteRoom closes a room that belongs to no live call: everyone in it is disconnected, and with
// room.auto_create false nobody can rejoin it.
func (h *Calls) deleteRoom(ctx context.Context, room string) error {
	dctx, cancel := sfuCtx(ctx)
	defer cancel()
	if err := h.sfu.DeleteRoom(dctx, room); err != nil {
		return fmt.Errorf("delete the orphan room %s: %w", room, err)
	}
	h.log.InfoContext(ctx, "the room sweep closed a room that belongs to no live call", "room", room)
	return nil
}

// StartRetries runs the retry loop: every `every` it drives the calls' pending repairs (RetryPending)
// and, at most every RoomSweepInterval, sweeps the SFU's rooms (SweepRooms), on its own goroutine,
// so a slow or hung SFU never delays another maintenance duty. A pass never overlaps the next — a
// tick that comes while one runs is dropped — each SFU call is bounded by sfuCallTimeout, each hold
// of a call's lock by callHoldBackground, each pass by maxRepairsPerTick and the sweep's own bounds.
// stop ends the loop and waits for the pass in flight, which its cancelled context cuts short; the
// composition root calls it before the SFU stops.
func (h *Calls) StartRetries(every time.Duration) (stop func()) {
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	sweepEvery := h.sweepEvery
	go func() {
		defer close(done)
		tick := time.NewTicker(every)
		defer tick.Stop()
		var lastSweep time.Time
		for {
			select {
			case <-ctx.Done():
				return
			case <-tick.C:
				h.RetryPending(ctx)
				if time.Since(lastSweep) >= sweepEvery {
					h.SweepRooms(ctx)
					lastSweep = time.Now()
				}
				h.reportPending()
			}
		}
	}()
	var once sync.Once
	return func() {
		once.Do(func() {
			cancel()
			<-done
		})
	}
}
