package api

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/fxamacker/cbor/v2"
	"github.com/livekit/protocol/livekit"

	"github.com/jonasthim/dilla/internal/gateway"
	"github.com/jonasthim/dilla/internal/id"
	"github.com/jonasthim/dilla/internal/server"
	"github.com/jonasthim/dilla/internal/store"
)

// AFK means disconnected (AW2): a member who is away is listed under the community's AFK channel and
// has no voice connection. The instance stores the away roster per (community, user)
// (community_afk_away), announces every change with op 55 afk_away to the AFK channel's audience, and
// never hosts a call in the AFK channel (R-AW1).
//
// Away and calls never overlap (R-AW2): any admission of any device of the user clears every row of
// that user. A row is set by the sweep's cut when no other device of the user is in a call (R-AW3)
// and by PUT …/afk/away, which cuts every device of the user first. It is cleared by an admission,
// by a message or a typing op in that community (Q1), by the user's last gateway connection closing
// (Q2), and by leaving, a kick or a ban (the store's cascade). No client route clears it (Q3).
//
// Every write of the roster happens under awayMu together with its op 55, so the frames go out in
// the order the rows changed. The decision to mark is checked under afkMu against the admissions
// recorded since it was taken (afkAdmitSeq), and an admission records itself under afkMu BEFORE it
// takes awayMu to clear: so either the mark sees the admission and is skipped, or the admission's
// clear runs after the mark's write. The admission wins either way (R-AW7).

const (
	// afkAwaySnapshotMax caps the snapshot's away list (GET /v1/communities/{id}/afk, 5th element).
	afkAwaySnapshotMax = 1024
	// afkBootGrace is how long after a start the rows of users with no gateway connection are kept,
	// so reconnecting clients keep theirs (R-AW5).
	afkBootGrace = 60 * time.Second
	// afkAdmitMemory is how long a user's latest admission is remembered for the mark's checks.
	afkAdmitMemory = 10 * time.Minute
)

// afkAdmit is a user's latest admission: its number, the device and when (the instance clock).
type afkAdmit struct {
	seq uint64
	dev id.ID
	at  time.Time
}

// afkAwayEntry is one element of the snapshot's away list: [user_id, since_ts].
type afkAwayEntry struct {
	_       struct{} `cbor:",toarray"`
	UserID  id.ID
	SinceTS uint64
}

// AFKActivity is what the message routes report a user's activity in a channel to (Q1).
type AFKActivity interface {
	AFKActiveInChannel(ctx context.Context, user, channel id.ID)
}

// WithAFKAway sets where op 55 goes (the gateway's DeliverUser) and how to tell whether a user holds
// a live gateway connection, and returns h. A nil connected counts every user as connected.
func (h *Calls) WithAFKAway(gw VoiceGateway, connected func(id.ID) bool) *Calls {
	h.awayMu.Lock()
	defer h.awayMu.Unlock()
	h.awayGW, h.awayConnected = gw, connected
	return h
}

func (h *Calls) afkStage(stage string) {
	if f := h.afkHook; f != nil {
		f(stage)
	}
}

// connectedLocked reports whether user holds a gateway connection. The caller holds awayMu.
func (h *Calls) connectedLocked(user id.ID) bool {
	return h.awayConnected == nil || h.awayConnected(user)
}

// noteAFKAdmissionLocked records an admission of dev of user. The caller holds afkMu.
func (h *Calls) noteAFKAdmissionLocked(user, dev id.ID) {
	h.afkAdmitSeq++
	if h.afkAdmits == nil {
		h.afkAdmits = make(map[id.ID]afkAdmit)
	}
	h.afkAdmits[user] = afkAdmit{seq: h.afkAdmitSeq, dev: dev, at: h.clk.Now()}
}

// pruneAFKAdmitsLocked forgets admissions older than afkAdmitMemory. The caller holds afkMu.
func (h *Calls) pruneAFKAdmitsLocked() {
	for u, a := range h.afkAdmits {
		if h.clk.Since(a.at) >= afkAdmitMemory {
			delete(h.afkAdmits, u)
		}
	}
}

