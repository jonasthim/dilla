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

// shareLeases is the publisher lease (DEV-02, ruling F1, MD-3): per call, the devices holding a
// sharing slot and when they took it. A slot covers camera, screen and screen audio together;
// screen audio never counts alone and the microphone never counts. It lives in memory because the
// SFU is in-process: a restart drops every call, and every lease with it.
type shareLeases struct {
	mu     sync.Mutex
	byCall map[id.ID]map[id.ID]int64
}

func newShareLeases() *shareLeases {
	return &shareLeases{byCall: map[id.ID]map[id.ID]int64{}}
}

// take gives dev a slot of call unless maxSlots are held. A device that already holds one keeps it
// (already true): a repeated request is idempotent.
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

func (l *shareLeases) release(call, dev id.ID) {
	l.mu.Lock()
	defer l.mu.Unlock()
	delete(l.byCall[call], dev)
	if len(l.byCall[call]) == 0 {
		delete(l.byCall, call)
	}
}

func (l *shareLeases) dropCall(call id.ID) {
	l.mu.Lock()
	defer l.mu.Unlock()
	delete(l.byCall, call)
}

func (h *Calls) maxPublishers() int {
	if h.cfg.MaxPublishers > 0 {
		return h.cfg.MaxPublishers
	}
	return defaultMaxSharers
}

// callOf is the {call_id} of a share, unshare or stats request: a call in a channel the caller can
// see (404 otherwise, as for an unknown one), with the caller's bits there. The call may have ended;
// each route decides what that means.
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

// share is POST /v1/calls/{call_id}/share `[]`: 204 once the device holds a sharing slot and the SFU
// holds its complete promoted permission. The slot is taken under the lease's lock before the push,
// so of two devices racing for the last slot exactly one wins; a push that fails rolls it back.
func (h *Calls) share(w http.ResponseWriter, r *http.Request) {
	s, row, _, bits, err := h.callOf(r)
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
	if err := h.requireLeafOfCall(r.Context(), row, s.DeviceID); err != nil {
		server.WriteError(w, err)
		return
	}
	if h.sfu == nil {
		server.WriteError(w, notImplemented("this instance runs no SFU (livekit.enabled is false)"))
		return
	}
	limit := h.maxPublishers()
	taken, already := h.leases.take(row.CallID, s.DeviceID, limit, h.clk.Now().Unix())
	if !taken {
		if h.counters != nil {
			h.counters.ShareRefused()
		}
		server.WriteError(w, server.Errorf(server.CodeCallSharersFull, "%d devices of this call are already sharing", limit))
		return
	}
	if err := h.sfu.UpdatePermission(r.Context(), row.LivekitRoom, s.DeviceID.String(), h.grantFor(bits, row.CallID, s.DeviceID)); err != nil {
		if !already {
			h.leases.release(row.CallID, s.DeviceID)
		}
		if errors.Is(err, sfu.ErrNoParticipant) {
			server.WriteError(w, server.Errorf(server.CodeNotFound, "your device is not in the call's room"))
			return
		}
		h.log.ErrorContext(r.Context(), "promoting a sharer failed", "room", row.LivekitRoom, "err", err)
		server.WriteError(w, server.Errorf(server.CodeInternal, "the SFU could not update the permission"))
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// unshare is DELETE /v1/calls/{call_id}/share: 204, also when the device held no slot or the call
// has ended.
func (h *Calls) unshare(w http.ResponseWriter, r *http.Request) {
	s, row, _, bits, err := h.callOf(r)
	if err != nil {
		server.WriteError(w, err)
		return
	}
	if row.Ended == nil {
		if err := h.releaseShare(r.Context(), row, bits, s.DeviceID); err != nil {
			server.WriteError(w, err)
			return
		}
	}
	w.WriteHeader(http.StatusNoContent)
}

// releaseShare frees dev's slot of row's call: the demotion is pushed FIRST — LiveKit unpublishes the
// video tracks and pushes a demoted token — and the slot freed after, so at no instant do more than
// max_publishers devices hold video sources. A device the room no longer holds needs no demotion. A
// demotion that fails otherwise keeps the slot: a device that may still publish video keeps counting.
func (h *Calls) releaseShare(ctx context.Context, row store.VoiceSessionRow, bits Bits, dev id.ID) error {
	if !h.leases.held(row.CallID, dev) {
		return nil
	}
	if h.sfu != nil {
		if err := h.sfu.UpdatePermission(ctx, row.LivekitRoom, dev.String(),
			sfu.PublishGrant(bits.Has(PermSpeak), false, false)); err != nil && !errors.Is(err, sfu.ErrNoParticipant) {
			h.log.ErrorContext(ctx, "demoting a sharer failed; the slot stays held", "room", row.LivekitRoom, "err", err)
			return server.Errorf(server.CodeInternal, "the SFU could not update the permission")
		}
	}
	h.leases.release(row.CallID, dev)
	return nil
}
