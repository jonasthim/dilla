package main

import (
	"context"
	"errors"
	"time"

	"github.com/jonasthim/dilla/internal/bot/client"
	"github.com/jonasthim/dilla/internal/bot/music"
	"github.com/jonasthim/dilla/internal/bot/music/livekit"
	"github.com/jonasthim/dilla/internal/bot/music/persistence"
	"github.com/jonasthim/dilla/internal/bot/music/session"
	"github.com/jonasthim/dilla/internal/bot/native"
	"github.com/jonasthim/dilla/internal/id"
)

type musicCallStarter interface {
	StartCall(context.Context, id.ID) (client.Call, error)
}

// musicRuntimeDeps contains the process-wide dependencies and the channel
// identity for one supervisor. Each supervisor gets its own queue/session
// state; SpotifyLease is shared by all supervisors in this service process.
type musicRuntimeDeps struct {
	Community, Channel id.ID
	Calls              musicCallStarter
	SpotifyPCM         session.PCMStarter
	YouTubePCM         session.PCMStarter
	LeaseManager       *music.SpotifyLeaseManager
	Encoder            session.EncoderStarter
	Publisher          session.PublisherStarter
	Epochs             livekit.EpochSource
	Lifetime           time.Duration
}

// newMusicQueueStarter resolves each queue item at playback time so the call
// credentials are fresh and bound to that item's voice channel. Provider PCM
// implementations are injected so this wiring cannot silently claim that a
// metadata-only YouTube resolver provides live audio.
func newMusicQueueStarter(deps musicRuntimeDeps) (session.QueueStarter, error) {
	if deps.Community.IsZero() || deps.Channel.IsZero() || deps.Calls == nil ||
		deps.SpotifyPCM == nil || deps.YouTubePCM == nil || deps.LeaseManager == nil ||
		deps.Encoder == nil || deps.Epochs == nil || deps.Lifetime <= 0 || deps.Lifetime > 30*time.Minute {
		return session.QueueStarter{}, errors.New("music runtime dependencies unavailable")
	}
	publisher := deps.Publisher
	if publisher == nil {
		publisher = session.LiveKitPublisher{Lifetime: deps.Lifetime}
	}
	options := func(ctx context.Context, track music.Track) (session.Options, error) {
		if ctx == nil || track.CanonicalID == "" {
			return session.Options{}, session.ErrInvalid
		}
		var pcm session.PCMStarter
		switch track.Provider {
		case music.ProviderSpotify:
			pcm = deps.SpotifyPCM
		case music.ProviderYouTube:
			pcm = deps.YouTubePCM
		default:
			return session.Options{}, session.ErrInvalid
		}
		call, err := deps.Calls.StartCall(ctx, deps.Channel)
		if err != nil {
			return session.Options{}, err
		}
		if call.CallID.IsZero() || call.GroupID.IsZero() || call.CallID != deps.Channel ||
			call.LiveKitURL == "" || call.Token == "" {
			return session.Options{}, session.ErrInvalid
		}
		var acquire session.LeaseAcquire
		if track.Provider == music.ProviderSpotify {
			acquire = session.AcquireSpotify(deps.LeaseManager)
		}
		return session.Options{
			Community: deps.Community, Channel: deps.Channel, Provider: track.Provider,
			Track: track.CanonicalID, Call: call, Group: call.GroupID,
			Acquire: acquire, PCM: pcm,
			Encoder: deps.Encoder, Publisher: publisher, Epochs: deps.Epochs,
		}, nil
	}
	return session.QueueStarter{OptionsFor: options}, nil
}

type persistedMusicQueue struct{ store *persistence.Store }

func (p persistedMusicQueue) Load(ctx context.Context, channel id.ID) (music.State, uint64, error) {
	snapshot, err := p.store.Load(ctx, channel)
	return snapshot.State, snapshot.Revision, err
}

func (p persistedMusicQueue) Save(ctx context.Context, channel id.ID, expected uint64, state music.State) (uint64, error) {
	snapshot, err := p.store.Save(ctx, channel, expected, state)
	return snapshot.Revision, err
}

// newMusicSupervisor is the per-channel persistence integration point.
func newMusicSupervisor(ctx context.Context, channel id.ID, store *persistence.Store, starter session.QueueStarter) (*music.Supervisor, error) {
	if store == nil || starter.OptionsFor == nil {
		return nil, errors.New("music runtime dependencies unavailable")
	}
	return music.NewSupervisor(ctx, channel, persistedMusicQueue{store: store}, starter)
}

var _ livekit.EpochSource = (*native.Client)(nil)
