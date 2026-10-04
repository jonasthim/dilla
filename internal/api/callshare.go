package api

import (
	"context"
	"errors"
	"net/http"
	"sync"

	"github.com/fxamacker/cbor/v2"

	"github.com/jonasthim/dilla/internal/auth"
	"github.com/jonasthim/dilla/internal/id"
	"github.com/jonasthim/dilla/internal/server"
	"github.com/jonasthim/dilla/internal/sfu"
	"github.com/jonasthim/dilla/internal/store"
)

// shareLeases is the publisher lease (DEV-02, ruling F1, MD-3) and the per-call state that goes with
// it: per call, the devices holding a sharing slot and when they took it, the participants whose
// required cut or demotion has not landed in the SFU yet (pending repairs), and the per-call lock.
// A slot covers camera, screen and screen audio together; screen audio never counts alone and the
// microphone never counts. It lives in memory because the SFU is in-process: a restart drops every
// call, and every lease and repair with it.
//
// The per-call lock (lockCall) serialises every lease transition of a call together with the SFU
// push that goes with it: no path pushes a permission for a call, takes or frees a slot, or records
// or clears a repair without holding it. So at every instant the devices whose pushed permission
// allows a camera or screen source are a subset of the slot holders, and never more than
// livekit.max_publishers. mu only guards the maps themselves.
type shareLeases struct {
	mu      sync.Mutex
	byCall  map[id.ID]map[id.ID]int64
	pending map[id.ID]map[string]pendingRepair
	locks   map[id.ID]*callLock
}

// callLock is one call's lock, reference-counted so an idle call holds none.
type callLock struct {
	mu   sync.Mutex
	refs int
}

// pendingRepair is a cut or a demotion of one participant of a call's room that did not land: the
// SFU refused or failed the removal or the push. Until it lands the participant's slot stays held,
// and the token mint and the /rtc gate refuse the device for that call.
type pendingRepair struct {
	Room string
	// DropSlot is set when the repair must also free the device's sharing slot (an unshare or a
	// cut), so a retry never pushes the video sources back.
	DropSlot bool
}

func newShareLeases() *shareLeases {
	return &shareLeases{
		byCall:  map[id.ID]map[id.ID]int64{},
		pending: map[id.ID]map[string]pendingRepair{},
		locks:   map[id.ID]*callLock{},
	}
}

// lockCall takes call's lock and returns its release.
func (l *shareLeases) lockCall(call id.ID) func() {
	l.mu.Lock()
	cl := l.locks[call]
	if cl == nil {
		cl = &callLock{}
		l.locks[call] = cl
	}
	cl.refs++
	l.mu.Unlock()
	cl.mu.Lock()
	return func() {
		cl.mu.Unlock()
		l.mu.Lock()
		cl.refs--
		if cl.refs == 0 {
			delete(l.locks, call)
		}
		l.mu.Unlock()
	}
}

// take gives dev a slot of call unless maxSlots are held. A device that already holds one keeps it
// (already true): a repeated request is idempotent. The caller holds call's lock.
func (l *shareLeases) take(call, dev id.ID, maxSlots int, now int64) (taken, already bool) {
	l.mu.Lock()
	defer l.mu.Unlock()
	held := l.byCall[call]
	if _, ok := held[dev]; ok {
		return true, true
	}
	if len(held) >= maxSlots {
		return false, false
	}
	if held == nil {
		held = map[id.ID]int64{}
		l.byCall[call] = held
	}
	held[dev] = now
	return true, false
}

func (l *shareLeases) held(call, dev id.ID) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	_, ok := l.byCall[call][dev]
	return ok
}

// release frees dev's slot of call. The caller holds call's lock.
func (l *shareLeases) release(call, dev id.ID) {
	l.mu.Lock()
	defer l.mu.Unlock()
	delete(l.byCall[call], dev)
	if len(l.byCall[call]) == 0 {
		delete(l.byCall, call)
	}
}

// markPending records that identity's repair in call did not land; a DropSlot already recorded
// stays. The caller holds call's lock.
func (l *shareLeases) markPending(call id.ID, identity string, r pendingRepair) {
	l.mu.Lock()
	defer l.mu.Unlock()
	m := l.pending[call]
	if m == nil {
		m = map[string]pendingRepair{}
		l.pending[call] = m
	}
	if prev, ok := m[identity]; ok && prev.Room == r.Room {
		r.DropSlot = r.DropSlot || prev.DropSlot
	}
	m[identity] = r
}

// clearPending forgets identity's repair in call. The caller holds call's lock.
func (l *shareLeases) clearPending(call id.ID, identity string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	delete(l.pending[call], identity)
	if len(l.pending[call]) == 0 {
		delete(l.pending, call)
	}
}

