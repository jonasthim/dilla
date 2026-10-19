package api

import (
	"context"
	"errors"
	"net/http"
	"slices"
	"strings"
	"time"

	"github.com/jonasthim/dilla/internal/id"
	"github.com/jonasthim/dilla/internal/server"
	"github.com/jonasthim/dilla/internal/store"
)

type afkTracked struct {
	community, channel, user id.ID
	lastActive               time.Time
}
type afkOccupant struct {
	community, channel, user id.ID
	moving                   bool
}
type afkPerson struct {
	_      struct{} `cbor:",toarray"`
	User   id.ID
	Device id.ID
}
type afkSnapshot struct {
	_              struct{} `cbor:",toarray"`
	ChannelID      *id.ID
	TimeoutSeconds uint64
	Occupants      []afkPerson
}
type afkActivityBody struct {
	_         struct{} `cbor:",toarray"`
	ChannelID id.ID
}

// An SFU admission starts the device's timer even if its browser never gets to send
// the first activity report. A signalling resume keeps the original timer.
func (h *Calls) trackAFKAdmission(ctx context.Context, row store.VoiceSessionRow, dev id.ID) {
	ch, err := h.repo.GetChannel(ctx, row.ChannelID)
	if err != nil || ch.CommunityID == nil || ch.Kind != ChannelVoice {
		return
	}
	dv, err := h.repo.GetDevice(ctx, dev)
	if err != nil {
		return
	}
	h.afkMu.Lock()
	defer h.afkMu.Unlock()
	if _, occupied := h.afkOccupied[dev]; occupied {
		return
	}
	if current, exists := h.afkTracked[dev]; exists && current.channel == ch.ID {
		return
	}
	if h.afkTracked == nil {
		h.afkTracked = make(map[id.ID]afkTracked)
	}
	h.afkTracked[dev] = afkTracked{community: *ch.CommunityID, channel: ch.ID, user: dv.UserID, lastActive: h.clk.Now()}
}

// WithAFKLive binds occupancy to a live gateway connection. A suspended but still connected
// browser remains AFK; a truly disconnected device disappears from the roster.
func (h *Calls) WithAFKLive(online interface{ Online(id.ID) bool }, notify *StructureNotifier) *Calls {
	h.afkOnline, h.afkNotify = online, notify
	return h
}

func (h *Calls) registerAFK(mux *server.Mux) {
	mux.HandleFunc("GET /v1/communities/{id}/afk", h.afkSnapshot)
	mux.HandleFunc("POST /v1/communities/{id}/afk/activity", h.afkActivity)
	mux.HandleFunc("POST /v1/communities/{id}/afk", h.afkManual)
	mux.HandleFunc("DELETE /v1/communities/{id}/afk", h.afkLeave)
}

func (h *Calls) afkMember(r *http.Request) (id.ID, id.ID, id.ID, error) {
	s, err := enrolledSession(r)
	if err != nil {
		return id.ID{}, id.ID{}, id.ID{}, err
	}
	cid, err := server.PathID(r, "id")
	if err != nil {
		return cid, s.UserID, s.DeviceID, err
	}
	if _, err := h.repo.GetCommunity(r.Context(), cid); err != nil {
		return cid, s.UserID, s.DeviceID, notFound(err)
	}
	if _, err := h.repo.GetMember(r.Context(), cid, s.UserID); err != nil {
		return cid, s.UserID, s.DeviceID, notFound(err)
	}
	return cid, s.UserID, s.DeviceID, nil
}

func (h *Calls) afkDestination(ctx context.Context, cid, user id.ID) (store.CommunityAFK, error) {
	cfg, err := h.repo.GetCommunityAFK(ctx, cid)
	if err != nil || cfg.ChannelID == nil {
		return cfg, err
	}
	ch, err := h.repo.GetChannel(ctx, *cfg.ChannelID)
	if errors.Is(err, store.ErrNotFound) {
		cfg.ChannelID = nil
		return cfg, nil
	}
	if err != nil {
		return cfg, err
	}
	if ch.CommunityID == nil || *ch.CommunityID != cid || ch.Kind != ChannelVoice {
		cfg.ChannelID = nil
		return cfg, nil
	}
	bits, err := h.res.Resolve(ctx, user, ch)
	if err != nil {
		return cfg, err
	}
	if !bits.Has(PermViewChannel) || !bits.Has(PermConnect) {
		cfg.ChannelID = nil
	}
	return cfg, nil
}

func (h *Calls) refuseAFK(ctx context.Context, ch store.ChannelRow, device id.ID) error {
	if ch.CommunityID == nil {
		return nil
	}
	cfg, err := h.repo.GetCommunityAFK(ctx, *ch.CommunityID)
	if err != nil {
		return err
	}
	if cfg.ChannelID != nil && *cfg.ChannelID == ch.ID {
		return server.Errorf(server.CodeForbidden, "AFK is a silent channel")
	}
	h.afkMu.Lock()
	_, occupied := h.afkOccupied[device]
	h.afkMu.Unlock()
	if occupied {
		return server.Errorf(server.CodeForbidden, "leave AFK before joining voice")
	}
	return nil
}

