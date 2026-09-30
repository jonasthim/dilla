package api

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"time"

	"github.com/fxamacker/cbor/v2"

	"github.com/jonasthim/dilla/internal/auth"
	"github.com/jonasthim/dilla/internal/clock"
	"github.com/jonasthim/dilla/internal/id"
	"github.com/jonasthim/dilla/internal/server"
	"github.com/jonasthim/dilla/internal/store"
)

// CallTokens is the SFU the call routes drive. In production it is
// internal/sfu.(*Server): Token mints a LiveKit room-join JWT whose grants are
// the spec's speak, video and stream permissions (the gate in front of it is
// this file's), and DeleteRoom closes a room and disconnects everyone still in
// it, answering nil for a room the SFU does not know.
type CallTokens interface {
	Token(room, identity string) (string, error)
	DeleteRoom(ctx context.Context, room string) error
}

// roomCloseTimeout bounds the SFU call that closes an ended call's room.
const roomCloseTimeout = 5 * time.Second

// CallsConfig is what the call routes hand a client besides the token.
type CallsConfig struct {
	// LiveKitURL is the signalling URL a client connects to.
	LiveKitURL string
	// TURNSecret is turn.shared_secret_file's content; "" when TURN is off.
	TURNSecret string
	// TURNURLs are the relay URLs a client may use (a turns: URL on 443 behind
	// the demux, or a turn: URL on turn.listen behind a proxy); empty when
	// TURN is off.
	TURNURLs []string
	// CredentialTTL is turn.credential_ttl.
	CredentialTTL time.Duration
}

// Calls serves protocol/09's two voice routes. Register mounts the handlers
// bare, as the other Plan 2 route groups do, and each requires an enrolled
// session itself.
type Calls struct {
	repo store.Repository
	res  *Resolver
	sfu  CallTokens
	cfg  CallsConfig
	clk  clock.Clock
	log  *slog.Logger
}

// NewCalls wires the call routes over the SFU's token mint.
func NewCalls(repo store.Repository, res *Resolver, sfu CallTokens, cfg CallsConfig, clk clock.Clock, log *slog.Logger) *Calls {
	return &Calls{repo: repo, res: res, sfu: sfu, cfg: cfg, clk: clk, log: log}
}

func (h *Calls) Register(mux *server.Mux) {
	mux.HandleFunc("POST /v1/channels/{id}/calls", h.start)
	mux.HandleFunc("DELETE /v1/calls/{call_id}", h.end)
}

// callResponse is `[call_id, group_id, livekit_url, token, ice_servers]`.
type callResponse struct {
	_          struct{} `cbor:",toarray"`
	CallID     id.ID
	GroupID    id.ID
	LiveKitURL string
	Token      string
	ICEServers []iceServer
}

// iceServer is `[urls([tstr]), username(tstr), credential(tstr)]`: the three
// members of an RTCIceServer a client passes to its peer connection.
type iceServer struct {
	_          struct{} `cbor:",toarray"`
	URLs       []string
	Username   string
	Credential string
}

