//go:build linux

package main

import (
	"context"
	"errors"
	"io"
	"os"
	"testing"
	"time"

	"github.com/jonasthim/dilla/internal/bot/client"
	"github.com/jonasthim/dilla/internal/bot/music"
	"github.com/jonasthim/dilla/internal/bot/music/livekit"
	"github.com/jonasthim/dilla/internal/bot/music/persistence"
	"github.com/jonasthim/dilla/internal/bot/music/session"
	"github.com/jonasthim/dilla/internal/bot/native"
	"github.com/jonasthim/dilla/internal/id"
)

type runtimeCalls struct {
	call    client.Call
	err     error
	channel id.ID
}

func (c *runtimeCalls) StartCall(_ context.Context, channel id.ID) (client.Call, error) {
	c.channel = channel
	return c.call, c.err
}

type runtimeEpochs struct{}

func (runtimeEpochs) CallMediaEpoch(context.Context, id.ID) (native.CallMediaEpoch, error) {
	return native.CallMediaEpoch{}, nil
}

type runtimePCM struct{}

func (runtimePCM) Start(context.Context, string) (io.ReadCloser, error) {
	return nil, errors.New("unused")
}

type runtimeEncoder struct{}

func (runtimeEncoder) Start(context.Context, io.ReadCloser) (session.Encoder, error) {
	return nil, errors.New("unused")
}

type runtimePublisher struct{}

func (runtimePublisher) Start(context.Context, client.Call, id.ID, livekit.EpochSource, session.Encoder) (session.Publisher, error) {
	return nil, errors.New("unused")
}

type runtimeStateNative struct {
	binding native.Binding
	rows    map[string]native.StateValue
}

func (n *runtimeStateNative) Binding() native.Binding { return n.binding }
func (n *runtimeStateNative) StateGet(_ context.Context, _ uint64, key []byte) (native.StateValue, error) {
	return n.rows[string(key)], nil
}
func (n *runtimeStateNative) StateTransaction(_ context.Context, _ id.ID, changes []native.StateChange) ([]uint64, error) {
	c := changes[0]
	old := n.rows[string(c.Key)]
	if old.Revision != c.ExpectedRevision {
		return nil, persistence.ErrConflict
	}
	revision := old.Revision + 1
	n.rows[string(c.Key)] = native.StateValue{Revision: revision, Value: append([]byte(nil), c.Value...)}
	return []uint64{revision}, nil
}

