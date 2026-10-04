package api

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/fxamacker/cbor/v2"
	"github.com/livekit/protocol/livekit"

	"github.com/jonasthim/dilla/internal/auth"
	"github.com/jonasthim/dilla/internal/cborx"
	"github.com/jonasthim/dilla/internal/clock"
	"github.com/jonasthim/dilla/internal/id"
	"github.com/jonasthim/dilla/internal/server"
	"github.com/jonasthim/dilla/internal/sfu"
	"github.com/jonasthim/dilla/internal/store"
)

// CallTokens is the SFU the call routes drive; internal/sfu.(*Server) is one. Token mints a
// room-join JWT whose grants are exactly the permission it is handed (sfu.PublishGrant's mirror of
// speak, video and screen_share) — the gates in front of it are this file's. CreateRoom opens a room
// before any token for it exists (room.auto_create is false). UpdatePermission pushes a complete
// permission to a connected participant, answering sfu.ErrNoParticipant for one the room does not
// hold. RemoveParticipants disconnects a device and its "#" shadows; RemoveParticipant disconnects
// one participant by its exact identity (one that is no device). Participants is the room's list
// for the advisory E_CALL_FULL count and the grant sync. DeleteRoom closes a room and disconnects
// everyone in it, answering nil for a room the SFU does not know.
type CallTokens interface {
	Token(room, identity string, perm *livekit.ParticipantPermission, attrs map[string]string) (string, error)
	DeleteRoom(ctx context.Context, room string) error
	CreateRoom(ctx context.Context, room string) error
	UpdatePermission(ctx context.Context, room, identity string, perm *livekit.ParticipantPermission) error
	RemoveParticipants(ctx context.Context, room string, device id.ID) error
	RemoveParticipant(ctx context.Context, room, identity string) error
	Participants(ctx context.Context, room string) ([]*livekit.ParticipantInfo, error)
}

// CallCounters is the metric surface the call routes move; *obs.Metrics is one. Every counter is
// label-free.
type CallCounters interface {
	CallFull()
	ShareRefused()
	// CallCut counts a participant the grant sync took out of a call room: a device whose user lost
	// view_channel or connect, or an identity that is no device.
	CallCut()
	// CallGrantRetry counts one retry of a cut or demotion that had not landed in the SFU.
	CallGrantRetry()
}

// vdecAttribute is the participant attribute that carries a device's video decode list (DEV-07),
// the calls request's vdec written into its token.
const vdecAttribute = "dilla.vdec"

// defaultMaxSharers is livekit.max_publishers' default, applied when CallsConfig leaves it at zero.
const defaultMaxSharers = 10

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
	// MaxVoiceParticipants is livekit.max_voice_participants, the advisory E_CALL_FULL count's
	// limit; 0 counts nothing. LiveKit's room.max_participants stays authoritative.
	MaxVoiceParticipants int
	// MaxPublishers is livekit.max_publishers: how many devices of one call may hold a sharing slot.
	MaxPublishers int
	// MaxAudioBitrateKbps and MaxShareBitrateKbps are livekit.max_audio_bitrate_kbps and
	// livekit.max_share_bitrate_kbps, handed to clients in the calls response's caps (DEV-26).
	MaxAudioBitrateKbps int
	MaxShareBitrateKbps int
	// VP9 is livekit.vp9 (F4: default off), the caps element's third field.
	VP9 bool
}

// Calls serves protocol/09 § Voice. Register mounts the handlers bare, as the other Plan 2 route
// groups do, and each requires an enrolled session itself.
type Calls struct {
	repo     store.Repository
	res      *Resolver
	sfu      CallTokens
	cfg      CallsConfig
	clk      clock.Clock
	log      *slog.Logger
	leases   *shareLeases
	counters CallCounters
}

// NewCalls wires the call routes over the SFU.
func NewCalls(repo store.Repository, res *Resolver, sfu CallTokens, cfg CallsConfig, clk clock.Clock, log *slog.Logger) *Calls {
	return &Calls{repo: repo, res: res, sfu: sfu, cfg: cfg, clk: clk, log: log, leases: newShareLeases()}
}

// WithCounters sets the label-free counters the routes move and returns h.
func (h *Calls) WithCounters(c CallCounters) *Calls {
	h.counters = c
	return h
}