// afkDecision is the admission number a mark is decided at: an admission after it wins.
func (h *Calls) afkDecision() uint64 {
	h.afkMu.Lock()
	defer h.afkMu.Unlock()
	return h.afkAdmitSeq
}

// announceAway sends op 55 [community, user, since] to every user who may view the community's AFK
// channel (its EligibleUsers, the voice_state pattern). A community with no AFK channel, or a
// failure to read its audience, sends nothing: the snapshot is the record. The caller holds awayMu.
func (h *Calls) announceAway(ctx context.Context, cid, user id.ID, since uint64) {
	if h.awayGW == nil {
		return
	}
	cfg, err := h.repo.GetCommunityAFK(ctx, cid)
	if err != nil || cfg.ChannelID == nil {
		return
	}
	ch, err := h.repo.GetChannel(ctx, *cfg.ChannelID)
	if err != nil {
		return
	}
	audience, err := EligibleUsers(ctx, h.repo, ch)
	if err != nil {
		h.log.WarnContext(ctx, "resolving the AFK channel's audience for afk_away failed", "community", cid, "err", err)
		return
	}
	payload, err := gateway.AFKAwayPayload(cid, user, since)
	if err != nil {
		return
	}
	f := gateway.Frame{Op: gateway.OpAFKAway, Payload: payload}
	for _, u := range audience {
		h.awayGW.DeliverUser(u, f)
	}
}

// clearAwayUserLocked clears every away row of user and announces each. The caller holds awayMu.
func (h *Calls) clearAwayUserLocked(ctx context.Context, user id.ID) {
	cids, err := h.repo.ClearAFKAwayUser(ctx, user)
	if err != nil {
		h.log.WarnContext(ctx, "clearing a user's away rows failed", "user", user, "err", err)
		return
	}
	for _, cid := range cids {
		h.announceAway(ctx, cid, user, 0)
	}
}

// clearAwayIn clears user's away row in community cid, announcing it when there was one.
func (h *Calls) clearAwayIn(ctx context.Context, cid, user id.ID) {
	ctx = context.WithoutCancel(ctx)
	h.awayMu.Lock()
	defer h.awayMu.Unlock()
	cleared, err := h.repo.ClearAFKAway(ctx, cid, user)
	if err != nil {
		h.log.WarnContext(ctx, "clearing an away row failed", "community", cid, "user", user, "err", err)
		return
	}
	if cleared {
		h.announceAway(ctx, cid, user, 0)
	}
}

// AFKActiveInChannel is activity of user in channel (a readable post, a typing op, Q1): it clears the
// user's away row in the channel's community.
func (h *Calls) AFKActiveInChannel(ctx context.Context, user, channel id.ID) {
	ch, err := h.repo.GetChannel(ctx, channel)
	if err != nil || ch.CommunityID == nil {
		return
	}
	h.clearAwayIn(ctx, *ch.CommunityID, user)
}

// AFKActiveInGroup is an end-to-end encrypted upload by user into group (Q1): an upload into a
// community channel's text group clears the user's away row in that community; a DM's, a call
// group's or any other group's clears nothing.
func (h *Calls) AFKActiveInGroup(ctx context.Context, user, group id.ID) {
	g, err := h.repo.GetGroup(ctx, group)
	if err != nil || g.Kind != GroupText || g.CommunityID == nil {
		return
	}
	h.clearAwayIn(ctx, *g.CommunityID, user)
}

// AFKOffline is the gateway's hook for a user's last live connection closing (Q2): every away row of
// the user is cleared at once.
func (h *Calls) AFKOffline(ctx context.Context, user id.ID) {
	ctx = context.WithoutCancel(ctx)
	h.awayMu.Lock()
	defer h.awayMu.Unlock()
	h.clearAwayUserLocked(ctx, user)
}

// afkAdmissionClears is the admission's clear (R-AW2, R-AW4): Admitted records the admission under
// afkMu first (noteAFKAdmissionLocked) and calls this after releasing it; every row of the user goes.
func (h *Calls) afkAdmissionClears(ctx context.Context, user id.ID) {
	ctx = context.WithoutCancel(ctx)
	h.awayMu.Lock()
	defer h.awayMu.Unlock()
	h.clearAwayUserLocked(ctx, user)
}