func testLeaseManager(t *testing.T) *music.SpotifyLeaseManager {
	t.Helper()
	dir := t.TempDir()
	if err := os.Chmod(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	manager, err := music.NewSpotifyLeaseManager(dir)
	if err != nil {
		t.Fatal(err)
	}
	return manager
}

func TestNewMusicQueueStarterResolvesTrackToRoomCallAndProvider(t *testing.T) {
	channel, community, group := id.New(), id.New(), id.New()
	calls := &runtimeCalls{call: client.Call{CallID: channel, GroupID: group, LiveKitURL: "wss://relay.example", Token: "call-token"}}
	starter, err := newMusicQueueStarter(musicRuntimeDeps{
		Community: community, Calls: calls, SpotifyPCM: runtimePCM{}, YouTubePCM: runtimePCM{},
		Encoder: runtimeEncoder{}, Publisher: runtimePublisher{}, Epochs: runtimeEpochs{},
		Channel: channel, LeaseManager: testLeaseManager(t), Lifetime: time.Minute,
	})
	if err != nil {
		t.Fatal(err)
	}
	track := music.Track{Provider: music.ProviderYouTube, CanonicalID: "https://www.youtube.com/watch?v=abcdefghijk"}
	o, err := starter.OptionsFor(context.Background(), track)
	if err != nil {
		t.Fatal(err)
	}
	if calls.channel != channel {
		t.Fatalf("call channel = %s, want %s", calls.channel, channel)
	}
	if o.Community != community || o.Channel != channel || o.Provider != music.ProviderYouTube || o.Track != track.CanonicalID || o.Group != group || o.Call.CallID != calls.call.CallID || o.Epochs == nil || o.Encoder == nil || o.Publisher == nil {
		t.Fatalf("incomplete runtime options: %#v", o)
	}
}

func TestMusicQueueStarterAttachesGlobalLeaseOnlyToSpotifyUse(t *testing.T) {
	channel, community, group := id.New(), id.New(), id.New()
	calls := &runtimeCalls{call: client.Call{CallID: channel, GroupID: group, LiveKitURL: "wss://relay.example", Token: "call-token"}}
	starter, err := newMusicQueueStarter(musicRuntimeDeps{Community: community, Channel: channel, Calls: calls, SpotifyPCM: runtimePCM{}, YouTubePCM: runtimePCM{}, LeaseManager: testLeaseManager(t), Encoder: runtimeEncoder{}, Epochs: runtimeEpochs{}, Lifetime: time.Minute})
	if err != nil {
		t.Fatal(err)
	}
	spotifyOptions, err := starter.OptionsFor(context.Background(), music.Track{Provider: music.ProviderSpotify, CanonicalID: "spotify:track:1234567890123456789012"})
	if err != nil {
		t.Fatal(err)
	}
	if spotifyOptions.Acquire == nil {
		t.Fatal("Spotify options must use the installation-wide lease")
	}
	youtubeOptions, err := starter.OptionsFor(context.Background(), music.Track{Provider: music.ProviderYouTube, CanonicalID: "https://www.youtube.com/watch?v=abcdefghijk"})
	if err != nil {
		t.Fatal(err)
	}
	if youtubeOptions.Acquire != nil {
		t.Fatal("YouTube options must not acquire the Spotify lease")
	}
}

func TestNewMusicQueueStarterRejectsMissingProviderConfiguration(t *testing.T) {
	_, err := newMusicQueueStarter(musicRuntimeDeps{})
	if err == nil {
		t.Fatal("expected missing runtime configuration to be rejected")
	}
}

func TestMusicQueueStarterIsolatesUnavailableProvider(t *testing.T) {
	channel, community, group := id.New(), id.New(), id.New()
	calls := &runtimeCalls{call: client.Call{CallID: channel, GroupID: group, LiveKitURL: "wss://relay.example", Token: "call-token"}}
	starter, err := newMusicQueueStarter(musicRuntimeDeps{
		Community: community, Channel: channel, Calls: calls, YouTubePCM: runtimePCM{},
		Encoder: runtimeEncoder{}, Epochs: runtimeEpochs{}, Lifetime: time.Minute,
	})
	if err != nil {
		t.Fatalf("YouTube-only configuration rejected: %v", err)
	}
	_, err = starter.OptionsFor(context.Background(), music.Track{Provider: music.ProviderSpotify, CanonicalID: "spotify:track:1234567890123456789012"})
	if err == nil {
		t.Fatal("Spotify request succeeded without a Spotify PCM provider")
	}
	if calls.channel != (id.ID{}) {
		t.Fatal("unavailable provider triggered a call before failing closed")
	}
	if _, err := starter.OptionsFor(context.Background(), music.Track{Provider: music.ProviderYouTube, CanonicalID: "https://www.youtube.com/watch?v=abcdefghijk"}); err != nil {
		t.Fatalf("configured YouTube provider unavailable: %v", err)
	}
}

func TestMusicQueueStarterRejectsCallForDifferentChannel(t *testing.T) {
	calls := &runtimeCalls{call: client.Call{CallID: id.New(), GroupID: id.New(), LiveKitURL: "wss://relay.example", Token: "token"}}
	starter, err := newMusicQueueStarter(musicRuntimeDeps{Community: id.New(), Channel: id.New(), Calls: calls, SpotifyPCM: runtimePCM{}, YouTubePCM: runtimePCM{}, LeaseManager: testLeaseManager(t), Encoder: runtimeEncoder{}, Publisher: runtimePublisher{}, Epochs: runtimeEpochs{}, Lifetime: time.Minute})
	if err != nil {
		t.Fatal(err)
	}
	_, err = starter.OptionsFor(context.Background(), music.Track{Provider: music.ProviderYouTube, CanonicalID: "https://www.youtube.com/watch?v=abcdefghijk"})
	if err == nil {
		t.Fatal("expected mismatched call group to be rejected")
	}
}

func TestNewMusicSupervisorRestoresPersistedStateWithoutStartingAudio(t *testing.T) {
	channel, community := id.New(), id.New()
	n := &runtimeStateNative{binding: native.Binding{Instance: id.New(), Community: community, Installation: id.New()}, rows: map[string]native.StateValue{}}
	store, err := persistence.New(n, community)
	if err != nil {
		t.Fatal(err)
	}
	initial, err := store.Load(context.Background(), channel)
	if err != nil {
		t.Fatal(err)
	}
	queued, err := music.Apply(initial.State, initial.Revision, music.Operation{Kind: music.OpEnqueue, Tracks: []music.Track{{ID: "track-1", Provider: music.ProviderYouTube, CanonicalID: "abcdefghijk", Title: "Track", RequesterID: "member"}}})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.Save(context.Background(), channel, initial.Revision, queued); err != nil {
		t.Fatal(err)
	}
	playing, err := music.Apply(queued, queued.Revision, music.Operation{Kind: music.OpResume})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.Save(context.Background(), channel, queued.Revision, playing); err != nil {
		t.Fatal(err)
	}

	starts := 0
	starter := session.QueueStarter{OptionsFor: func(context.Context, music.Track) (session.Options, error) {
		starts++
		return session.Options{}, errors.New("must not resolve track during restore")
	}}
	supervisor, err := newMusicSupervisor(context.Background(), channel, store, starter)
	if err != nil {
		t.Fatal(err)
	}
	defer supervisor.Close()
	if starts != 0 {
		t.Fatalf("restore resolved/started %d tracks, want none", starts)
	}
	state := supervisor.State()
	if !state.Paused || state.Current == nil || state.Current.ID != "track-1" {
		t.Fatalf("restored state=%+v, want current track retained but paused", state)
	}
}

func TestRestoreMusicSupervisorsCreatesPausedVoiceQueuesOnly(t *testing.T) {
	community := id.New()
	voice, textChannel := id.New(), id.New()
	n := &runtimeStateNative{binding: native.Binding{Instance: id.New(), Community: community, Installation: id.New()}, rows: map[string]native.StateValue{}}
	store, err := persistence.New(n, community)
	if err != nil {
		t.Fatal(err)
	}
	starts := 0
	queues, err := restoreMusicSupervisors(context.Background(), community, []client.Channel{
		{ID: voice, CommunityID: community, Kind: 1},
		{ID: textChannel, CommunityID: community, Kind: 0},
	}, store, session.QueueStarter{OptionsFor: func(context.Context, music.Track) (session.Options, error) {
		starts++
		return session.Options{}, errors.New("provider must stay unavailable during restore")
	}})
	if err != nil {
		t.Fatal(err)
	}
	defer queues.Close()
	if queues.Len() != 1 || queues.supervisors[voice] == nil {
		t.Fatalf("restored supervisors = %d, want only voice channel %s", queues.Len(), voice)
	}
	if !queues.supervisors[voice].State().Paused || starts != 0 {
		t.Fatalf("restored queue paused=%v provider starts=%d, want paused and zero starts", queues.supervisors[voice].State().Paused, starts)
	}
}

func TestUnavailableMusicQueueStarterFailsClosed(t *testing.T) {
	_, err := unavailableMusicQueueStarter().OptionsFor(context.Background(), music.Track{
		Provider: music.ProviderYouTube, CanonicalID: "https://www.youtube.com/watch?v=abcdefghijk",
	})
	if !errors.Is(err, errMusicPCMUnavailable) {
		t.Fatalf("unavailable provider error = %v, want %v", err, errMusicPCMUnavailable)
	}
}
