package api

import (
	"container/list"
	"context"
	"log/slog"
	"net/http"
	"sync"
	"time"

	"github.com/fxamacker/cbor/v2"

	"github.com/jonasthim/dilla/internal/cborx"
	"github.com/jonasthim/dilla/internal/clock"
	"github.com/jonasthim/dilla/internal/gateway"
	"github.com/jonasthim/dilla/internal/id"
	"github.com/jonasthim/dilla/internal/server"
	"github.com/jonasthim/dilla/internal/store"
)

// The DM call ring (web-3, L-GW-33): a start that opens a call in a DM or group DM rings every other
// participant with op 53 call_ring until one of that user's devices joins, the user declines, the
// call ends, or RingSeconds pass on the instance clock. Rings live in memory only: they are never
// persisted or replayed, and reach only the devices with an open gateway session.

const (
	// RingSeconds is how long a ring lasts (founder decision R5): expires_ts is the ring's start
	// plus this many seconds.
	RingSeconds = 30
	// ringPairGap and ringPairPerHour are the pair rate rule (RV-4): a (caller, recipient) pair is
	// rung at most once per ringPairGap and at most ringPairPerHour times per rolling ringPairWindow.
	ringPairGap     = 15 * time.Second
	ringPairPerHour = 20
	ringPairWindow  = time.Hour
	// maxRingPairs bounds the pair state; beyond it the pair rung least recently is evicted.
	maxRingPairs = 65536
	// maxRingingCalls bounds the calls with a ring outstanding; a start beyond it rings nobody.
	maxRingingCalls = 4096
)

// Ringer is the in-memory ring state: per call, the users being rung, each with its own timer, and
// the pair rate rule's history. One mutex guards both; every frame is delivered outside it.
type Ringer struct {
	gw  VoiceGateway
	clk clock.Clock
	log *slog.Logger
	// maxUsers is livekit.max_voice_participants: a start with more recipients rings nobody. 0 sets
	// no bound.
	maxUsers int

	mu    sync.Mutex
	calls map[id.ID]*ringCall
	pairs map[ringPair]*pairState
	order *list.List // of *pairState, the pair rung least recently first
}

// ringCall is one call's outstanding rings.
type ringCall struct {
	channel id.ID
	users   map[id.ID]*ring
}

// ring is one user's ring: who rang, when it ends, and its timer.
type ring struct {
	caller  id.ID
	expires uint64
	timer   clock.Timer
	stop    chan struct{}
}

// ringPair is the rate rule's key: the caller user and the recipient user, never the recipient
// alone, so no third party can spend a recipient's budget and silence honest callers.
type ringPair struct{ caller, recipient id.ID }

// pairState is one pair's rings within the rolling window (unix nanoseconds, oldest first) and when
// a suppressed ring of the pair was last logged.
type pairState struct {
	key    ringPair
	rings  []int64
	logged int64
	elem   *list.Element
}

// NewRinger builds the ring over the gateway the frames go through and the instance clock.
func NewRinger(gw VoiceGateway, clk clock.Clock, log *slog.Logger) *Ringer {
	if log == nil {
		log = slog.New(slog.DiscardHandler)
	}
	return &Ringer{gw: gw, clk: clk, log: log, calls: map[id.ID]*ringCall{},
		pairs: map[ringPair]*pairState{}, order: list.New()}
}

// WithMaxUsers sets the per-call recipient bound (livekit.max_voice_participants) and returns r.
func (r *Ringer) WithMaxUsers(n int) *Ringer {
	r.maxUsers = n
	return r
}

// Start rings recipients for call, which caller has just opened (a 201) in ch, a DM or group DM:
// each of them gets state 1 on every online device, unless that user is already being rung for the
// call (at most one ring per (call, user)) or the pair rate rule holds the ring back. Any other kind
// of channel rings nobody.
func (r *Ringer) Start(ch store.ChannelRow, call, caller id.ID, recipients []id.ID) {
	if r == nil || (ch.Kind != ChannelDM && ch.Kind != ChannelGroupDM) {
		return
	}
	now := r.clk.Now()
	expires := uint64(now.Unix()) + RingSeconds //nolint:gosec // G115: the instance clock is after 1970
	users := make([]id.ID, 0, len(recipients))
	seen := map[id.ID]bool{caller: true}
	for _, u := range recipients {
		if !seen[u] {
			seen[u] = true
			users = append(users, u)
		}
	}
	if r.maxUsers > 0 && len(users) > r.maxUsers {
		r.log.Warn("a call has more recipients than a call holds; it rings nobody", "call_id", call.String(), "recipients", len(users))
		return
	}
	var started, suppressed []id.ID
	r.mu.Lock()
	rc := r.calls[call]
	if rc == nil {
		if len(r.calls) >= maxRingingCalls {
			r.mu.Unlock()
			r.log.Warn("too many calls are ringing; this call rings nobody", "call_id", call.String())
			return
		}
		rc = &ringCall{channel: ch.ID, users: map[id.ID]*ring{}}
	}
	for _, u := range users {
		if rc.users[u] != nil {
			continue
		}
		allowed, logIt := r.allowLocked(caller, u, now)
		if !allowed {
			if logIt {
				suppressed = append(suppressed, u)
			}
			continue
		}
		rg := &ring{caller: caller, expires: expires, timer: r.clk.NewTimer(RingSeconds * time.Second), stop: make(chan struct{})}
		rc.users[u] = rg
		started = append(started, u)
		go r.expire(call, u, rg)
	}
	if len(rc.users) > 0 {
		r.calls[call] = rc
	}
	r.mu.Unlock()
	for _, u := range suppressed {
		r.log.Info("a ring was held back by the pair rate rule", "caller", caller.String(), "recipient", u.String())
	}
	for _, u := range started {
		r.deliver(u, call, ch.ID, caller, 1, expires)
	}
}

