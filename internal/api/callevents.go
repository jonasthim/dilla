package api

import (
	"context"
	"errors"
	"log/slog"
	"strings"
	"sync"
	"time"

	"github.com/livekit/protocol/livekit"
	"github.com/livekit/protocol/webhook"

	"github.com/jonasthim/dilla/internal/clock"
	"github.com/jonasthim/dilla/internal/id"
	"github.com/jonasthim/dilla/internal/store"
)

// LiveGauge is the live-call gauge the call events move; *obs.Metrics is one.
type LiveGauge interface {
	CallsLive(n int)
}

// proposeWindow is how long a mid-call leave's Remove proposal suppresses another for the same
// session of a device in the same room: the call-group proposal TTL (ds Policy.ProposalTTLCall). The
// delivery service dedupes against its own outstanding Remove as well (ProposeRemoveDevice).
const proposeWindow = 30 * time.Second

// evictTimeout bounds the SFU work of one eviction, which runs on the delivery service's caller's
// goroutine after the group lock is released.
const evictTimeout = 10 * time.Second

// CallEvents turns the SFU's webhooks into the call lifecycle (DEV-43…46, DEV-60, F11) and is the
// delivery service's call evictor (G29). It keeps, per live room, the devices LiveKit reported in it
// with their session id and published sources — only to compute voice_state flags, to tell a stale
// leave from a real one and to know whom to announce at the call's end; nothing here gates a join.
// Webhooks are lossy and can be ~45 s late (SP-21), so every decision that must hold without them —
// the /rtc join gate, the evictor, the room sweep, room.auto_create false — does not depend on this
// state. Every slot transition, permission push and removal goes through the Calls' per-call lock
// and its reconcile path, exactly as the routes' do (dilla-media task 10); a lock that cannot be
// taken leaves the work as a pending repair for the retry loop. Nothing here calls the delivery
// service while it holds a call's lock.
type CallEvents struct {
	repo  store.Repository
	res   *Resolver
	dsvc  DS
	sfu   CallTokens
	calls *Calls
	gw    VoiceGateway
	clk   clock.Clock
	log   *slog.Logger
	gauge LiveGauge

	mu       sync.Mutex
	rooms    map[string]*callRoom
	proposed map[string]time.Time // room + "/" + device + "/" + session → the last Remove proposed for a leave
}

type callRoom struct {
	devices map[id.ID]*callDevice
}

type callDevice struct {
	user   id.ID
	sid    string                         // LiveKit's participant session id at participant_joined
	tracks map[string]livekit.TrackSource // published track SID → source
}

// flags is the device's voice_state: in the call, plus video and screen while it publishes them.
func (d *callDevice) flags() uint64 {
	f := VoiceInCall
	for _, s := range d.tracks {
		switch s {
		case livekit.TrackSource_CAMERA:
			f |= VoiceVideo
		case livekit.TrackSource_SCREEN_SHARE:
			f |= VoiceScreen
		}
	}
	return f
}

func (d *callDevice) sharing() bool { return d.flags()&(VoiceVideo|VoiceScreen) != 0 }

// NewCallEvents builds the dispatcher over the same Calls the routes serve, and registers itself
// with it: DELETE /v1/calls/{call_id} and a start that finds a stale group end the call through the
// same state, closing the call group through dsvc and announcing the end to the devices seen here.
// sfu is the SFU calls drives (nil without one).
func NewCallEvents(repo store.Repository, res *Resolver, dsvc DS, sfu CallTokens, calls *Calls, gw VoiceGateway, clk clock.Clock, log *slog.Logger) *CallEvents {
	if log == nil {
		log = slog.New(slog.DiscardHandler)
	}
	c := &CallEvents{repo: repo, res: res, dsvc: dsvc, sfu: sfu, calls: calls, gw: gw, clk: clk, log: log,
		rooms: map[string]*callRoom{}, proposed: map[string]time.Time{}}
	calls.events, calls.dsvc = c, dsvc
	return c
}

// WithGauge sets the dilla_call_live gauge and returns c.
func (c *CallEvents) WithGauge(g LiveGauge) *CallEvents {
	c.gauge = g
	return c
}

