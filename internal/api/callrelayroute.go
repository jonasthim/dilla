package api

import (
	"net/http"

	"github.com/fxamacker/cbor/v2"

	"github.com/jonasthim/dilla/internal/server"
)

// relayResponse is `[ice_servers]`.
type relayResponse struct {
	_          struct{} `cbor:",toarray"`
	ICEServers []iceServer
}

// refreshRelay is POST /v1/calls/{call_id}/relay `[]` (UP11-b): 200 `[ice_servers]`, fresh relay (TURN)
// credentials for the caller's device in a call it already takes part in, and nothing else. It
// asks the SFU nothing — no CreateRoom, no token, no push — so a client whose relay restarted with
// the API can re-fetch its credentials while its media reconnects without re-opening a room the
// SFU lost (a full start would, and the client's resume would then meet a room that does not know
// it). The gates are the start's, read from the call's row instead of the channel's newest group:
// view_channel (404 otherwise, as for an unknown call), connect, a current leaf of the group the
// call was opened on, not barred, no removal, demotion or relay cut pending (503); the mint is the
// start's too (iceServers: ordered against the relay's cuts), with its entitlement re-read after it.
func (h *Calls) refreshRelay(w http.ResponseWriter, r *http.Request) {
	begun := h.clk.Now()
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
	if !bits.Has(PermConnect) {
		server.WriteError(w, server.Errorf(server.CodeForbidden, "missing permission"))
		return
	}
	if err := h.requireLeafOfCall(r.Context(), row, s.DeviceID); err != nil {
		server.WriteError(w, err)
		return
	}
	if err := h.refuseBarred(r.Context(), h.repo, s.DeviceID); err != nil {
		server.WriteError(w, err)
		return
	}
	// As at the start: a device whose cut or demotion in this call has not landed in the SFU, or whose
	// relay cut the media relay has not acknowledged, gets nothing until it has. Unlike the start, the
	// route does not drive that repair itself: the repair asks the SFU, and this route never does.
	if h.leases.isPending(row.CallID, s.DeviceID) || h.relayPending(s.DeviceID) {
		server.WriteError(w, errRepairPending())
		return
	}
	ice, minted, err := h.iceServers(s.DeviceID, begun)
	if err != nil {
		server.WriteError(w, err)
		return
	}
	if minted {
		// The start's mint race (commit review): a device barred or demoted between the gates and the
		// mint does not leave with the credential; the cut as of now covers it.
		if err := h.stillEntitled(r.Context(), s, ch, *row.GroupID); err != nil {
			h.revokeRelay(s.DeviceID)
			server.WriteError(w, err)
			return
		}
	}
	if err := server.EncodeBody(w, http.StatusOK, relayResponse{ICEServers: ice}); err != nil {
		h.log.WarnContext(r.Context(), "write relay response", "err", err)
	}
}