// pendingOf is a copy of call's repairs.
func (l *shareLeases) pendingOf(call id.ID) map[string]pendingRepair {
	l.mu.Lock()
	defer l.mu.Unlock()
	out := make(map[string]pendingRepair, len(l.pending[call]))
	for k, v := range l.pending[call] {
		out[k] = v
	}
	return out
}

// isPending reports whether dev has a repair outstanding in call.
func (l *shareLeases) isPending(call, dev id.ID) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	_, ok := l.pending[call][dev.String()]
	return ok
}

// pendingCalls is every call with a repair outstanding.
func (l *shareLeases) pendingCalls() []id.ID {
	l.mu.Lock()
	defer l.mu.Unlock()
	out := make([]id.ID, 0, len(l.pending))
	for call := range l.pending {
		out = append(out, call)
	}
	return out
}

// dropCall forgets every slot and repair of call: the call is over and its room closed. The caller
// holds call's lock.
func (l *shareLeases) dropCall(call id.ID) {
	l.mu.Lock()
	defer l.mu.Unlock()
	delete(l.byCall, call)
	delete(l.pending, call)
}

func (h *Calls) maxPublishers() int {
	if h.cfg.MaxPublishers > 0 {
		return h.cfg.MaxPublishers
	}
	return defaultMaxSharers
}

// callOf is the {call_id} of a share, unshare or stats request: a call in a channel the caller can
// see (404 otherwise, as for an unknown one), with the caller's bits there. The call may have ended;
// each route decides what that means. The bits are a first look only: a route re-reads them under
// the call's lock before it pushes anything.
func (h *Calls) callOf(r *http.Request) (auth.Session, store.VoiceSessionRow, store.ChannelRow, Bits, error) {
	s, err := enrolledSession(r)
	if err != nil {
		return s, store.VoiceSessionRow{}, store.ChannelRow{}, 0, err
	}
	callID, err := server.PathID(r, "call_id")
	if err != nil {
		return s, store.VoiceSessionRow{}, store.ChannelRow{}, 0, err
	}
	row, err := h.repo.GetVoiceSession(r.Context(), callID)
	if err != nil {
		return s, store.VoiceSessionRow{}, store.ChannelRow{}, 0, notFound(err)
	}
	ch, err := h.repo.GetChannel(r.Context(), row.ChannelID)
	if err != nil {
		return s, store.VoiceSessionRow{}, store.ChannelRow{}, 0, notFound(err)
	}
	bits, err := h.res.Resolve(r.Context(), s.UserID, ch)
	if err != nil {
		return s, store.VoiceSessionRow{}, store.ChannelRow{}, 0, err
	}
	if !bits.Has(PermViewChannel) {
		return s, store.VoiceSessionRow{}, store.ChannelRow{}, 0, server.Errorf(server.CodeNotFound, "no such object")
	}
	return s, row, ch, bits, nil
}

// requireLeafOfCall is the leaf gate on the group row's call was opened on.
func (h *Calls) requireLeafOfCall(ctx context.Context, row store.VoiceSessionRow, dev id.ID) error {
	if row.GroupID == nil {
		return server.Errorf(server.CodeLeafNotCurrent, "the call has no group to be a leaf of")
	}
	group, err := h.repo.GetGroup(ctx, *row.GroupID)
	if err != nil {
		return notFound(err)
	}
	return h.requireCurrentLeaf(ctx, group, dev)
}

// liveRow re-reads row's call under its lock: the same call, still live, in the same room. false
// when it ended or a later call of the same call id replaced it.
func (h *Calls) liveRow(ctx context.Context, repo store.Repository, row store.VoiceSessionRow) (store.VoiceSessionRow, bool, error) {
	cur, err := repo.GetVoiceSession(ctx, row.CallID)
	if errors.Is(err, store.ErrNotFound) {
		return cur, false, nil
	}
	if err != nil {
		return cur, false, err
	}
	return cur, cur.Ended == nil && cur.LivekitRoom == row.LivekitRoom, nil
}