// Handle dispatches one verified webhook (sfu.NewWebhookHandler's sink). Only an event for the live
// room of a call does anything: an event for an older room of the same call, or for a call already
// over, is dropped — in particular the participant_left LiveKit sends for every participant of a
// room it closes, which must not become a Remove of every leaf (G30).
func (c *CallEvents) Handle(ctx context.Context, ev *livekit.WebhookEvent) {
	room := ev.GetRoom().GetName()
	if room == "" {
		return
	}
	row, live, err := c.liveRow(ctx, room)
	if err != nil {
		c.log.ErrorContext(ctx, "reading the call of a LiveKit event failed", "event", ev.GetEvent(), "err", err)
		return
	}
	if !live {
		if ev.GetEvent() == webhook.EventRoomFinished {
			c.forget(room)
		}
		return
	}
	p := ev.GetParticipant()
	switch ev.GetEvent() {
	case webhook.EventRoomFinished:
		if err := c.calls.endCall(ctx, row.CallID, room, "room_finished"); err != nil {
			c.log.ErrorContext(ctx, "ending a call LiveKit closed failed", "call_id", row.CallID.String(), "err", err)
		}
	case webhook.EventParticipantJoined:
		c.joined(ctx, row, p.GetIdentity(), p.GetSid())
	case webhook.EventParticipantLeft, webhook.EventParticipantConnectionAborted:
		c.left(ctx, row, p.GetIdentity(), p.GetSid())
	case webhook.EventTrackPublished:
		c.trackPublished(ctx, row, p.GetIdentity(), ev.GetTrack())
	case webhook.EventTrackUnpublished:
		c.trackUnpublished(ctx, row, p.GetIdentity(), ev.GetTrack())
	}
}

// liveRow is the call whose live room is room: "<call_id hex>-…" naming a voice session that is
// not ended and whose livekit_room is room.
func (c *CallEvents) liveRow(ctx context.Context, room string) (store.VoiceSessionRow, bool, error) {
	callHex, _, ok := strings.Cut(room, "-")
	if !ok {
		return store.VoiceSessionRow{}, false, nil
	}
	callID, err := id.Parse(callHex)
	if err != nil {
		return store.VoiceSessionRow{}, false, nil //nolint:nilerr // a room that is no call's is dropped, not a failure
	}
	row, err := c.repo.GetVoiceSession(ctx, callID)
	if errors.Is(err, store.ErrNotFound) {
		return row, false, nil
	}
	if err != nil {
		return row, false, err
	}
	return row, row.Ended == nil && row.LivekitRoom == room, nil
}

func (c *CallEvents) roomLocked(room string) *callRoom {
	r := c.rooms[room]
	if r == nil {
		r = &callRoom{devices: map[id.ID]*callDevice{}}
		c.rooms[room] = r
	}
	return r
}

// liveLocked is the number of rooms with at least one device in them.
func (c *CallEvents) liveLocked() int {
	n := 0
	for _, r := range c.rooms {
		if len(r.devices) > 0 {
			n++
		}
	}
	return n
}

func (c *CallEvents) setGauge(n int) {
	if c.gauge != nil {
		c.gauge.CallsLive(n)
	}
}

func (c *CallEvents) forget(room string) {
	c.mu.Lock()
	delete(c.rooms, room)
	n := c.liveLocked()
	c.mu.Unlock()
	c.setGauge(n)
}

// userOf is the user dev belongs to, from the room's state when the device was seen joining.
func (c *CallEvents) userOf(ctx context.Context, room string, dev id.ID) (id.ID, error) {
	c.mu.Lock()
	if r := c.rooms[room]; r != nil {
		if d := r.devices[dev]; d != nil {
			c.mu.Unlock()
			return d.user, nil
		}
	}
	c.mu.Unlock()
	d, err := c.repo.GetDevice(ctx, dev)
	if err != nil {
		return id.Zero, err
	}
	return d.UserID, nil
}

// joined: the participant is in the call. It is reconciled under the call's lock — its current
// grant pushed again (a token minted before a role change joins with a stale one, G26; a device
// demoted for a non-dilla track stays demoted, F11), or cut when it is barred, lost access or is no
// current leaf (the seconds between the /rtc gate's admission and LiveKit's join that the room sweep
// would otherwise leave) — and, unless it was cut, in_call is announced.
func (c *CallEvents) joined(ctx context.Context, row store.VoiceSessionRow, identity, sid string) {
	if identity == "" {
		return
	}
	cut, err := c.calls.reconcileJoiner(ctx, row, identity)
	if err != nil {
		c.log.WarnContext(ctx, "reconciling a joined participant did not finish; the retry loop goes on",
			"room", row.LivekitRoom, "identity", identity, "err", err)
	}
	dev, perr := id.Parse(identity)
	if perr != nil || cut {
		return
	}
	d, err := c.repo.GetDevice(ctx, dev)
	if err != nil {
		c.log.WarnContext(ctx, "a joined participant's device is unknown", "device_id", dev.String(), "err", err)
		return
	}
	ch, err := c.repo.GetChannel(ctx, row.ChannelID)
	if err != nil {
		c.log.ErrorContext(ctx, "reading a call's channel failed", "err", err)
		return
	}
	c.mu.Lock()
	r := c.roomLocked(row.LivekitRoom)
	r.devices[dev] = &callDevice{user: d.UserID, sid: sid, tracks: map[string]livekit.TrackSource{}}
	n := c.liveLocked()
	c.mu.Unlock()
	c.setGauge(n)
	c.announce(ctx, ch, row.CallID, d.UserID, dev, VoiceInCall)
}

