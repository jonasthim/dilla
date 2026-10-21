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
// (Q2), and by leaving, a kick or a ban (the store's cascade, announced by AFKMemberRemoved). No
// client route clears it (Q3).
//
// Locks. awayMu guards the roster's writes and awaySet, the in-memory index of who may be away: a
// user with no entry is never away, so typing, uploads, posts and admissions of everyone else are a
// map lookup with no store call (fix round 1, I1). The set is a superset of the stored rows (a
// cascade leaves a stale entry, which the next clear drops), exact while one process serves the
// database, and seeded at boot; until it is seeded every user may be away. op 55 is sent with awayMu
// released: a writer takes awaySendMu before it lets awayMu go and resolves the audience under
// awaySendMu alone, so the frames still go out in the order the rows changed and nobody else's
// activity waits on an O(members) audience read.
//
// The decision to mark is checked under afkMu against the admissions recorded since it was taken
// (afkAdmitSeq), and an admission records itself under afkMu BEFORE it takes awayMu to clear: so
// either the mark sees the admission and is skipped, or the admission's clear runs after the mark's
// write. The admission wins either way (R-AW7). Lock order: awayMu, then afkMu or awaySendMu.

const (
	// afkAwaySnapshotMax caps the snapshot's away list (GET /v1/communities/{id}/afk, 5th element).
	afkAwaySnapshotMax = 1024
	// afkBootGrace is how long after a start the rows of users with no gateway connection are kept,
	// so reconnecting clients keep theirs (R-AW5).
	afkBootGrace = 60 * time.Second
	// afkAdmitMemory is how long a device's latest admission is remembered for the mark's checks.
	afkAdmitMemory = 10 * time.Minute
)

// afkAdmit is a device's latest admission: its number and when (the instance clock).
type afkAdmit struct {
	seq uint64
	at  time.Time
}

// afkAwayEntry is one element of the snapshot's away list: [user_id, since_ts].
type afkAwayEntry struct {
	_       struct{} `cbor:",toarray"`
	UserID  id.ID
	SinceTS uint64
}