// otherDeviceInCall reports whether a device of user other than except is in a call: admitted
// within the join window (the SFU may not list it yet), or listed by the SFU in any room.
func (h *Calls) otherDeviceInCall(ctx context.Context, user, except id.ID) (bool, error) {
	h.afkMu.Lock()
	a, ok := h.afkAdmits[user]
	h.afkMu.Unlock()
	if ok && a.dev != except && h.clk.Since(a.at) < admissionJoinWindow {
		return true, nil
	}
	if h.sfu == nil {
		return false, nil
	}
	devices, err := h.repo.ListDevicesByUser(ctx, user)
	if err != nil {
		return false, err
	}
	mine := make(map[string]bool, len(devices))
	for _, d := range devices {
		if d.ID != except {
			mine[d.ID.String()] = true
		}
	}
	if len(mine) == 0 {
		return false, nil
	}
	found := false
	err = h.eachUserParticipant(ctx, mine, func(string, string) bool {
		found = true
		return false
	})
	return found, err
}

// eachUserParticipant calls f(room, device) for every participant of every SFU room whose identity
// (before any "#" shadow suffix) is in devices, until f answers false.
func (h *Calls) eachUserParticipant(ctx context.Context, devices map[string]bool, f func(room, device string) bool) error {
	rooms, err := h.listRooms(ctx)
	if err != nil {
		return err
	}
	for _, room := range rooms {
		pctx, cancel := sfuCtx(ctx)
		parts, err := h.sfu.Participants(pctx, room)
		cancel()
		if err != nil {
			return err
		}
		for _, p := range parts {
			if p.GetState() == livekit.ParticipantInfo_DISCONNECTED {
				continue
			}
			base, _, _ := strings.Cut(p.GetIdentity(), "#")
			if devices[base] && !f(room, base) {
				return nil
			}
		}
	}
	return nil
}

// markAway marks user away in community cid since now, unless an admission of the user came after
// decided (R-AW7) or, with needConn, the user holds no gateway connection (Q2), and announces a row
// it wrote. It answers whether a row was written; ErrNotFound when the user is no member (a racing
// kick). Only the boot marks without needConn: nobody is connected yet, and the boot grace decides.
func (h *Calls) markAway(ctx context.Context, cid, user id.ID, decided uint64, needConn bool) (bool, error) {
	ctx = context.WithoutCancel(ctx)
	h.awayMu.Lock()
	defer h.awayMu.Unlock()
	h.afkMu.Lock()
	newer := h.afkAdmits[user].seq > decided
	h.afkMu.Unlock()
	if newer || (needConn && !h.connectedLocked(user)) {
		return false, nil
	}
	set, err := h.repo.SetAFKAway(ctx, cid, user, h.clk.Now().Unix())
	if err != nil {
		return false, err
	}
	if set {
		h.announceAway(ctx, cid, user, uint64(h.clk.Now().Unix())) //nolint:gosec // G115: the instance clock is after 1970
	}
	return set, nil
}

// sweepMarkAway is the sweep's mark after its cut of dev (R-AW3): only when no other device of the
// user is in a call. A failure leaves the user unmarked: the cut stands, and away never overlaps a
// call (R-AW2).
func (h *Calls) sweepMarkAway(ctx context.Context, tracked afkTracked, dev id.ID, decided uint64) {
	h.afkStage("cut")
	busy, err := h.otherDeviceInCall(ctx, tracked.user, dev)
	if err != nil {
		h.log.WarnContext(ctx, "checking a swept user's other devices failed; not marked away", "user", tracked.user, "err", err)
		return
	}
	if busy {
		return
	}
	if _, err := h.markAway(ctx, tracked.community, tracked.user, decided, true); err != nil && !errors.Is(err, store.ErrNotFound) {
		h.log.WarnContext(ctx, "marking a swept user away failed", "user", tracked.user, "err", err)
	}
}