func (h *Calls) Register(mux *server.Mux) {
	mux.HandleFunc("POST /v1/channels/{id}/calls", h.start)
	mux.HandleFunc("DELETE /v1/calls/{call_id}", h.end)
	mux.HandleFunc("POST /v1/calls/{call_id}/share", h.share)
	mux.HandleFunc("DELETE /v1/calls/{call_id}/share", h.unshare)
}

// callResponse is `[call_id, group_id, livekit_url, token, ice_servers, caps]`.
type callResponse struct {
	_          struct{} `cbor:",toarray"`
	CallID     id.ID
	GroupID    id.ID
	LiveKitURL string
	Token      string
	ICEServers []iceServer
	Caps       callCaps
}

// callCaps is `[max_audio_bitrate_bps, max_share_bitrate_bps, vp9]` (DEV-26, MD-10).
type callCaps struct {
	_                  struct{} `cbor:",toarray"`
	MaxAudioBitrateBPS uint64
	MaxShareBitrateBPS uint64
	VP9                uint64
}

// iceServer is `[urls([tstr]), username(tstr), credential(tstr)]`: the three
// members of an RTCIceServer a client passes to its peer connection.
type iceServer struct {
	_          struct{} `cbor:",toarray"`
	URLs       []string
	Username   string
	Credential string
}