// staleLeave reports whether a leave of identity's session sid is about a session the device has
// already replaced (SP-21 row 8: a webhook can arrive ~45 s late, behind a rejoin): the SFU holds
// the identity now under another session, or under any session when the event names none. When the
// SFU cannot list the room, the session recorded at participant_joined decides.
func (c *CallEvents) staleLeave(ctx context.Context, row store.VoiceSessionRow, dev id.ID, identity, sid string) bool {
	if c.sfu != nil {
		lctx, cancel := sfuCtx(ctx)
		parts, err := c.sfu.Participants(lctx, row.LivekitRoom)
		cancel()
		if err == nil {
			for _, p := range parts {
				if p.GetIdentity() == identity && (sid == "" || p.GetSid() != sid) {
					return true
				}
			}
			return false
		}
		c.log.WarnContext(ctx, "listing a call room to check a leave failed; the recorded session decides",
			"room", row.LivekitRoom, "err", err)
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if r := c.rooms[row.LivekitRoom]; r != nil {
		if d := r.devices[dev]; d != nil {
			return d.sid != "" && sid != "" && d.sid != sid
		}
	}
	return false
}

// left: the device is out of the room mid-call. A leave of a session the device has already
// replaced changes nothing. Otherwise its sharing slot goes under the call's lock (reconcile with
// the slot dropped: nothing to push for a participant the SFU no longer holds), the delivery service
// is asked — after the lock is released — to Remove its leaf from the call group (DEV-45; a
// duplicate inside the proposal TTL proposes nothing more, and the delivery service issues its
// Remove whether or not the device posted its own), and flags 0 is announced. A "#" shadow's leave
// says nothing about the device itself.
func (c *CallEvents) left(ctx context.Context, row store.VoiceSessionRow, identity, sid string) {
	if strings.Contains(identity, "#") {
		return
	}
	dev, err := id.Parse(identity)
	if err != nil {
		return
	}
	if c.staleLeave(ctx, row, dev, identity, sid) {
		c.log.InfoContext(ctx, "dropped a leave of a session the device has replaced", "room", row.LivekitRoom,
			"device_id", dev.String())
		return
	}
	if err := c.calls.releaseDeparted(ctx, row, identity); err != nil {
		c.log.WarnContext(ctx, "freeing a departed device's slot did not finish; the retry loop goes on",
			"room", row.LivekitRoom, "device_id", dev.String(), "err", err)
	}
	key := row.LivekitRoom + "/" + identity + "/" + sid
	now := c.clk.Now()
	c.mu.Lock()
	var user id.ID
	known := false
	if r := c.rooms[row.LivekitRoom]; r != nil {
		if d := r.devices[dev]; d != nil && (d.sid == "" || sid == "" || d.sid == sid) {
			user, known = d.user, true
			delete(r.devices, dev)
		}
	}
	propose := now.Sub(c.proposed[key]) >= proposeWindow
	if propose {
		c.proposed[key] = now
	}
	for k, at := range c.proposed {
		if now.Sub(at) >= proposeWindow {
			delete(c.proposed, k)
		}
	}
	n := c.liveLocked()
	c.mu.Unlock()
	c.setGauge(n)
	if propose && row.GroupID != nil && c.dsvc != nil {
		if err := c.dsvc.ProposeRemoveDevice(ctx, *row.GroupID, dev, id.New()); err != nil {
			c.log.WarnContext(ctx, "proposing the Remove of a device that left a call failed",
				"group_id", row.GroupID.String(), "device_id", dev.String(), "err", err)
		}
	}
	if !known {
		if user, err = c.userOf(ctx, row.LivekitRoom, dev); err != nil {
			c.log.WarnContext(ctx, "a departed participant's device is unknown", "device_id", dev.String(), "err", err)
			return
		}
	}
	ch, err := c.repo.GetChannel(ctx, row.ChannelID)
	if err != nil {
		c.log.ErrorContext(ctx, "reading a call's channel failed", "err", err)
		return
	}
	c.announce(ctx, ch, row.CallID, user, dev, 0)
}

// notDillaMedia is F11's test: a track the SFU flags unencrypted, or whose kind is not its declared
// source's. Encryption GCM and CUSTOM both mean dilla-sframe/1 — the test is != NONE, never == GCM.
func notDillaMedia(t *livekit.TrackInfo) bool {
	if t.GetEncryption() == livekit.Encryption_NONE {
		return true
	}
	switch t.GetSource() {
	case livekit.TrackSource_MICROPHONE, livekit.TrackSource_SCREEN_SHARE_AUDIO:
		return t.GetType() != livekit.TrackType_AUDIO
	case livekit.TrackSource_CAMERA, livekit.TrackSource_SCREEN_SHARE:
		return t.GetType() != livekit.TrackType_VIDEO
	default:
		return true
	}
}

// trackPublished: a dilla track updates the device's flags; any other (F11) strikes the device in
// the call's room. The first strike demotes it to a complete listen-only permission — which
// unpublishes every track it has, and holds for the room's life because every path that computes
// its permission (reconcile, the token mint, the /rtc gate) honours the strike — and a repeat
// removes it from the room. MutePublishedTrack is never used: a client can unmute itself.
func (c *CallEvents) trackPublished(ctx context.Context, row store.VoiceSessionRow, identity string, t *livekit.TrackInfo) {
	dev, err := id.Parse(identity)
	if err != nil || t == nil {
		return
	}
	if notDillaMedia(t) {
		strikes, err := c.calls.penalise(ctx, row, dev)
		c.log.WarnContext(ctx, "a published track is not dilla-sframe/1 or not of its declared kind",
			"room", row.LivekitRoom, "device_id", dev.String(), "track", t.GetSid(), "source", t.GetSource().String(),
			"type", t.GetType().String(), "encryption", t.GetEncryption().String(), "strikes", strikes)
		if err != nil {
			c.log.ErrorContext(ctx, "demoting or removing a device for a non-dilla track did not land; it stays pending",
				"room", row.LivekitRoom, "device_id", dev.String(), "err", err)
		}
		return
	}
	c.updateTracks(ctx, row, dev, func(d *callDevice) { d.tracks[t.GetSid()] = t.GetSource() })
}

// trackUnpublished clears the track from the device's flags; when the device's last camera or screen
// track stopped and it holds a sharing slot, the slot is released through the routes' own unshare
// path — demotion first, under the call's lock (ruling F1).
func (c *CallEvents) trackUnpublished(ctx context.Context, row store.VoiceSessionRow, identity string, t *livekit.TrackInfo) {
	dev, err := id.Parse(identity)
	if err != nil || t == nil {
		return
	}
	stopped := c.updateTracks(ctx, row, dev, func(d *callDevice) { delete(d.tracks, t.GetSid()) })
	if !stopped || !c.calls.leases.held(row.CallID, row.LivekitRoom, dev) {
		return
	}
	ch, err := c.repo.GetChannel(ctx, row.ChannelID)
	if err != nil {
		return
	}
	if err := c.calls.releaseShare(ctx, ch, row, dev); err != nil {
		c.log.WarnContext(ctx, "releasing the slot of a device that stopped sharing failed", "err", err)
	}
}

// updateTracks applies change to the device's published tracks, announces the new flags, and reports
// whether the device stopped sharing with this change.
func (c *CallEvents) updateTracks(ctx context.Context, row store.VoiceSessionRow, dev id.ID, change func(*callDevice)) bool {
	user, err := c.userOf(ctx, row.LivekitRoom, dev)
	if err != nil {
		c.log.WarnContext(ctx, "a publishing participant's device is unknown", "device_id", dev.String(), "err", err)
		return false
	}
	c.mu.Lock()
	r := c.roomLocked(row.LivekitRoom)
	d := r.devices[dev]
	if d == nil {
		d = &callDevice{user: user, tracks: map[string]livekit.TrackSource{}}
		r.devices[dev] = d
	}
	was := d.sharing()
	change(d)
	flags, stopped := d.flags(), was && !d.sharing()
	n := c.liveLocked()
	c.mu.Unlock()
	c.setGauge(n)
	ch, err := c.repo.GetChannel(ctx, row.ChannelID)
	if err != nil {
		c.log.ErrorContext(ctx, "reading a call's channel failed", "err", err)
		return stopped
	}
	c.announce(ctx, ch, row.CallID, user, dev, flags)
	return stopped
}

// Evict is the delivery service's call evictor (ds.CallEvictor, G29): it runs after a commit, a heal
// or a registry replacement removed devices from a call group, outside the group's lock. Each device
// is removed from the call's live room with its "#" shadows at once — not when LiveKit would next
// refresh its token — under the call's lock, loses its sharing slot, and is announced out; a removal
// the SFU does not take is a pending cut the retry loop repeats. The /rtc gate refuses its rejoin
// from then on, because it is no longer a current leaf, and the room sweep cuts a non-leaf too.
func (c *CallEvents) Evict(ctx context.Context, groupID id.ID, removed []id.ID) {
	ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), evictTimeout)
	defer cancel()
	g, err := c.repo.GetGroup(ctx, groupID)
	if err != nil {
		c.log.WarnContext(ctx, "reading an evicting group failed", "group_id", groupID.String(), "err", err)
		return
	}
	row, err := c.repo.GetVoiceSession(ctx, callIDOfGroup(g))
	if err != nil {
		if !errors.Is(err, store.ErrNotFound) {
			c.log.WarnContext(ctx, "reading an evicting group's call failed", "group_id", groupID.String(), "err", err)
		}
		return
	}
	if row.Ended != nil || row.GroupID == nil || *row.GroupID != groupID {
		return
	}
	if err := c.calls.evictDevices(ctx, row, removed); err != nil {
		c.log.ErrorContext(ctx, "evicting removed devices from their call's room did not land; it stays pending",
			"room", row.LivekitRoom, "err", err)
	}
	ch, chErr := c.repo.GetChannel(ctx, row.ChannelID)
	for _, dev := range removed {
		c.mu.Lock()
		var user id.ID
		known := false
		if r := c.rooms[row.LivekitRoom]; r != nil {
			if d := r.devices[dev]; d != nil {
				user, known = d.user, true
				delete(r.devices, dev)
			}
		}
		n := c.liveLocked()
		c.mu.Unlock()
		c.setGauge(n)
		if known && chErr == nil {
			c.announce(ctx, ch, row.CallID, user, dev, 0)
		}
	}
}