// afkAway is PUT /v1/communities/{id}/afk/away `[]` (R-AW3, by choosing AFK): member-only. It cuts
// every device of the caller's user from every SFU room, then marks the user away in the community,
// keeping an earlier since. 204. There is no DELETE (Q3).
func (h *Calls) afkAway(w http.ResponseWriter, r *http.Request) {
	cid, user, _, err := h.afkMember(r)
	if err != nil {
		server.WriteError(w, err)
		return
	}
	var body []cbor.RawMessage
	if err := server.DecodeBody(w, r, maxCBORBody, &body); err != nil {
		server.WriteError(w, err)
		return
	}
	if len(body) != 0 {
		server.WriteError(w, server.Errorf(server.CodeInvalidRequest, "the body is []"))
		return
	}
	cfg, err := h.afkDestination(r.Context(), cid, user)
	if err != nil {
		server.WriteError(w, err)
		return
	}
	if cfg.ChannelID == nil {
		server.WriteError(w, server.Errorf(server.CodeNotFound, "this community has no AFK channel"))
		return
	}
	decided := h.afkDecision()
	if err := h.cutUserEverywhere(r.Context(), user); err != nil {
		h.log.ErrorContext(r.Context(), "cutting a user's devices for AFK failed", "user", user, "err", err)
		server.WriteError(w, server.Errorf(server.CodeInternal, "the SFU could not cut your devices"))
		return
	}
	h.afkStage("away-cut")
	if _, err := h.markAway(r.Context(), cid, user, decided, true); err != nil {
		server.WriteError(w, notFound(err))
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// cutUserEverywhere removes every device of user, with its "#" shadows, from every SFU room it is
// in, revokes its relay and stops its AFK timer.
func (h *Calls) cutUserEverywhere(ctx context.Context, user id.ID) error {
	if h.sfu == nil {
		return nil
	}
	devices, err := h.repo.ListDevicesByUser(ctx, user)
	if err != nil {
		return err
	}
	mine := make(map[string]bool, len(devices))
	for _, d := range devices {
		mine[d.ID.String()] = true
	}
	type cut struct{ room, dev string }
	var cuts []cut
	seen := map[cut]bool{}
	if err := h.eachUserParticipant(ctx, mine, func(room, dev string) bool {
		if c := (cut{room, dev}); !seen[c] {
			seen[c] = true
			cuts = append(cuts, c)
		}
		return true
	}); err != nil {
		return err
	}
	for _, c := range cuts {
		dev, err := id.Parse(c.dev)
		if err != nil {
			continue
		}
		rctx, cancel := sfuCtx(context.WithoutCancel(ctx))
		err = h.sfu.RemoveParticipants(rctx, c.room, dev)
		cancel()
		if err != nil {
			return err
		}
		h.revokeRelay(dev)
		h.afkMu.Lock()
		delete(h.afkTracked, dev)
		h.afkMu.Unlock()
	}
	return nil
}

// eachCommunity calls f for every live community, a page at a time.
func (h *Calls) eachCommunity(ctx context.Context, f func(store.CommunityRow)) error {
	var after id.ID
	for {
		page, err := h.repo.ListCommunities(ctx, after, afkBackfillPage)
		if err != nil {
			return err
		}
		for _, com := range page {
			f(com)
		}
		if len(page) < afkBackfillPage {
			return nil
		}
		after = page[len(page)-1].ID
	}
}

// EndAFKCalls is the boot step after EnsureAFKChannels (release note, R-AW1): every live call in a
// community's AFK channel ends, and every user with a device in its call group becomes away there,
// since now. It also starts the boot grace (R-AW5) that ClearDisconnectedAway waits out. It answers
// how many calls it ended. A failure for one call is logged and the others go on.
func (h *Calls) EndAFKCalls(ctx context.Context) (int, error) {
	h.awayMu.Lock()
	h.awayGraceUntil, h.awayGraceDone = h.clk.Now().Add(afkBootGrace), false
	h.awayMu.Unlock()
	n := 0
	err := h.eachCommunity(ctx, func(com store.CommunityRow) {
		cfg, err := h.repo.GetCommunityAFK(ctx, com.ID)
		if err != nil || cfg.ChannelID == nil {
			return
		}
		live, err := h.repo.ListLiveVoiceSessions(ctx, *cfg.ChannelID)
		if err != nil {
			h.log.ErrorContext(ctx, "listing the AFK channel's calls failed", "community", com.ID, "err", err)
			return
		}
		for _, row := range live {
			users := h.callUsers(ctx, row)
			if err := h.endCall(context.WithoutCancel(ctx), row.CallID, row.LivekitRoom, "afk_channel"); err != nil {
				h.log.ErrorContext(ctx, "ending a call in the AFK channel failed", "call_id", row.CallID, "err", err)
				continue
			}
			n++
			for _, u := range users {
				if _, err := h.markAway(ctx, com.ID, u, h.afkDecision(), false); err != nil && !errors.Is(err, store.ErrNotFound) {
					h.log.WarnContext(ctx, "marking an AFK call's user away failed", "user", u, "err", err)
				}
			}
		}
	})
	if n > 0 {
		h.log.InfoContext(ctx, "ended the calls in AFK channels; their users are away", "calls", n)
	}
	return n, err
}

// callUsers is the users with a current leaf in row's call group, each once.
func (h *Calls) callUsers(ctx context.Context, row store.VoiceSessionRow) []id.ID {
	if row.GroupID == nil {
		return nil
	}
	members, err := h.repo.ListMembers(ctx, *row.GroupID)
	if err != nil {
		h.log.WarnContext(ctx, "reading an AFK call's members failed", "call_id", row.CallID, "err", err)
		return nil
	}
	var out []id.ID
	seen := map[id.ID]bool{}
	for _, m := range members {
		if m.RemovedEpoch == nil && !seen[m.UserID] {
			seen[m.UserID] = true
			out = append(out, m.UserID)
		}
	}
	return out
}

// ClearDisconnectedAway runs on the maintenance tick. Once the boot grace has passed (R-AW5), it
// clears, once, the away rows of every user who holds no gateway connection, announcing each; before
// that, and ever after, it does nothing.
func (h *Calls) ClearDisconnectedAway(ctx context.Context) {
	h.awayMu.Lock()
	defer h.awayMu.Unlock()
	if h.awayGraceUntil.IsZero() || h.awayGraceDone || h.clk.Now().Before(h.awayGraceUntil) {
		return
	}
	h.awayGraceDone = true
	if h.awayConnected == nil {
		return
	}
	if err := h.eachCommunity(ctx, func(com store.CommunityRow) {
		rows, err := h.repo.ListAFKAway(ctx, com.ID)
		if err != nil {
			h.log.WarnContext(ctx, "reading an away roster after the boot grace failed", "community", com.ID, "err", err)
			return
		}
		for _, r := range rows {
			if h.awayConnected(r.UserID) {
				continue
			}
			if cleared, err := h.repo.ClearAFKAway(ctx, com.ID, r.UserID); err == nil && cleared {
				h.announceAway(ctx, com.ID, r.UserID, 0)
			}
		}
	}); err != nil {
		h.log.WarnContext(ctx, "listing the communities after the boot grace failed", "err", err)
	}
}

// awaySnapshot is the snapshot's away list of community cid, at most afkAwaySnapshotMax entries.
func (h *Calls) awaySnapshot(ctx context.Context, cid id.ID) ([]afkAwayEntry, error) {
	rows, err := h.repo.ListAFKAway(ctx, cid)
	if err != nil {
		return nil, err
	}
	if len(rows) > afkAwaySnapshotMax {
		rows = rows[:afkAwaySnapshotMax]
	}
	out := make([]afkAwayEntry, 0, len(rows))
	for _, r := range rows {
		out = append(out, afkAwayEntry{UserID: r.UserID, SinceTS: uint64(r.Since)}) //nolint:gosec // G115: a unix second this instance wrote
	}
	return out, nil
}

// isAFKChannel reports whether ch is its community's AFK channel (R-AW1). A pointer that cannot be
// read answers false: the listen-only grant (inAFK) stays the backstop.
func (h *Calls) isAFKChannel(ctx context.Context, ch store.ChannelRow) bool {
	if ch.CommunityID == nil {
		return false
	}
	cfg, err := h.repo.GetCommunityAFK(ctx, *ch.CommunityID)
	return err == nil && cfg.ChannelID != nil && *cfg.ChannelID == ch.ID
}

// errAFKCall is R-AW1's refusal.
func errAFKCall() error {
	return server.Errorf(server.CodeForbidden, "nobody joins a call in the AFK channel")
}