// awayNote is one op 55 to send: [community, user, since].
type awayNote struct {
	community, user id.ID
	since           uint64
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

// mayBeAwayLocked reports whether user may hold an away row (in cid, when it is set). Before the set
// is seeded everyone may. The caller holds awayMu.
func (h *Calls) mayBeAwayLocked(user id.ID, cid *id.ID) bool {
	if !h.awaySeeded {
		return true
	}
	cs := h.awaySet[user]
	if cid == nil {
		return len(cs) > 0
	}
	_, ok := cs[*cid]
	return ok
}

// mayBeAway is mayBeAwayLocked for any community, taking awayMu for the lookup alone.
func (h *Calls) mayBeAway(user id.ID) bool {
	h.awayMu.Lock()
	defer h.awayMu.Unlock()
	return h.mayBeAwayLocked(user, nil)
}

func (h *Calls) noteAwayLocked(user, cid id.ID) {
	if h.awaySet == nil {
		h.awaySet = make(map[id.ID]map[id.ID]struct{})
	}
	if h.awaySet[user] == nil {
		h.awaySet[user] = make(map[id.ID]struct{})
	}
	h.awaySet[user][cid] = struct{}{}
}

func (h *Calls) dropAwayLocked(user, cid id.ID) {
	if cs := h.awaySet[user]; cs != nil {
		delete(cs, cid)
		if len(cs) == 0 {
			delete(h.awaySet, user)
		}
	}
}

// releaseAway lets awayMu go and sends notes in order, with awayMu released (see the file comment).
// The caller holds awayMu; it is released on return.
func (h *Calls) releaseAway(ctx context.Context, notes []awayNote) {
	if len(notes) == 0 || h.awayGW == nil {
		h.awayMu.Unlock()
		return
	}
	gw := h.awayGW
	h.awaySendMu.Lock()
	h.awayMu.Unlock()
	defer h.awaySendMu.Unlock()
	for _, n := range notes {
		h.sendAway(ctx, gw, n)
	}
}

// sendAway sends op 55 to every user who may view the community's AFK channel (its EligibleUsers,
// the voice_state pattern). A community with no AFK channel, or a failure to read its audience,
// sends nothing: the snapshot is the record.
func (h *Calls) sendAway(ctx context.Context, gw VoiceGateway, n awayNote) {
	cfg, err := h.repo.GetCommunityAFK(ctx, n.community)
	if err != nil || cfg.ChannelID == nil {
		return
	}
	ch, err := h.repo.GetChannel(ctx, *cfg.ChannelID)
	if err != nil {
		return
	}
	audience, err := EligibleUsers(ctx, h.repo, ch)
	if err != nil {
		h.log.WarnContext(ctx, "resolving the AFK channel's audience for afk_away failed", "community", n.community, "err", err)
		return
	}
	payload, err := gateway.AFKAwayPayload(n.community, n.user, n.since)
	if err != nil {
		return
	}
	f := gateway.Frame{Op: gateway.OpAFKAway, Payload: payload}
	for _, u := range audience {
		gw.DeliverUser(u, f)
	}
}

// noteAFKAdmissionLocked records an admission of dev of user. The caller holds afkMu.
func (h *Calls) noteAFKAdmissionLocked(user, dev id.ID) {
	h.afkAdmitSeq++
	if h.afkAdmits == nil {
		h.afkAdmits = make(map[id.ID]map[id.ID]afkAdmit)
	}
	if h.afkAdmits[user] == nil {
		h.afkAdmits[user] = make(map[id.ID]afkAdmit)
	}
	h.afkAdmits[user][dev] = afkAdmit{seq: h.afkAdmitSeq, at: h.clk.Now()}
}

// latestAdmitSeqLocked is the number of the user's latest admission, 0 for none. The caller holds
// afkMu.
func (h *Calls) latestAdmitSeqLocked(user id.ID) uint64 {
	var seq uint64
	for _, a := range h.afkAdmits[user] {
		seq = max(seq, a.seq)
	}
	return seq
}

// pruneAFKAdmitsLocked forgets admissions older than afkAdmitMemory. The caller holds afkMu.
func (h *Calls) pruneAFKAdmitsLocked() {
	for u, devs := range h.afkAdmits {
		for d, a := range devs {
			if h.clk.Since(a.at) >= afkAdmitMemory {
				delete(devs, d)
			}
		}
		if len(devs) == 0 {
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

// clearAwayUser clears every away row of user and announces each. A user not in the set is a map
// lookup.
func (h *Calls) clearAwayUser(ctx context.Context, user id.ID) {
	ctx = context.WithoutCancel(ctx)
	h.awayMu.Lock()
	if !h.mayBeAwayLocked(user, nil) {
		h.awayMu.Unlock()
		return
	}
	cids, err := h.repo.ClearAFKAwayUser(ctx, user)
	if err != nil {
		h.awayMu.Unlock()
		h.log.WarnContext(ctx, "clearing a user's away rows failed", "user", user, "err", err)
		return
	}
	delete(h.awaySet, user)
	notes := make([]awayNote, 0, len(cids))
	for _, cid := range cids {
		notes = append(notes, awayNote{community: cid, user: user})
	}
	h.releaseAway(ctx, notes)
}

// clearAwayIn clears user's away row in community cid, announcing it when there was one.
func (h *Calls) clearAwayIn(ctx context.Context, cid, user id.ID) {
	ctx = context.WithoutCancel(ctx)
	h.awayMu.Lock()
	if !h.mayBeAwayLocked(user, &cid) {
		h.awayMu.Unlock()
		return
	}
	cleared, err := h.repo.ClearAFKAway(ctx, cid, user)
	if err != nil {
		h.awayMu.Unlock()
		h.log.WarnContext(ctx, "clearing an away row failed", "community", cid, "user", user, "err", err)
		return
	}
	h.dropAwayLocked(user, cid)
	var notes []awayNote
	if cleared {
		notes = []awayNote{{community: cid, user: user}}
	}
	h.releaseAway(ctx, notes)
}

// AFKActiveInChannel is activity of user in channel (a readable post, a typing op, Q1): it clears the
// user's away row in the channel's community. A user who is not away is a map lookup.
func (h *Calls) AFKActiveInChannel(ctx context.Context, user, channel id.ID) {
	if !h.mayBeAway(user) {
		return
	}
	ch, err := h.repo.GetChannel(ctx, channel)
	if err != nil || ch.CommunityID == nil {
		return
	}
	h.clearAwayIn(ctx, *ch.CommunityID, user)
}

// AFKActiveInGroup is an end-to-end encrypted upload by user into group (Q1): an upload into a
// community channel's text group clears the user's away row in that community; a DM's, a call
// group's or any other group's clears nothing. A user who is not away is a map lookup.
func (h *Calls) AFKActiveInGroup(ctx context.Context, user, group id.ID) {
	if !h.mayBeAway(user) {
		return
	}
	g, err := h.repo.GetGroup(ctx, group)
	if err != nil || g.Kind != GroupText || g.CommunityID == nil {
		return
	}
	h.clearAwayIn(ctx, *g.CommunityID, user)
}

// AFKOffline is the gateway's hook for a user's last live connection closing (Q2): every away row of
// the user is cleared at once.
func (h *Calls) AFKOffline(ctx context.Context, user id.ID) {
	h.clearAwayUser(ctx, user)
}

// afkAdmissionClears is the admission's clear (R-AW2, R-AW4): Admitted records the admission under
// afkMu first (noteAFKAdmissionLocked) and calls this after releasing it; every row of the user goes.
func (h *Calls) afkAdmissionClears(ctx context.Context, user id.ID) {
	h.clearAwayUser(ctx, user)
}

// AFKMemberRemoved runs after a leave, a kick or a ban (M6): the membership's cascade dropped the
// user's away row in cid, and the remaining audience is told with op 55 since 0. A user who is still
// a member (a ban of a non-member, a failed removal) or who was not away sends nothing.
func (h *Calls) AFKMemberRemoved(ctx context.Context, cid, user id.ID) {
	if h == nil {
		return
	}
	ctx = context.WithoutCancel(ctx)
	if _, err := h.repo.GetMember(ctx, cid, user); err == nil || !errors.Is(err, store.ErrNotFound) {
		return
	}
	h.awayMu.Lock()
	if !h.mayBeAwayLocked(user, &cid) {
		h.awayMu.Unlock()
		return
	}
	h.dropAwayLocked(user, cid)
	h.releaseAway(ctx, []awayNote{{community: cid, user: user}})
}

// otherDeviceInCall reports whether a device of user other than except is in a call: admitted
// within the join window (the SFU may not list it yet), or listed by the SFU in any room.
func (h *Calls) otherDeviceInCall(ctx context.Context, user, except id.ID) (bool, error) {
	h.afkMu.Lock()
	joining := false
	for dev, a := range h.afkAdmits[user] {
		if dev != except && h.clk.Since(a.at) < admissionJoinWindow {
			joining = true
			break
		}
	}
	h.afkMu.Unlock()
	if joining {
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
// it wrote with the since it stored. It answers whether a row was written; ErrNotFound when the user
// is no member (a racing kick). Only the boot marks without needConn: nobody is connected yet, and
// the boot grace decides.
func (h *Calls) markAway(ctx context.Context, cid, user id.ID, decided uint64, needConn bool) (bool, error) {
	ctx = context.WithoutCancel(ctx)
	h.awayMu.Lock()
	h.afkMu.Lock()
	newer := h.latestAdmitSeqLocked(user) > decided
	h.afkMu.Unlock()
	if newer || (needConn && !h.connectedLocked(user)) {
		h.awayMu.Unlock()
		return false, nil
	}
	h.afkStage("mark-checked")
	now := h.clk.Now().Unix()
	set, err := h.repo.SetAFKAway(ctx, cid, user, now)
	if err != nil {
		h.awayMu.Unlock()
		return false, err
	}
	h.noteAwayLocked(user, cid)
	var notes []awayNote
	if set {
		notes = []awayNote{{community: cid, user: user, since: uint64(now)}} //nolint:gosec // G115: the instance clock is after 1970
	}
	h.releaseAway(ctx, notes)
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

// SeedAFKAway loads the in-memory away index from the stored roster (I1), one community at a time
// and without holding awayMu across the walk. It merges into what marks wrote meanwhile; a clear
// that raced it can leave a stale entry, which is safe (the index is a superset). Until it succeeds
// every user may be away and the clears go to the store.
func (h *Calls) SeedAFKAway(ctx context.Context) error {
	seen := make(map[id.ID]map[id.ID]struct{})
	var failed error
	if err := h.eachCommunity(ctx, func(com store.CommunityRow) {
		rows, err := h.repo.ListAFKAway(ctx, com.ID)
		if err != nil {
			failed = err
			return
		}
		for _, r := range rows {
			if seen[r.UserID] == nil {
				seen[r.UserID] = make(map[id.ID]struct{})
			}
			seen[r.UserID][com.ID] = struct{}{}
		}
	}); err != nil {
		return err
	}
	if failed != nil {
		return failed
	}
	h.awayMu.Lock()
	defer h.awayMu.Unlock()
	for u, cs := range seen {
		for cid := range cs {
			h.noteAwayLocked(u, cid)
		}
	}
	h.awaySeeded = true
	return nil
}

// EndAFKCalls is the boot step after EnsureAFKChannels (release note, R-AW1): it seeds the away
// index, ends every live call in a community's AFK channel, and marks every user with a device in its
// call group away there, since now. It also starts the boot grace (R-AW5) that AFKMaintenance waits
// out. It answers how many calls it ended. A call whose end fails is logged and left for
// AFKMaintenance to retry on the next tick (M4); the others go on.
func (h *Calls) EndAFKCalls(ctx context.Context) (int, error) {
	h.awayMu.Lock()
	h.awayGraceUntil, h.awayGraceDone = h.clk.Now().Add(afkBootGrace), false
	h.awayMu.Unlock()
	if err := h.SeedAFKAway(ctx); err != nil {
		h.log.ErrorContext(ctx, "loading the away roster failed; every clear reads the store", "err", err)
	}
	n, failed, err := h.endAFKCallsOnce(ctx)
	h.awayEndPending.Store(failed > 0 || err != nil)
	if n > 0 {
		h.log.InfoContext(ctx, "ended the calls in AFK channels; their users are away", "calls", n)
	}
	return n, err
}

// endAFKCallsOnce is one walk of EndAFKCalls: the calls it ended and how many ends failed.
func (h *Calls) endAFKCallsOnce(ctx context.Context) (int, int, error) {
	n, failed := 0, 0
	err := h.eachCommunity(ctx, func(com store.CommunityRow) {
		cfg, err := h.repo.GetCommunityAFK(ctx, com.ID)
		if err != nil || cfg.ChannelID == nil {
			if err != nil {
				failed++
			}
			return
		}
		live, err := h.repo.ListLiveVoiceSessions(ctx, *cfg.ChannelID)
		if err != nil {
			failed++
			h.log.ErrorContext(ctx, "listing the AFK channel's calls failed", "community", com.ID, "err", err)
			return
		}
		for _, row := range live {
			users := h.callUsers(ctx, row)
			if err := h.endCall(context.WithoutCancel(ctx), row.CallID, row.LivekitRoom, "afk_channel"); err != nil {
				failed++
				h.log.ErrorContext(ctx, "ending a call in the AFK channel failed; retried on the next tick", "call_id", row.CallID, "err", err)
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
	return n, failed, err
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

// AFKMaintenance runs on the maintenance tick, on its own goroutine in dillad (one pass at a time):
// it retries the AFK-call ends the boot could not finish (M4), and once the boot grace has passed
// (R-AW5) it clears, once, the away rows of every user who holds no gateway connection, announcing
// each. The walk holds awayMu for one row at a time, never across it (M5).
func (h *Calls) AFKMaintenance(ctx context.Context) {
	if !h.awayMaintaining.CompareAndSwap(false, true) {
		return
	}
	defer h.awayMaintaining.Store(false)
	if h.awayEndPending.Load() {
		n, failed, err := h.endAFKCallsOnce(ctx)
		h.awayEndPending.Store(failed > 0 || err != nil)
		if n > 0 {
			h.log.InfoContext(ctx, "ended the calls in AFK channels on a retry; their users are away", "calls", n)
		}
	}
	h.awayMu.Lock()
	due := !h.awayGraceUntil.IsZero() && !h.awayGraceDone && !h.clk.Now().Before(h.awayGraceUntil)
	if due {
		h.awayGraceDone = true
	}
	connected := h.awayConnected
	h.awayMu.Unlock()
	if !due || connected == nil {
		return
	}
	if err := h.eachCommunity(ctx, func(com store.CommunityRow) {
		rows, err := h.repo.ListAFKAway(ctx, com.ID)
		if err != nil {
			h.log.WarnContext(ctx, "reading an away roster after the boot grace failed", "community", com.ID, "err", err)
			return
		}
		for _, r := range rows {
			if !connected(r.UserID) {
				h.clearAwayIn(ctx, com.ID, r.UserID)
			}
		}
	}); err != nil {
		h.log.WarnContext(ctx, "listing the communities after the boot grace failed", "err", err)
	}
}

// awaySnapshot is the snapshot's away list of community cid, at most afkAwaySnapshotMax entries,
// bounded in the query (M3).
func (h *Calls) awaySnapshot(ctx context.Context, cid id.ID) ([]afkAwayEntry, error) {
	rows, err := h.repo.ListAFKAwayFirst(ctx, cid, afkAwaySnapshotMax)
	if err != nil {
		return nil, err
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