func (h *Calls) afkSnapshot(w http.ResponseWriter, r *http.Request) {
	cid, user, _, err := h.afkMember(r)
	if err != nil {
		server.WriteError(w, err)
		return
	}
	cfg, err := h.afkDestination(r.Context(), cid, user)
	if err != nil {
		server.WriteError(w, err)
		return
	}
	out := afkSnapshot{ChannelID: cfg.ChannelID, TimeoutSeconds: cfg.TimeoutSeconds, Occupants: []afkPerson{}}
	if cfg.ChannelID != nil {
		h.afkMu.Lock()
		for dev, p := range h.afkOccupied {
			if p.community == cid && p.channel == *cfg.ChannelID && !p.moving && (h.afkOnline == nil || h.afkOnline.Online(dev)) {
				out.Occupants = append(out.Occupants, afkPerson{User: p.user, Device: dev})
			}
		}
		h.afkMu.Unlock()
		slices.SortFunc(out.Occupants, func(a, b afkPerson) int { return strings.Compare(a.Device.String(), b.Device.String()) })
	}
	if err := server.EncodeBody(w, http.StatusOK, out); err != nil {
		h.log.WarnContext(r.Context(), "write AFK snapshot", "err", err)
	}
}

func (h *Calls) afkActivity(w http.ResponseWriter, r *http.Request) {
	cid, user, dev, err := h.afkMember(r)
	if err != nil {
		server.WriteError(w, err)
		return
	}
	var body afkActivityBody
	if err := server.DecodeBody(w, r, maxCBORBody, &body); err != nil {
		server.WriteError(w, err)
		return
	}
	ch, err := h.repo.GetChannel(r.Context(), body.ChannelID)
	if err != nil || ch.CommunityID == nil || *ch.CommunityID != cid || ch.Kind != ChannelVoice {
		server.WriteError(w, server.Errorf(server.CodeInvalidRequest, "activity must name a community voice channel"))
		return
	}
	cfg, err := h.afkDestination(r.Context(), cid, user)
	if err != nil {
		server.WriteError(w, err)
		return
	}
	if cfg.ChannelID == nil || *cfg.ChannelID == ch.ID {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	row, live, err := h.liveCallOf(r.Context(), ch, nil)
	if err != nil {
		server.WriteError(w, err)
		return
	}
	if !live || row.Ended != nil {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	h.afkMu.Lock()
	if _, afk := h.afkOccupied[dev]; !afk {
		if h.afkTracked == nil {
			h.afkTracked = make(map[id.ID]afkTracked)
		}
		h.afkTracked[dev] = afkTracked{community: cid, channel: ch.ID, user: user, lastActive: h.clk.Now()}
	}
	h.afkMu.Unlock()
	w.WriteHeader(http.StatusNoContent)
}

func (h *Calls) afkManual(w http.ResponseWriter, r *http.Request) {
	cid, user, dev, err := h.afkMember(r)
	if err != nil {
		server.WriteError(w, err)
		return
	}
	var body afkActivityBody
	if err := server.DecodeBody(w, r, maxCBORBody, &body); err != nil {
		server.WriteError(w, err)
		return
	}
	if err := h.moveAFK(r.Context(), dev, afkTracked{community: cid, channel: body.ChannelID, user: user}, nil); err != nil {
		server.WriteError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (h *Calls) afkLeave(w http.ResponseWriter, r *http.Request) {
	cid, _, dev, err := h.afkMember(r)
	if err != nil {
		server.WriteError(w, err)
		return
	}
	h.afkMu.Lock()
	p, ok := h.afkOccupied[dev]
	if ok && p.community == cid && p.moving {
		h.afkMu.Unlock()
		server.WriteError(w, server.Errorf(server.CodeInvalidRequest, "AFK move is still completing"))
		return
	}
	if ok && p.community == cid {
		delete(h.afkOccupied, dev)
		delete(h.afkTracked, dev)
	}
	h.afkMu.Unlock()
	if ok && p.community == cid {
		h.afkNotify.Changed(afterCommit(r), cid)
	}
	w.WriteHeader(http.StatusNoContent)
}

// moveAFK blocks re-entry before cutting the SFU participant. A failed cut rolls back the
// occupancy marker so the next sweep may retry. There is no media call in the AFK destination.
func (h *Calls) moveAFK(ctx context.Context, dev id.ID, tracked afkTracked, expected *time.Time) error {
	cfg, err := h.afkDestination(ctx, tracked.community, tracked.user)
	if err != nil {
		return err
	}
	if cfg.ChannelID == nil {
		return server.Errorf(server.CodeInvalidRequest, "AFK is disabled or inaccessible")
	}
	if tracked.channel == *cfg.ChannelID {
		return server.Errorf(server.CodeInvalidRequest, "already in AFK")
	}
	ch, err := h.repo.GetChannel(ctx, tracked.channel)
	if err != nil || ch.CommunityID == nil || *ch.CommunityID != tracked.community || ch.Kind != ChannelVoice {
		return server.Errorf(server.CodeInvalidRequest, "source must be a community voice channel")
	}
	row, live, err := h.liveCallOf(ctx, ch, nil)
	if err != nil {
		return err
	}
	if !live || h.sfu == nil {
		return server.Errorf(server.CodeInvalidRequest, "device is not in a live call")
	}
	checkCtx, cancel := sfuCtx(ctx)
	parts, err := h.sfu.Participants(checkCtx, row.LivekitRoom)
	cancel()
	if err != nil {
		return err
	}
	present := false
	for _, p := range parts {
		base, _, _ := strings.Cut(p.GetIdentity(), "#")
		if base == dev.String() {
			present = true
			break
		}
	}
	if !present {
		return server.Errorf(server.CodeInvalidRequest, "device is not in this call")
	}
	h.afkMu.Lock()
	if h.afkOccupied == nil {
		h.afkOccupied = make(map[id.ID]afkOccupant)
	}
	if expected != nil {
		current, ok := h.afkTracked[dev]
		if !ok || current.channel != tracked.channel || !current.lastActive.Equal(*expected) {
			h.afkMu.Unlock()
			return nil // fresh activity or a different call won the race
		}
	}
	if _, exists := h.afkOccupied[dev]; exists {
		h.afkMu.Unlock()
		return nil
	}
	h.afkOccupied[dev] = afkOccupant{community: tracked.community, channel: *cfg.ChannelID, user: tracked.user, moving: true}
	h.afkMu.Unlock()
	removeCtx, cancel := sfuCtx(context.WithoutCancel(ctx))
	err = h.sfu.RemoveParticipants(removeCtx, row.LivekitRoom, dev)
	cancel()
	if err != nil {
		h.afkMu.Lock()
		delete(h.afkOccupied, dev)
		h.afkMu.Unlock()
		return err
	}
	h.revokeRelay(dev)
	h.afkMu.Lock()
	if p, ok := h.afkOccupied[dev]; ok && p.moving && p.community == tracked.community && p.channel == *cfg.ChannelID {
		p.moving = false
		h.afkOccupied[dev] = p
	}
	delete(h.afkTracked, dev)
	h.afkMu.Unlock()
	h.afkNotify.Changed(context.WithoutCancel(ctx), tracked.community)
	return nil
}

// SweepAFK enforces inactivity in the server even if the browser's timers stop. It also drops
// stale occupancy after a true gateway disconnect, removed membership, or removed destination.
func (h *Calls) SweepAFK(ctx context.Context) {
	h.afkMu.Lock()
	tracked := make(map[id.ID]afkTracked, len(h.afkTracked))
	for dev, row := range h.afkTracked {
		tracked[dev] = row
	}
	occupied := make(map[id.ID]afkOccupant, len(h.afkOccupied))
	for dev, row := range h.afkOccupied {
		occupied[dev] = row
	}
	h.afkMu.Unlock()
	for dev, p := range occupied {
		cfg, err := h.afkDestination(ctx, p.community, p.user)
		_, memberErr := h.repo.GetMember(ctx, p.community, p.user)
		if err != nil || memberErr != nil || cfg.ChannelID == nil || *cfg.ChannelID != p.channel || (h.afkOnline != nil && !h.afkOnline.Online(dev)) {
			h.afkMu.Lock()
			delete(h.afkOccupied, dev)
			h.afkMu.Unlock()
			h.afkNotify.Changed(ctx, p.community)
		}
	}
	for dev, p := range tracked {
		cfg, err := h.afkDestination(ctx, p.community, p.user)
		if err != nil || cfg.ChannelID == nil {
			h.afkMu.Lock()
			delete(h.afkTracked, dev)
			h.afkMu.Unlock()
			continue
		}
		if h.clk.Since(p.lastActive) < afkTimeout(cfg.TimeoutSeconds) {
			continue
		}
		if err := h.moveAFK(ctx, dev, p, &p.lastActive); err != nil {
			// A departed caller cannot be moved. Keep only errors worth retrying; a new
			// interaction starts a fresh timer if this device joins again.
			var se *server.Error
			if errors.As(err, &se) {
				h.afkMu.Lock()
				delete(h.afkTracked, dev)
				h.afkMu.Unlock()
			}
		}
	}
}

func afkTimeout(seconds uint64) time.Duration {
	switch seconds {
	case 60:
		return time.Minute
	case 900:
		return 15 * time.Minute
	case 1800:
		return 30 * time.Minute
	case 3600:
		return time.Hour
	default:
		return 5 * time.Minute
	}
}
