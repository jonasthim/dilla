package service

import (
	"context"
	"errors"
	"math"

	"github.com/jonasthim/dilla/internal/bot/music"
	"github.com/jonasthim/dilla/internal/bot/music/persistence"
	"github.com/jonasthim/dilla/internal/bot/protocol"
	"github.com/jonasthim/dilla/internal/cborx"
	"github.com/jonasthim/dilla/internal/id"
)

// MusicCallBinding is the live call identity for the requested voice channel.
// A missing/inactive call makes all operations unavailable.
type MusicCallBinding struct {
	CallID    id.ID
	ChannelID id.ID
	Active    bool
}

// MusicInteractionAuthority must resolve these checks from current server
// state. CanDJ must require both the configured DJ role and actor membership
// in the specified voice call. CanEmergencyStop is reserved for owner/admin.
type MusicInteractionAuthority interface {
	CurrentCall(context.Context, id.ID) (MusicCallBinding, error)
	CanUse(context.Context, InteractionActor, MusicCallBinding) (bool, error)
	CanDJ(context.Context, InteractionActor, MusicCallBinding) (bool, error)
	CanEmergencyStop(context.Context, InteractionActor, MusicCallBinding) (bool, error)
}

type musicStateStore interface {
	Load(context.Context, id.ID) (persistence.Snapshot, error)
	Save(context.Context, id.ID, uint64, music.State) (persistence.Snapshot, error)
}

// MusicInteractions updates only encrypted queue state. It does not control
// audio; a playback supervisor must consume these revisions separately.
type MusicInteractions struct {
	Store          musicStateStore
	Authority      MusicInteractionAuthority
	InstallationID id.ID
	CommunityID    id.ID
	// OnPersistedSnapshot refreshes a retained paused runtime after a successful
	// queue-state commit. It receives only server-bound identity and the saved revision.
	OnPersistedSnapshot func(context.Context, id.ID, id.ID, id.ID, uint64)
}

func (h MusicInteractions) Handlers() map[protocol.Operation]InteractionHandlerSpec {
	ops := []protocol.Operation{
		protocol.OpMusicState, protocol.OpMusicSearch, protocol.OpMusicEnqueue,
		protocol.OpMusicPause, protocol.OpMusicResume, protocol.OpMusicSkip,
		protocol.OpMusicStop, protocol.OpMusicSeek, protocol.OpMusicVolume,
		protocol.OpMusicShuffle, protocol.OpMusicRepeat, protocol.OpMusicRemove,
		protocol.OpMusicMove, protocol.OpMusicClear,
	}
	result := make(map[protocol.Operation]InteractionHandlerSpec, len(ops))
	for _, op := range ops {
		operation := op
		spec := InteractionHandlerSpec{AllowMusicChannelContext: true, Handle: func(ctx context.Context, actor InteractionActor, req protocol.Request) (InteractionResult, error) {
			return h.handle(ctx, actor, req, operation)
		}}
		if operation != protocol.OpMusicState && operation != protocol.OpMusicSearch {
			spec.RevisionInHandler = true
		}
		result[operation] = spec
	}
	return result
}

func (h MusicInteractions) handle(ctx context.Context, actor InteractionActor, req protocol.Request, op protocol.Operation) (InteractionResult, error) {
	if h.Store == nil || h.Authority == nil || h.CommunityID.IsZero() || req.CommunityID != h.CommunityID || req.ChannelID == nil || req.ChannelID.IsZero() {
		return InteractionResult{}, errors.New("missing music interaction dependency or context")
	}
	channel := *req.ChannelID
	call, err := h.Authority.CurrentCall(ctx, channel)
	if err != nil {
		return InteractionResult{}, err
	}
	if !validMusicCall(call, channel) {
		return InteractionResult{Status: interactionStatusUnavailable}, nil
	}
	allowed, err := h.Authority.CanUse(ctx, actor, call)
	if err != nil {
		return InteractionResult{}, err
	}
	if !allowed {
		return InteractionResult{Status: interactionStatusForbidden}, nil
	}
	if op == protocol.OpMusicSearch || op == protocol.OpMusicEnqueue {
		return InteractionResult{Status: interactionStatusUnavailable}, nil
	}
	snapshot, err := h.Store.Load(ctx, channel)
	if err != nil {
		return InteractionResult{}, err
	}
	if op == protocol.OpMusicState {
		data, err := encodeMusicSnapshot(snapshot.State)
		if err != nil {
			return InteractionResult{}, err
		}
		revision := snapshot.Revision
		return InteractionResult{Status: 0, Revision: &revision, Data: data}, nil
	}
	if req.Revision == nil || *req.Revision != snapshot.Revision {
		revision := snapshot.Revision
		return InteractionResult{Status: interactionStatusConflict, Revision: &revision}, nil
	}
	if op == protocol.OpMusicStop {
		allowed, err = h.Authority.CanDJ(ctx, actor, call)
		if err != nil {
			return InteractionResult{}, err
		}
		if !allowed {
			allowed, err = h.Authority.CanEmergencyStop(ctx, actor, call)
			if err != nil {
				return InteractionResult{}, err
			}
		}
	} else {
		allowed, err = h.Authority.CanDJ(ctx, actor, call)
	}
	if err != nil {
		return InteractionResult{}, err
	}
	if !allowed {
		return InteractionResult{Status: interactionStatusForbidden}, nil
	}
	opValue, ok := musicOperation(op, req.Args)
	if !ok {
		return InteractionResult{Status: interactionStatusUnavailable}, nil
	}
	if op == protocol.OpMusicShuffle {
		opValue.Enabled = !snapshot.State.Shuffle
	}
	next, err := music.Apply(snapshot.State, snapshot.Revision, opValue)
	if errors.Is(err, music.ErrRevisionConflict) {
		return InteractionResult{Status: interactionStatusConflict}, nil
	}
	if errors.Is(err, music.ErrInvalidOperation) || errors.Is(err, music.ErrInvalidTrack) || errors.Is(err, music.ErrQueueFull) {
		return InteractionResult{Status: interactionStatusUnavailable}, nil
	}
	if err != nil {
		return InteractionResult{}, err
	}
	// Recheck the call binding and role immediately before CAS persistence.
	current, err := h.Authority.CurrentCall(ctx, channel)
	if err != nil {
		return InteractionResult{}, err
	}
	if current != call {
		return InteractionResult{Status: interactionStatusConflict}, nil
	}
	if op == protocol.OpMusicStop {
		allowed, err = h.Authority.CanDJ(ctx, actor, current)
		if err != nil {
			return InteractionResult{}, err
		}
		if !allowed {
			allowed, err = h.Authority.CanEmergencyStop(ctx, actor, current)
			if err != nil {
				return InteractionResult{}, err
			}
		}
	} else {
		allowed, err = h.Authority.CanDJ(ctx, actor, current)
	}
	if err != nil {
		return InteractionResult{}, err
	}
	if !allowed {
		return InteractionResult{Status: interactionStatusForbidden}, nil
	}
	saved, err := h.Store.Save(ctx, channel, snapshot.Revision, next)
	if errors.Is(err, persistence.ErrConflict) || errors.Is(err, music.ErrRevisionConflict) {
		return InteractionResult{Status: interactionStatusConflict}, nil
	}
	if err != nil {
		return InteractionResult{}, err
	}
	if h.OnPersistedSnapshot != nil {
		h.OnPersistedSnapshot(ctx, h.InstallationID, h.CommunityID, channel, saved.Revision)
	}
	revision := saved.Revision
	return InteractionResult{Status: 0, Revision: &revision, Data: []byte{0x80}}, nil
}