// start is POST /v1/channels/{id}/calls `[]` or `[vdec]`: 201 with a fresh call, or 200 joining the
// call already live in the channel's call group.
//
// The gate is the spec's: a token is minted only for a device whose leaf is present in the call
// group's CURRENT epoch — added at or before it and not removed. A device that has not yet joined
// the group's current epoch and a removed one are refused E_LEAF_NOT_CURRENT, so a device that
// could not decrypt the call's media keys cannot join its room. Then the room is opened in the SFU
// (DEV-44), the advisory participant count may refuse E_CALL_FULL (DEV-01), and the token's grants
// mirror the device's speak/video/screen_share, the video sources only while it holds a sharing
// slot (DEV-02, DEV-03).
func (h *Calls) start(w http.ResponseWriter, r *http.Request) {
	s, ch, bits, err := h.channel(r)
	if err != nil {
		server.WriteError(w, err)
		return
	}
	var body []cbor.RawMessage
	if err := server.DecodeBody(w, r, maxCBORBody, &body); err != nil {
		server.WriteError(w, err)
		return
	}
	vdec, err := decodeVdec(body)
	if err != nil {
		server.WriteError(w, err)
		return
	}
	group, err := h.callGroup(r.Context(), ch)
	if err != nil {
		server.WriteError(w, err)
		return
	}
	// R9: the call is keyed by the call group's call id, which every call group of the channel
	// shares. While a call is live, the group it was opened on (voice_sessions.group_id) is the one
	// its token gate reads.
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
			// The live call's group is closed or gone, so that call cannot go on: once this request
			// passes the gates it ends it and opens the next call on the channel's newest call group.
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
	// An instance with livekit.enabled = false has no SFU to mint a room token from: every gate
	// above answers as it does elsewhere, and a call that would open is 501, before any voice
	// session is recorded for a room nobody can join.
	if h.sfu == nil {
		server.WriteError(w, notImplemented("this instance runs no SFU (livekit.enabled is false)"))
		return
	}
	if endStale {
		if err := h.repo.EndVoiceSession(r.Context(), callID, now); err != nil && !errors.Is(err, store.ErrNotFound) {
			server.WriteError(w, err)
			return
		}
		unlock := h.leases.lockCall(callID)
		h.leases.dropCall(callID)
		unlock()
		h.closeRoom(r, prev.LivekitRoom)
	}

	// PutVoiceSession leaves a live call as it is, so the row read back afterwards is the one call
	// every device of this group lands in, however many start it at once.
	groupID := group.GroupID
	// A fresh room per call, so a device from the previous call cannot linger in this one.
	room := fmt.Sprintf("%s-%d", callID, now)
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
	// Another device may have opened the call on another call group of the channel between the read
	// above and the write: the room belongs to the group the row names.
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
	// DEV-44: the SFU never creates a room on a join (room.auto_create: false), so every start opens
	// it first. CreateRoom is idempotent on a live room, and re-opens one LiveKit reaped (20 s after
	// the last leave, 300 s when nobody joined) while the row was still live.
	if err := h.sfu.CreateRoom(r.Context(), row.LivekitRoom); err != nil {
		h.log.ErrorContext(r.Context(), "opening a LiveKit room failed", "room", row.LivekitRoom, "err", err)
		server.WriteError(w, server.Errorf(server.CodeInternal, "the SFU could not open the room"))
		return
	}
	// A device whose cut or demotion in this call has not landed in the SFU gets no token for it until
	// the repair does; the start is the call's next event, so it drives the repairs first.
	h.retryCall(r.Context(), callID)
	if h.leases.isPending(callID, s.DeviceID) {
		server.WriteError(w, server.Errorf(server.CodeForbidden, "your device's access to this call is being revoked"))
		return
	}
	if h.callFull(r.Context(), row.LivekitRoom, s.DeviceID) {
		server.WriteError(w, server.Errorf(server.CodeCallFull, "the call is full"))
		return
	}
	var attrs map[string]string
	if vdec != "" {
		attrs = map[string]string{vdecAttribute: vdec}
	}
	token, err := h.sfu.Token(row.LivekitRoom, s.DeviceID.String(), h.grantFor(bits, callID, s.DeviceID), attrs)
	if err != nil {
		h.log.ErrorContext(r.Context(), "minting a LiveKit token failed", "err", err)
		server.WriteError(w, server.Errorf(server.CodeInternal, "the SFU could not mint a token"))
		return
	}
	if err := server.EncodeBody(w, status, callResponse{
		CallID: callID, GroupID: groupID, LiveKitURL: h.cfg.LiveKitURL, Token: token,
		ICEServers: h.iceServers(s.DeviceID), Caps: h.caps(),
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
	// participant still in it is disconnected; the next call opens a fresh room. The next call keeps
	// this call id (R9), so the sharing slots go with this one.
	unlock := h.leases.lockCall(callID)
	h.leases.dropCall(callID)
	unlock()
	h.closeRoom(r, row.LivekitRoom)
	w.WriteHeader(http.StatusNoContent)
}

// closeRoom closes an ended call's LiveKit room. The call is already over in the record, so a
// failure is logged and never turns the answer into an error. A failure matters: LiveKit re-mints a
// connected participant's token every five minutes, so a room that stays open keeps its
// participants until a later DeleteRoom; room.auto_create is false, so nobody can rejoin it once it
// is gone. The close runs on a context detached from the request, so a client that hangs up once it
// has sent the DELETE cannot leave the room open.
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

// channel is the {id} a caller may place a call in: a channel it can see (404 otherwise, as for an
// unknown one), that carries calls (400 otherwise) and in which it holds connect (403 otherwise),
// with the caller's resolved bits there.
func (h *Calls) channel(r *http.Request) (auth.Session, store.ChannelRow, Bits, error) {
	s, err := enrolledSession(r)
	if err != nil {
		return s, store.ChannelRow{}, 0, err
	}
	chID, err := server.PathID(r, "id")
	if err != nil {
		return s, store.ChannelRow{}, 0, err
	}
	ch, err := h.repo.GetChannel(r.Context(), chID)
	if err != nil {
		return s, store.ChannelRow{}, 0, notFound(err)
	}
	bits, err := h.res.Resolve(r.Context(), s.UserID, ch)
	if err != nil {
		return s, store.ChannelRow{}, 0, err
	}
	if !bits.Has(PermViewChannel) {
		return s, store.ChannelRow{}, 0, server.Errorf(server.CodeNotFound, "no such object")
	}
	if !CallGroupAllowed(ch) {
		return s, store.ChannelRow{}, 0, server.Errorf(server.CodeInvalidRequest, "this channel carries no calls")
	}
	if !bits.Has(PermConnect) {
		return s, store.ChannelRow{}, 0, server.Errorf(server.CodeForbidden, "missing permission")
	}
	return s, ch, bits, nil
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

// videoDecoders are the names a vdec list may carry (protocol/05's negotiable video codecs).
var videoDecoders = map[string]bool{"vp8": true, "h264": true, "vp9": true}

// decodeVdec is the calls request body: [] or [vdec], vdec being the comma-separated lowercase
// decoders of the requesting device, each at most once (MD-10).
func decodeVdec(body []cbor.RawMessage) (string, error) {
	switch len(body) {
	case 0:
		return "", nil
	case 1:
	default:
		return "", server.Errorf(server.CodeInvalidRequest, "the body is [] or [vdec]")
	}
	var vdec string
	if err := cborx.Unmarshal(body[0], &vdec); err != nil {
		return "", server.Errorf(server.CodeInvalidRequest, "vdec is a text string")
	}
	seen := map[string]bool{}
	for _, name := range strings.Split(vdec, ",") {
		if !videoDecoders[name] || seen[name] {
			return "", server.Errorf(server.CodeInvalidRequest,
				"vdec is a comma-separated list of vp8, h264 and vp9, each at most once")
		}
		seen[name] = true
	}
	return vdec, nil
}

// caps is the calls response's sixth element: the bitrate ceilings a client applies to its publish
// options, in bits per second, and whether VP9 is enabled at all (DEV-26, F4).
func (h *Calls) caps() callCaps {
	c := callCaps{
		MaxAudioBitrateBPS: uint64(max(h.cfg.MaxAudioBitrateKbps, 0)) * 1000,
		MaxShareBitrateBPS: uint64(max(h.cfg.MaxShareBitrateKbps, 0)) * 1000,
	}
	if h.cfg.VP9 {
		c.VP9 = 1
	}
	return c
}

// grantFor is dev's permission in the call: its speak/video/screen_share bits, the video sources
// only while it holds a sharing slot of the call (ruling F1).
func (h *Calls) grantFor(bits Bits, callID, dev id.ID) *livekit.ParticipantPermission {
	leased := h.leases.held(callID, dev)
	return sfu.PublishGrant(bits.Has(PermSpeak), bits.Has(PermVideo) && leased, bits.Has(PermScreenShare) && leased)
}

// callFull is the advisory E_CALL_FULL count (DEV-01, gap G27): the room's participants other than
// the caller's own device and its "#" shadows (a rejoin replaces the old session before LiveKit's
// own count), disconnected ones, agents and egress. It fails open: LiveKit's room.max_participants
// is the authoritative cap, and a device that passes this count in a race gets LiveKit's upgrade
// refusal instead.
func (h *Calls) callFull(ctx context.Context, room string, dev id.ID) bool {
	limit := h.cfg.MaxVoiceParticipants
	if limit <= 0 {
		return false
	}
	parts, err := h.sfu.Participants(ctx, room)
	if err != nil {
		h.log.WarnContext(ctx, "counting a call's participants failed; minting anyway", "room", room, "err", err)
		return false
	}
	self := dev.String()
	n := 0
	for _, p := range parts {
		identity := p.GetIdentity()
		if identity == self || strings.HasPrefix(identity, self+"#") {
			continue
		}
		if p.GetState() == livekit.ParticipantInfo_DISCONNECTED {
			continue
		}
		if k := p.GetKind(); k == livekit.ParticipantInfo_AGENT || k == livekit.ParticipantInfo_EGRESS {
			continue
		}
		n++
	}
	if n < limit {
		return false
	}
	if h.counters != nil {
		h.counters.CallFull()
	}
	return true
}

// CurrentLeafOfRoom is the /rtc join gate (DEV-25, DEV-44): room must be the live room of a call —
// "<call_id hex>-<unix>", equal to voice_sessions.livekit_room with the call not ended — and device a
// current leaf of the call group that room was opened on. A malformed or stale room is false, not
// an error; only a store failure is.
func (h *Calls) CurrentLeafOfRoom(ctx context.Context, room string, device id.ID) (bool, error) {
	callHex, _, ok := strings.Cut(room, "-")
	if !ok {
		return false, nil
	}
	callID, err := id.Parse(callHex)
	if err != nil {
		return false, nil //nolint:nilerr // a room name that is no call's is a refusal, not a failure
	}
	row, err := h.repo.GetVoiceSession(ctx, callID)
	if errors.Is(err, store.ErrNotFound) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	if row.Ended != nil || row.LivekitRoom != room {
		return false, nil
	}
	// A device whose cut or demotion has not landed in the SFU does not rejoin until it has.
	h.retryCall(ctx, callID)
	if h.leases.isPending(callID, device) {
		return false, nil
	}
	err = h.requireLeafOfCall(ctx, row, device)
	var se *server.Error
	switch {
	case err == nil:
		return true, nil
	case errors.As(err, &se):
		return false, nil
	default:
		return false, err
	}
}