// allowLocked applies the pair rate rule to one ring of recipient by caller at now and, when it is
// allowed, records it. logIt is true for a held-back ring whose pair was not logged within the
// window (one INFO per suppressed pair per hour). r.mu is held.
func (r *Ringer) allowLocked(caller, recipient id.ID, now time.Time) (allowed, logIt bool) {
	k := ringPair{caller: caller, recipient: recipient}
	at := now.UnixNano()
	ps := r.pairs[k]
	if ps == nil {
		for len(r.pairs) >= maxRingPairs {
			old, ok := r.order.Remove(r.order.Front()).(*pairState)
			if !ok {
				break // the list holds only *pairState
			}
			delete(r.pairs, old.key)
		}
		ps = &pairState{key: k}
		ps.elem = r.order.PushBack(ps)
		r.pairs[k] = ps
	}
	keep := 0
	for keep < len(ps.rings) && at-ps.rings[keep] >= int64(ringPairWindow) {
		keep++
	}
	ps.rings = ps.rings[keep:]
	if n := len(ps.rings); n >= ringPairPerHour || (n > 0 && at-ps.rings[n-1] < int64(ringPairGap)) {
		if ps.logged == 0 || at-ps.logged >= int64(ringPairWindow) {
			ps.logged = at
			logIt = true
		}
		return false, logIt
	}
	ps.rings = append(ps.rings, at)
	r.order.MoveToBack(ps.elem)
	return true, false
}

// expire ends user's ring when its timer fires, unless the ring was answered, declined or ended
// first (stop closed) or replaced.
func (r *Ringer) expire(call, user id.ID, rg *ring) {
	select {
	case <-rg.timer.C():
	case <-rg.stop:
		return
	}
	r.mu.Lock()
	rc := r.calls[call]
	if rc == nil || rc.users[user] != rg {
		r.mu.Unlock()
		return
	}
	r.dropLocked(call, rc, user)
	channel := rc.channel
	r.mu.Unlock()
	r.deliver(user, call, channel, rg.caller, 0, rg.expires)
}

// take removes user's ring of call and stops its timer, answering it and the call's channel; nil
// when the user is not being rung for the call.
func (r *Ringer) take(call, user id.ID, match func(*ring) bool) (*ring, id.ID) {
	r.mu.Lock()
	defer r.mu.Unlock()
	rc := r.calls[call]
	if rc == nil {
		return nil, id.Zero
	}
	rg := rc.users[user]
	if rg == nil || !match(rg) {
		return nil, id.Zero
	}
	r.dropLocked(call, rc, user)
	return rg, rc.channel
}

// dropLocked forgets user's ring of call and stops its timer. r.mu is held.
func (r *Ringer) dropLocked(call id.ID, rc *ringCall, user id.ID) {
	if rg := rc.users[user]; rg != nil {
		rg.timer.Stop()
		select {
		case <-rg.stop:
		default:
			close(rg.stop)
		}
	}
	delete(rc.users, user)
	if len(rc.users) == 0 {
		delete(r.calls, call)
	}
}

// Answered stops user's ring of call because one of the user's devices was admitted to the call's
// room: state 0 to every device of the user.
func (r *Ringer) Answered(call, user id.ID) {
	if r == nil {
		return
	}
	if rg, channel := r.take(call, user, func(*ring) bool { return true }); rg != nil {
		r.deliver(user, call, channel, rg.caller, 0, rg.expires)
	}
}

// Declined stops user's ring of call when expires is that ring's expires_ts — state 0 to every
// device of the user and state 2, naming the user, to every device of the caller — and answers the
// caller. Any other expires_ts (a late decline of an earlier ring of the same DM: a DM's call id is
// its channel id), or no ring, changes nothing.
func (r *Ringer) Declined(call, user id.ID, expires uint64) (caller id.ID, ok bool) {
	if r == nil {
		return id.Zero, false
	}
	rg, channel := r.take(call, user, func(rg *ring) bool { return rg.expires == expires })
	if rg == nil {
		return id.Zero, false
	}
	r.deliver(user, call, channel, rg.caller, 0, rg.expires)
	r.deliver(rg.caller, call, channel, user, 2, rg.expires)
	return rg.caller, true
}