// ended is endCall's last step: every device seen in the room is announced out and the room's
// state dropped.
func (c *CallEvents) ended(ctx context.Context, row store.VoiceSessionRow) {
	c.mu.Lock()
	r := c.rooms[row.LivekitRoom]
	delete(c.rooms, row.LivekitRoom)
	n := c.liveLocked()
	c.mu.Unlock()
	c.setGauge(n)
	if r == nil || len(r.devices) == 0 {
		return
	}
	ch, err := c.repo.GetChannel(ctx, row.ChannelID)
	if err != nil {
		c.log.ErrorContext(ctx, "reading an ended call's channel failed", "err", err)
		return
	}
	for dev, d := range r.devices {
		c.announce(ctx, ch, row.CallID, d.user, dev, 0)
	}
}

// --- the Calls side: every step below runs under the call's lock, or leaves a pending repair. ---

// eventLocked takes row's call lock for one webhook's work — waiting at most callLockWait, so the
// receiver's single worker never queues long behind a stuck call — and re-reads the call: live is
// false when it ended or moved to a newer room. On a lock that cannot be taken, onBusy records the
// work as a pending repair for the retry loop.
func (h *Calls) eventLocked(ctx context.Context, row store.VoiceSessionRow, hold time.Duration, onBusy func()) (
	context.Context, func(), store.VoiceSessionRow, store.ChannelRow, bool, error) {
	lctx, unlock, err := h.lock(ctx, row.CallID, callLockWait, hold)
	if err != nil {
		onBusy()
		h.reportPending()
		return nil, nil, row, store.ChannelRow{}, false, err
	}
	cur, live, err := h.liveRow(lctx, h.repo, row)
	if err != nil || !live {
		unlock()
		return nil, nil, cur, store.ChannelRow{}, false, err
	}
	ch, err := h.repo.GetChannel(lctx, cur.ChannelID)
	if err != nil {
		unlock()
		return nil, nil, cur, ch, false, err
	}
	return lctx, unlock, cur, ch, true, nil
}

