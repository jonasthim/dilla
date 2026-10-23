package service

import (
	"context"
	"errors"
	"math"
	"net/url"
	"strings"
	"time"

	"github.com/jonasthim/dilla/internal/bot/music"
	"github.com/jonasthim/dilla/internal/bot/music/persistence"
	"github.com/jonasthim/dilla/internal/bot/music/youtube"
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

type musicRuntimeStateReader func(context.Context, id.ID, id.ID, id.ID) (music.State, uint64, error)

type MusicTrackResolver interface {
	Resolve(context.Context, string) ([]music.Track, error)
}

type SpotifyMusicTrackResolver interface {
	ResolveSpotify(context.Context, string, id.ID) ([]music.Track, error)
}

// MusicInteractions updates only encrypted queue state. It does not control
// audio; a playback supervisor must consume these revisions separately.
type MusicInteractions struct {
	Store           musicStateStore
	Authority       MusicInteractionAuthority
	Resolver        MusicTrackResolver
	SpotifyResolver SpotifyMusicTrackResolver
	InstallationID  id.ID
	CommunityID     id.ID
	// CurrentState exposes the retained supervisor's live state. The handler
	// accepts it only when its revision still matches the durable store row.
	CurrentState musicRuntimeStateReader
	// Now makes the write-boundary expiry check deterministic in tests. Nil uses
	// the system clock.
	Now func() time.Time
	// OnPersistedSnapshot applies the exact state returned by a successful CAS
	// commit. The liveResume flag is true only for an explicit Resume operation.
	OnPersistedSnapshot func(context.Context, id.ID, id.ID, id.ID, music.State, uint64, bool) (uint64, error)
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
	if op == protocol.OpMusicSearch {
		if h.Resolver == nil || len(req.Args) != 1 {
			return InteractionResult{Status: interactionStatusUnavailable}, nil
		}
		query, ok := req.Args[0].(string)
		if !ok {
			return InteractionResult{Status: interactionStatusUnavailable}, nil
		}
		tracks, resolveErr := h.Resolver.Resolve(ctx, query)
		if resolveErr != nil || len(tracks) > youtube.MaxSearchResults {
			return InteractionResult{Status: interactionStatusUnavailable}, nil
		}
		data, encodeErr := encodeMusicSearchResults(tracks)
		if encodeErr != nil {
			return InteractionResult{Status: interactionStatusUnavailable}, nil
		}
		return InteractionResult{Status: 0, Data: data}, nil
	}
	snapshot, err := h.Store.Load(ctx, channel)
	if err != nil {
		return InteractionResult{}, err
	}
	if h.CurrentState != nil {
		state, revision, err := h.CurrentState(ctx, h.InstallationID, h.CommunityID, channel)
		if err != nil {
			return InteractionResult{}, err
		}
		if revision != snapshot.Revision || state.Revision != snapshot.Revision {
			currentRevision := snapshot.Revision
			return InteractionResult{Status: interactionStatusConflict, Revision: &currentRevision}, nil
		}
		snapshot.State = state
	}
	if op == protocol.OpMusicState {
		canControl, err := h.Authority.CanDJ(ctx, actor, call)
		if err != nil {
			return InteractionResult{}, err
		}
		data, err := encodeMusicSnapshot(snapshot.State, canControl)
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
	var opValue music.Operation
	if op == protocol.OpMusicEnqueue {
		if len(req.Args) != 1 {
			return InteractionResult{Status: interactionStatusUnavailable}, nil
		}
		input, ok := req.Args[0].(string)
		if !ok {
			return InteractionResult{Status: interactionStatusUnavailable}, nil
		}
		var tracks []music.Track
		var resolveErr error
		spotifyInput := isSpotifyCatalogInput(input)
		if spotifyInput {
			if h.SpotifyResolver == nil {
				return InteractionResult{Status: interactionStatusUnavailable}, nil
			}
			tracks, resolveErr = h.SpotifyResolver.ResolveSpotify(ctx, input, actor.User)
		} else {
			if h.Resolver == nil {
				return InteractionResult{Status: interactionStatusUnavailable}, nil
			}
			tracks, resolveErr = h.Resolver.Resolve(ctx, input)
		}
		if resolveErr != nil || len(tracks) == 0 || len(tracks) > youtube.MaxPlaylistItems || (spotifyInput && len(tracks) > 500) {
			return InteractionResult{Status: interactionStatusUnavailable}, nil
		}
		for i := range tracks {
			if spotifyInput && tracks[i].Provider != music.ProviderSpotify || !spotifyInput && tracks[i].Provider != music.ProviderYouTube {
				return InteractionResult{Status: interactionStatusUnavailable}, nil
			}
			tracks[i].ID = id.New().String()
			tracks[i].RequesterID = actor.User.String()
		}
		kind := music.OpEnqueue
		if len(tracks) > 1 {
			kind = music.OpImportPlaylist
		}
		opValue = music.Operation{Kind: kind, Tracks: tracks}
	} else {
		var ok bool
		opValue, ok = musicOperation(op, req.Args)
		if !ok {
			return InteractionResult{Status: interactionStatusUnavailable}, nil
		}
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
	if req.Expires != nil {
		now := time.Now
		if h.Now != nil {
			now = h.Now
		}
		currentTime := now().Unix()
		if currentTime >= 0 && *req.Expires <= uint64(currentTime) {
			return InteractionResult{Status: interactionStatusExpired}, nil
		}
	}
	saved, err := h.Store.Save(ctx, channel, snapshot.Revision, next)
	if errors.Is(err, persistence.ErrConflict) || errors.Is(err, music.ErrRevisionConflict) {
		return InteractionResult{Status: interactionStatusConflict}, nil
	}
	if err != nil {
		return InteractionResult{}, err
	}
	if h.OnPersistedSnapshot != nil {
		appliedRevision, handoffErr := h.OnPersistedSnapshot(ctx, h.InstallationID, h.CommunityID, channel, saved.State, saved.Revision, op == protocol.OpMusicResume)
		if handoffErr != nil {
			if op == protocol.OpMusicResume {
				appliedRevision = h.pauseUnappliedResume(ctx, channel, saved.Revision, appliedRevision)
			}
			if appliedRevision == 0 {
				appliedRevision = saved.Revision
			}
			return InteractionResult{Status: interactionStatusUnavailable, Revision: &appliedRevision}, nil
		}
	}
	revision := saved.Revision
	return InteractionResult{Status: 0, Revision: &revision, Data: []byte{0x80}}, nil
}

// isSpotifyCatalogInput keeps Spotify catalog links on their authenticated
// resolver path. The catalog itself performs strict URI and URL validation;
// this dispatch only prevents malformed Spotify links reaching YouTube.
func isSpotifyCatalogInput(input string) bool {
	if strings.HasPrefix(input, "spotify:") {
		return true
	}
	u, err := url.Parse(input)
	if err != nil {
		return strings.Contains(strings.ToLower(input), "spotify.com/")
	}
	host := strings.ToLower(u.Hostname())
	return host == "open.spotify.com" || host == "www.spotify.com"
}

func (h MusicInteractions) pauseUnappliedResume(ctx context.Context, channel id.ID, committedRevision, observedRevision uint64) uint64 {
	pausedCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
	defer cancel()
	current, err := h.Store.Load(pausedCtx, channel)
	if err != nil {
		return observedRevision
	}
	if current.Revision != committedRevision {
		return current.Revision
	}
	next, err := music.Apply(current.State, current.Revision, music.Operation{Kind: music.OpPause})
	if err != nil {
		return current.Revision
	}
	saved, err := h.Store.Save(pausedCtx, channel, current.Revision, next)
	if err != nil {
		latest, loadErr := h.Store.Load(pausedCtx, channel)
		if loadErr == nil {
			return latest.Revision
		}
		return current.Revision
	}
	return saved.Revision
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

func encodeMusicSnapshot(state music.State, canControl bool) ([]byte, error) {
	queue := make([]any, 0, len(state.Queue))
	for i := range state.Queue {
		t := state.Queue[i]
		queue = append(queue, encodeMusicTrack(&t))
	}
	current := encodeMusicTrack(state.Current)
	// The final slot is the current actor's DJ/call-membership affordance. Every
	// mutation still rechecks authority at its own write boundary.
	return cborx.Marshal([]any{uint64(1), state.Revision, current, queue, uint64(state.PositionMS), boolUint(state.Paused), uint64(state.Volume), boolUint(state.Shuffle), uint64(state.Repeat), boolUint(canControl)})
}

func encodeMusicTrack(t *music.Track) any {
	if t == nil {
		return nil
	}
	return []any{t.ID, string(t.Provider), t.CanonicalID, t.Title, t.Artist, t.Album, uint64(t.DurationMS), t.RequesterID}
}

func encodeMusicSearchResults(tracks []music.Track) ([]byte, error) {
	rows := make([]any, 0, len(tracks))
	for i := range tracks {
		track := tracks[i]
		if track.Provider != music.ProviderYouTube || track.ID == "" || track.ID != "yt:"+track.CanonicalID {
			return nil, errors.New("music search returned an unsupported provider")
		}
		// Run the queue's full descriptor validation on a disposable copy while
		// leaving search results free of a requester or queue-item identity.
		validated := track
		validated.RequesterID = "search"
		if _, err := music.Apply(music.InitialState(), 0, music.Operation{Kind: music.OpEnqueue, Tracks: []music.Track{validated}}); err != nil {
			return nil, err
		}
		rows = append(rows, encodeMusicTrack(&track))
	}
	for len(rows) > 0 {
		data, err := cborx.Marshal([]any{uint64(1), rows})
		if err != nil {
			return nil, err
		}
		if len(data) <= 2400 {
			return data, nil
		}
		rows = rows[:len(rows)-1]
	}
	data, err := cborx.Marshal([]any{uint64(1), []any{}})
	if err != nil {
		return nil, err
	}
	if len(tracks) > 0 {
		return nil, errors.New("music search result exceeds response limit")
	}
	return data, nil
}