// End stops every ring of call because the call ended: state 0 to every device of each user.
func (r *Ringer) End(call id.ID) {
	if r == nil {
		return
	}
	r.mu.Lock()
	rc := r.calls[call]
	if rc == nil {
		r.mu.Unlock()
		return
	}
	rings := make(map[id.ID]*ring, len(rc.users))
	for u, rg := range rc.users {
		rings[u] = rg
		r.dropLocked(call, rc, u)
	}
	r.mu.Unlock()
	for u, rg := range rings {
		r.deliver(u, call, rc.channel, rg.caller, 0, rg.expires)
	}
}

// deliver sends one call_ring to every live connection of to.
func (r *Ringer) deliver(to, call, channel, user id.ID, state, expires uint64) {
	if r.gw == nil {
		return
	}
	p, err := gateway.CallRingPayload(call, channel, user, state, expires)
	if err != nil {
		r.log.Error("encoding a call_ring failed", "err", err)
		return
	}
	r.gw.DeliverUser(to, gateway.Frame{Op: gateway.OpCallRing, Payload: p})
}

// --- the Calls side: the start's ring and the decline route. ---

// ring rings the other participants of a DM or group-DM call caller has just opened: every
// participant user but the caller who has no device in the call's room. A community channel rings
// nobody.
func (h *Calls) ring(ctx context.Context, ch store.ChannelRow, row store.VoiceSessionRow, caller id.ID) {
	if h.ringer == nil || (ch.Kind != ChannelDM && ch.Kind != ChannelGroupDM) {
		return
	}
	members, err := h.repo.ListChannelMembers(ctx, ch.ID)
	if err != nil {
		h.log.WarnContext(ctx, "reading a DM's participants to ring them failed; nobody is rung", "err", err)
		return
	}
	inCall := map[id.ID]bool{caller: true}
	if h.events != nil {
		for _, p := range h.events.participantsIn(row.CallID, row.LivekitRoom) {
			inCall[p.User] = true
		}
	}
	recipients := make([]id.ID, 0, len(members))
	for _, u := range members {
		if !inCall[u] {
			recipients = append(recipients, u)
		}
	}
	h.ringer.Start(ch, row.CallID, caller, recipients)
}

// decline is POST /v1/calls/{call_id}/decline `[expires_ts]` (L-HTTP-104): 204 whether or not the
// caller's user was still being rung by the ring that expires_ts names.
//
// Attacker: a non-participant who learnt a call id can neither stop a ring nor confirm the call
// exists — an unknown call, an ended call and a call of a DM the caller is no participant of all
// answer the same 404 — and a participant's late decline of an earlier ring of the same DM (the call
// id is the channel id) names another expires_ts, so it stops nothing and tells nobody "declined".
func (h *Calls) decline(w http.ResponseWriter, r *http.Request) {
	s, err := enrolledSession(r)
	if err != nil {
		server.WriteError(w, err)
		return
	}
	callID, err := server.PathID(r, "call_id")
	if err != nil {
		server.WriteError(w, err)
		return
	}
	row, err := h.repo.GetVoiceSession(r.Context(), callID)
	if err != nil {
		server.WriteError(w, notFound(err))
		return
	}
	ch, err := h.repo.GetChannel(r.Context(), row.ChannelID)
	if err != nil {
		server.WriteError(w, notFound(err))
		return
	}
	// The DM participant check: Resolve grants view_channel in a DM or group DM to its participants
	// only (resolveDM), and in a community channel by roles and overwrites.
	bits, err := h.res.Resolve(r.Context(), s.UserID, ch)
	if err != nil {
		server.WriteError(w, err)
		return
	}
	if !bits.Has(PermViewChannel) || row.Ended != nil {
		server.WriteError(w, server.Errorf(server.CodeNotFound, "no such object"))
		return
	}
	if ch.Kind != ChannelDM && ch.Kind != ChannelGroupDM {
		server.WriteError(w, server.Errorf(server.CodeInvalidRequest, "only a DM or group-DM call rings"))
		return
	}
	var body []cbor.RawMessage
	if err := server.DecodeBody(w, r, maxCBORBody, &body); err != nil {
		server.WriteError(w, err)
		return
	}
	var expires uint64
	if len(body) != 1 || cborx.Unmarshal(body[0], &expires) != nil {
		server.WriteError(w, server.Errorf(server.CodeInvalidRequest, "the body is [expires_ts]"))
		return
	}
	h.ringer.Declined(callID, s.UserID, expires)
	w.WriteHeader(http.StatusNoContent)
}