// settle reconciles one participant under the call's lock, honouring a pending cut of it (which a
// reconcile must not turn into a permission push), and reports whether it was cut.
func (h *Calls) settle(ctx context.Context, ch store.ChannelRow, row store.VoiceSessionRow, identity string, dropSlot bool) (bool, error) {
	d := h.deps()
	if r, ok := h.leases.pendingOf(row.CallID)[identity]; ok && r.Cut && r.Room == row.LivekitRoom {
		if dev, err := id.Parse(identity); err == nil {
			return true, h.removeDevice(ctx, d, row, dev, true)
		}
	}
	return h.reconcileOutcome(ctx, d, ch, row, identity, nil, dropSlot)
}

// reconcileJoiner reconciles a participant LiveKit reports joined and reports whether it was cut.
func (h *Calls) reconcileJoiner(ctx context.Context, row store.VoiceSessionRow, identity string) (bool, error) {
	if h.sfu == nil {
		return false, nil
	}
	lctx, unlock, cur, ch, live, err := h.eventLocked(ctx, row, callHoldRequest, func() {
		h.leases.markPending(row.CallID, identity, pendingRepair{Room: row.LivekitRoom})
	})
	if err != nil || !live {
		return false, err
	}
	defer unlock()
	return h.settle(lctx, ch, cur, identity, false)
}