func validMusicCall(call MusicCallBinding, channel id.ID) bool {
	return call.Active && !call.CallID.IsZero() && call.ChannelID == channel
}

func musicOperation(op protocol.Operation, args []any) (music.Operation, bool) {
	operation := music.Operation{}
	uint := func(i int) (uint64, bool) {
		if i >= len(args) {
			return 0, false
		}
		v, ok := args[i].(uint64)
		return v, ok
	}
	item := func(i int) (string, bool) {
		if i >= len(args) {
			return "", false
		}
		v, ok := args[i].(id.ID)
		return v.String(), ok && !v.IsZero()
	}
	switch op {
	case protocol.OpMusicPause:
		operation.Kind = music.OpPause
	case protocol.OpMusicResume:
		operation.Kind = music.OpResume
	case protocol.OpMusicSkip:
		operation.Kind = music.OpSkip
	case protocol.OpMusicStop:
		operation.Kind = music.OpStop
	case protocol.OpMusicClear:
		operation.Kind = music.OpClear
	case protocol.OpMusicSeek:
		v, ok := uint(0)
		if !ok || v > math.MaxInt64 {
			return operation, false
		}
		operation.Kind, operation.PositionMS = music.OpSeek, int64(v)
	case protocol.OpMusicVolume:
		v, ok := uint(0)
		if !ok || v > 100 {
			return operation, false
		}
		operation.Kind, operation.Volume = music.OpSetVolume, uint8(v)
	case protocol.OpMusicShuffle:
		operation.Kind, operation.Enabled = music.OpSetShuffle, true
	case protocol.OpMusicRepeat:
		v, ok := uint(0)
		if !ok || v > uint64(music.RepeatQueue) {
			return operation, false
		}
		operation.Kind, operation.Repeat = music.OpSetRepeat, music.RepeatMode(v)
	case protocol.OpMusicRemove:
		v, ok := item(0)
		if !ok {
			return operation, false
		}
		operation.Kind, operation.ItemID = music.OpRemove, v
	case protocol.OpMusicMove:
		v, ok := item(0)
		if !ok || len(args) < 2 {
			return operation, false
		}
		operation.Kind, operation.ItemID = music.OpReorder, v
		if args[1] != nil {
			before, ok := item(1)
			if !ok {
				return operation, false
			}
			operation.BeforeID = before
		}
	default:
		return operation, false
	}
	return operation, true
}

func encodeMusicSnapshot(state music.State) ([]byte, error) {
	track := func(t *music.Track) any {
		if t == nil {
			return nil
		}
		return []any{t.ID, string(t.Provider), t.CanonicalID, t.Title, t.Artist, t.Album, uint64(t.DurationMS), t.RequesterID}
	}
	queue := make([]any, 0, len(state.Queue))
	for i := range state.Queue {
		t := state.Queue[i]
		queue = append(queue, track(&t))
	}
	current := track(state.Current)
	return cborx.Marshal([]any{uint64(1), state.Revision, current, queue, uint64(state.PositionMS), boolUint(state.Paused), uint64(state.Volume), boolUint(state.Shuffle), uint64(state.Repeat), false})
}