// share is POST /v1/calls/{call_id}/share `[]`: 204 once the device holds a sharing slot and the SFU
// holds its complete promoted permission. Everything that decides the push — the call still live,
// the caller's bits, the leaf, the slot — is read again under the call's lock, and the push happens
// under it too, so of two devices racing for the last slot exactly one wins and no unshare or grant
// sync can interleave with the promotion.
func (h *Calls) share(w http.ResponseWriter, r *http.Request) {
	s, row, ch, bits, err := h.callOf(r)
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
		server.WriteError(w, server.Errorf(server.CodeInvalidRequest, "the body is the empty array"))
		return
	}
	if row.Ended != nil {
		server.WriteError(w, server.Errorf(server.CodeNotFound, "the call has ended"))
		return
	}
	if !bits.Has(PermVideo) && !bits.Has(PermScreenShare) {
		server.WriteError(w, server.Errorf(server.CodeForbidden, "missing permission"))
		return
	}
	if h.sfu == nil {
		server.WriteError(w, notImplemented("this instance runs no SFU (livekit.enabled is false)"))
		return
	}
	ctx := r.Context()
	unlock := h.leases.lockCall(row.CallID)
	defer unlock()
	cur, live, err := h.liveRow(ctx, h.repo, row)
	if err != nil {
		server.WriteError(w, err)
		return
	}
	if !live {
		server.WriteError(w, server.Errorf(server.CodeNotFound, "the call has ended"))
		return
	}
	h.drainPending(ctx, h.deps(), ch, cur)
	if h.leases.isPending(cur.CallID, s.DeviceID) {
		server.WriteError(w, server.Errorf(server.CodeForbidden, "your device's access to this call is being revoked"))
		return
	}
	bits, err = h.res.Resolve(ctx, s.UserID, ch)
	if err != nil {
		server.WriteError(w, err)
		return
	}
	switch {
	case !bits.Has(PermViewChannel):
		server.WriteError(w, server.Errorf(server.CodeNotFound, "no such object"))
		return
	case !bits.Has(PermConnect) || (!bits.Has(PermVideo) && !bits.Has(PermScreenShare)):
		server.WriteError(w, server.Errorf(server.CodeForbidden, "missing permission"))
		return
	}
	if err := h.requireLeafOfCall(ctx, cur, s.DeviceID); err != nil {
		server.WriteError(w, err)
		return
	}
	limit := h.maxPublishers()
	taken, already := h.leases.take(cur.CallID, s.DeviceID, limit, h.clk.Now().Unix())
	if !taken {
		if h.counters != nil {
			h.counters.ShareRefused()
		}
		server.WriteError(w, server.Errorf(server.CodeCallSharersFull, "%d devices of this call are already sharing", limit))
		return
	}
	if err := h.sfu.UpdatePermission(ctx, cur.LivekitRoom, s.DeviceID.String(), h.grantFor(bits, cur.CallID, s.DeviceID)); err != nil {
		if errors.Is(err, sfu.ErrNoParticipant) {
			// A device the room does not hold publishes nothing, so its slot (new or old) goes.
			h.leases.release(cur.CallID, s.DeviceID)
			server.WriteError(w, server.Errorf(server.CodeNotFound, "your device is not in the call's room"))
			return
		}
		// Whether the SFU applied the promotion is unknown, so the slot stays held: a device that may
		// publish video keeps counting against the cap. The device frees it with DELETE …/share.
		h.log.ErrorContext(ctx, "promoting a sharer failed; the slot stays held", "room", cur.LivekitRoom,
			"device", s.DeviceID, "already", already, "err", err)
		server.WriteError(w, server.Errorf(server.CodeInternal, "the SFU could not update the permission"))
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// unshare is DELETE /v1/calls/{call_id}/share: 204, also when the device held no slot or the call
// has ended.
func (h *Calls) unshare(w http.ResponseWriter, r *http.Request) {
	s, row, ch, _, err := h.callOf(r)
	if err != nil {
		server.WriteError(w, err)
		return
	}
	if row.Ended == nil {
		if err := h.releaseShare(r.Context(), ch, row, s.DeviceID); err != nil {
			server.WriteError(w, err)
			return
		}
	}
	w.WriteHeader(http.StatusNoContent)
}

// releaseShare frees dev's slot of row's call under the call's lock: the demotion — computed from
// the bits read now, under the lock — is pushed FIRST, LiveKit unpublishes the video tracks, and the
// slot is freed after. A device the room no longer holds needs no demotion. A demotion that fails
// keeps the slot and is recorded as a pending repair, which the retry ticker and the call's next
// event drive until it lands.
func (h *Calls) releaseShare(ctx context.Context, ch store.ChannelRow, row store.VoiceSessionRow, dev id.ID) error {
	unlock := h.leases.lockCall(row.CallID)
	defer unlock()
	cur, live, err := h.liveRow(ctx, h.repo, row)
	if err != nil {
		return err
	}
	if !live {
		return nil
	}
	d := h.deps()
	h.drainPending(ctx, d, ch, cur)
	if !h.leases.held(cur.CallID, dev) {
		return nil
	}
	if h.sfu == nil {
		h.leases.release(cur.CallID, dev)
		return nil
	}
	if err := h.reconcile(ctx, d, ch, cur, dev.String(), nil, true); err != nil {
		h.log.ErrorContext(ctx, "demoting a sharer failed; the slot stays held until the repair lands",
			"room", cur.LivekitRoom, "device", dev, "err", err)
		return server.Errorf(server.CodeInternal, "the SFU could not update the permission")
	}
	return nil
}