// releaseDeparted frees the slot of a participant LiveKit reports gone: a reconcile with the slot
// dropped, which pushes the demotion first should the SFU somehow still hold it and only frees the
// slot when it does not.
func (h *Calls) releaseDeparted(ctx context.Context, row store.VoiceSessionRow, identity string) error {
	if h.sfu == nil {
		return nil // no SFU, no webhooks and no slot a share could have taken
	}
	lctx, unlock, cur, ch, live, err := h.eventLocked(ctx, row, callHoldRequest, func() {
		h.leases.markPending(row.CallID, identity, pendingRepair{Room: row.LivekitRoom, DropSlot: true})
	})
	if err != nil || !live {
		return err
	}
	defer unlock()
	_, err = h.settle(lctx, ch, cur, identity, true)
	return err
}

// penalise counts one F11 strike of dev in row's room and enforces it: the first demotes the device
// to listen-only through reconcile (which honours the strike from then on), a repeat removes it from
// the room as a cut a retry repeats. A lock that cannot be taken still records the strike and leaves
// the demotion or removal pending for the retry loop.
func (h *Calls) penalise(ctx context.Context, row store.VoiceSessionRow, dev id.ID) (int, error) {
	strikes := 0
	lctx, unlock, cur, ch, live, err := h.eventLocked(ctx, row, callHoldRequest, func() {
		strikes = h.leases.strike(row.CallID, row.LivekitRoom, dev)
		h.leases.markPending(row.CallID, dev.String(), pendingRepair{Room: row.LivekitRoom, DropSlot: true, Cut: strikes > 1})
	})
	if err != nil || !live {
		return strikes, err
	}
	defer unlock()
	strikes = h.leases.strike(cur.CallID, cur.LivekitRoom, dev)
	if h.sfu == nil {
		return strikes, nil
	}
	if strikes == 1 {
		_, err = h.settle(lctx, ch, cur, dev.String(), true)
		return strikes, err
	}
	return strikes, h.removeDevice(lctx, h.deps(), cur, dev, true)
}

// evictDevices removes devices a commit took out of row's call group from the call's room, each
// with its "#" shadows, and frees their slots. A removal the SFU does not take, or a lock that
// cannot be taken, is a pending cut the retry loop repeats; the gate refuses the device meanwhile.
func (h *Calls) evictDevices(ctx context.Context, row store.VoiceSessionRow, devices []id.ID) error {
	if h.sfu == nil || len(devices) == 0 {
		return nil
	}
	lctx, unlock, cur, _, live, err := h.eventLocked(ctx, row, callHoldBackground, func() {
		for _, dev := range devices {
			h.leases.markPending(row.CallID, dev.String(), pendingRepair{Room: row.LivekitRoom, DropSlot: true, Cut: true})
		}
	})
	if err != nil || !live {
		return err
	}
	defer unlock()
	var errs []error
	d := h.deps()
	for _, dev := range devices {
		if err := lctx.Err(); err != nil {
			h.leases.markPending(cur.CallID, dev.String(), pendingRepair{Room: cur.LivekitRoom, DropSlot: true, Cut: true})
			errs = append(errs, err)
			continue
		}
		errs = append(errs, h.removeDevice(lctx, d, cur, dev, true))
	}
	return errors.Join(errs...)
}