// start is POST /v1/channels/{id}/calls `[]`: 201 with a fresh call, or 200
// joining the call already live in the channel's call group.
//
// The gate is the spec's: a token is minted only for a device whose leaf is
// present in the call group's CURRENT epoch — added at or before it and not
// removed. A device that has not yet joined the group's current epoch
// (a leaf added in a later epoch the instance has recorded ahead of its own
// epoch, or none at all) and a removed one are refused E_LEAF_NOT_CURRENT, so
// a device that could not decrypt the call's media keys cannot join its room.
func (h *Calls) start(w http.ResponseWriter, r *http.Request) {
	s, ch, err := h.channel(r)
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
	group, err := h.callGroup(r.Context(), ch)
	if err != nil {
		server.WriteError(w, err)
		return
	}
	// R9: the call is keyed by the call group's call id, which every call group
	// of the channel shares. While a call is live, the group it was opened on
	// (voice_sessions.group_id) is the one its token gate reads: a newer call
	// group of the channel neither locks that call's leaves out nor lets its
	// own leaves into that call's room.
	callID := callIDOfGroup(group)
	now := h.clk.Now().Unix()
	prev, err := h.repo.GetVoiceSession(r.Context(), callID)
	if err != nil && !errors.Is(err, store.ErrNotFound) {
		server.WriteError(w, err)
		return
	}
	live := err == nil && prev.Ended == nil
	endStale := false
	if live && prev.GroupID != nil && *prev.GroupID != group.GroupID {
		recorded, gerr := h.repo.GetGroup(r.Context(), *prev.GroupID)
		switch {
		case gerr == nil && recorded.ClosedAt == nil:
			group = recorded
		case gerr == nil || errors.Is(gerr, store.ErrNotFound):
			// The live call's group is closed or gone, so that call cannot go on:
			// once this request passes the gates it ends it and opens the next
			// call on the channel's newest call group.
			live, endStale = false, true
		default:
			server.WriteError(w, gerr)
			return
		}
	}
	if err := h.requireCurrentLeaf(r.Context(), group, s.DeviceID); err != nil {
		server.WriteError(w, err)
		return
	}
	// An instance with livekit.enabled = false has no SFU to mint a room token
	// from. The route is still mounted, so every gate above answers as it does
	// elsewhere; a call that would open is 501, before any voice session is
	// recorded for a room nobody can join.
	if h.sfu == nil {
		server.WriteError(w, notImplemented("this instance runs no SFU (livekit.enabled is false)"))
		return
	}
	if endStale {
		if err := h.repo.EndVoiceSession(r.Context(), callID, now); err != nil && !errors.Is(err, store.ErrNotFound) {
			server.WriteError(w, err)
			return
		}
		h.closeRoom(r, prev.LivekitRoom)
	}

	// PutVoiceSession leaves a live call as it is, so the row read back
	// afterwards is the one call every device of this group lands in, however
	// many start it at once.
	groupID := group.GroupID
	// A fresh room per call, so a device from the previous call of the same
	// group cannot linger in this one.
	room := fmt.Sprintf("%s-%d", callID, now)
	// 201 when this request opens the call, 200 when it joins one under way.
	// Two devices opening the same call in the same instant may both be told
	// 201; both are still handed the one room the store kept.
	status := http.StatusCreated
	if live {
		status = http.StatusOK
	}
	if err := h.repo.PutVoiceSession(r.Context(), store.VoiceSessionRow{
		CallID: callID, ChannelID: ch.ID, GroupID: &groupID, LivekitRoom: room, Started: now,
	}); err != nil {
		server.WriteError(w, err)
		return
	}
	row, err := h.repo.GetVoiceSession(r.Context(), callID)
	if err != nil {
		server.WriteError(w, err)
		return
	}
	// Another device may have opened the call on another call group of the
	// channel between the read above and the write: the room belongs to the
	// group the row names, so that is the group this device must be a leaf of.
	if row.GroupID != nil && *row.GroupID != groupID {
		kept, err := h.repo.GetGroup(r.Context(), *row.GroupID)
		if err != nil {
			server.WriteError(w, notFound(err))
			return
		}
		if err := h.requireCurrentLeaf(r.Context(), kept, s.DeviceID); err != nil {
			server.WriteError(w, err)
			return
		}
		groupID = kept.GroupID
	}
	token, err := h.sfu.Token(row.LivekitRoom, s.DeviceID.String())
	if err != nil {
		h.log.ErrorContext(r.Context(), "minting a LiveKit token failed", "err", err)
		server.WriteError(w, server.Errorf(server.CodeInternal, "the SFU could not mint a token"))
		return
	}
	if err := server.EncodeBody(w, status, callResponse{
		CallID: callID, GroupID: groupID, LiveKitURL: h.cfg.LiveKitURL, Token: token,
		ICEServers: h.iceServers(s.DeviceID),
	}); err != nil {
		h.log.WarnContext(r.Context(), "write call response", "err", err)
	}
}

// end is DELETE /v1/calls/{call_id}: 204 once the call is over, including when
// it already was. Ending a call ends it for everyone, so the caller must be a
// current leaf of the call's group — a participant, not merely someone who may
// see the channel.
func (h *Calls) end(w http.ResponseWriter, r *http.Request) {
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
	bits, err := h.res.Resolve(r.Context(), s.UserID, ch)
	if err != nil {
		server.WriteError(w, err)
		return
	}
	if !bits.Has(PermViewChannel) {
		server.WriteError(w, server.Errorf(server.CodeNotFound, "no such object"))
		return
	}
	if row.Ended != nil {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if row.GroupID == nil {
		server.WriteError(w, server.Errorf(server.CodeLeafNotCurrent, "the call has no group to be a leaf of"))
		return
	}
	group, err := h.repo.GetGroup(r.Context(), *row.GroupID)
	if err != nil {
		server.WriteError(w, notFound(err))
		return
	}
	if err := h.requireCurrentLeaf(r.Context(), group, s.DeviceID); err != nil {
		server.WriteError(w, err)
		return
	}
	if err := h.repo.EndVoiceSession(r.Context(), callID, h.clk.Now().Unix()); err != nil &&
		!errors.Is(err, store.ErrNotFound) {
		// ErrNotFound is a DELETE that raced another: the call is over either way.
		server.WriteError(w, err)
		return
	}
	// protocol/09: DELETE ends the call for everyone, so the room is closed too and every
	// participant still in it is disconnected; the next call opens a fresh room.
	h.closeRoom(r, row.LivekitRoom)
	w.WriteHeader(http.StatusNoContent)
}

// closeRoom closes an ended call's LiveKit room. The call is already over in the record, so a
// failure is logged and never turns the answer into an error; the room's tokens expire within
// their one-hour TTL regardless. The close runs on a context detached from the request, so a
// client that hangs up once it has sent the DELETE cannot leave the room open.
func (h *Calls) closeRoom(r *http.Request, room string) {
	if h.sfu == nil || room == "" {
		return
	}
	ctx, cancel := context.WithTimeout(context.WithoutCancel(r.Context()), roomCloseTimeout)
	defer cancel()
	if err := h.sfu.DeleteRoom(ctx, room); err != nil {
		h.log.WarnContext(ctx, "closing an ended call's LiveKit room failed", "room", room, "err", err)
	}
}

// channel is the {id} a caller may place a call in: a channel it can see (404
// otherwise, as for an unknown one), that carries calls (400 otherwise) and in
// which it holds connect (403 otherwise).
func (h *Calls) channel(r *http.Request) (auth.Session, store.ChannelRow, error) {
	s, err := enrolledSession(r)
	if err != nil {
		return s, store.ChannelRow{}, err
	}
	chID, err := server.PathID(r, "id")
	if err != nil {
		return s, store.ChannelRow{}, err
	}
	ch, err := h.repo.GetChannel(r.Context(), chID)
	if err != nil {
		return s, store.ChannelRow{}, notFound(err)
	}
	bits, err := h.res.Resolve(r.Context(), s.UserID, ch)
	if err != nil {
		return s, store.ChannelRow{}, err
	}
	if !bits.Has(PermViewChannel) {
		return s, store.ChannelRow{}, server.Errorf(server.CodeNotFound, "no such object")
	}
	if !CallGroupAllowed(ch) {
		return s, store.ChannelRow{}, server.Errorf(server.CodeInvalidRequest, "this channel carries no calls")
	}
	if !bits.Has(PermConnect) {
		return s, store.ChannelRow{}, server.Errorf(server.CodeForbidden, "missing permission")
	}
	return s, ch, nil
}

// callGroup is the channel's open call group, the newest when a restore's
// re-creation left more than one open. Its clients register it; with none
// registered yet there is nothing to gate a token on.
func (h *Calls) callGroup(ctx context.Context, ch store.ChannelRow) (store.GroupRow, error) {
	groups, err := h.repo.GroupsForTarget(ctx, ch.ID, GroupCall)
	if err != nil {
		return store.GroupRow{}, err
	}
	if len(groups) == 0 {
		return store.GroupRow{}, server.Errorf(server.CodeNotFound, "no call group is registered for this channel")
	}
	return groups[len(groups)-1], nil
}

// requireCurrentLeaf is the epoch gate: dev holds a leaf of group that was
// added at or before the group's current epoch and has not been removed.
func (h *Calls) requireCurrentLeaf(ctx context.Context, group store.GroupRow, dev id.ID) error {
	if group.EpochUnknown {
		// After a restore the stored epoch is not known to be the group's, so
		// neither is its member list; the group heals first.
		return server.Errorf(server.CodeLeafNotCurrent, "the call group is epoch-unknown until a member heals it")
	}
	members, err := h.repo.ListMembers(ctx, group.GroupID)
	if err != nil {
		return err
	}
	for _, m := range members {
		if m.DeviceID == dev && m.RemovedEpoch == nil && m.AddedEpoch <= group.Epoch {
			return nil
		}
	}
	return server.Errorf(server.CodeLeafNotCurrent, "your device is not a leaf of this call group's current epoch")
}

// callIDOfGroup is R9's companion column: the call id the delivery service
// recorded when the call group was registered. A call group always has one;
// the group id stands in only for a row written without it.
func callIDOfGroup(g store.GroupRow) id.ID {
	if g.CallID != nil {
		return *g.CallID
	}
	return g.GroupID
}

// iceServers is the relay list for dev: one entry carrying a fresh REST
// credential ("<expiry>:<device_id>", HMAC-SHA1 under the TURN secret), or an
// empty list when TURN is off — in behind_proxy without turn.listen the client
// shows its "relay unavailable" dialog and the call is UDP or nothing.
func (h *Calls) iceServers(dev id.ID) []iceServer {
	if h.cfg.TURNSecret == "" || len(h.cfg.TURNURLs) == 0 {
		return []iceServer{}
	}
	ttl := h.cfg.CredentialTTL
	if ttl <= 0 {
		ttl = time.Hour
	}
	user, pass := server.TURNCredential(h.cfg.TURNSecret, dev, ttl, h.clk.Now())
	return []iceServer{{URLs: h.cfg.TURNURLs, Username: user, Credential: pass}}
}
