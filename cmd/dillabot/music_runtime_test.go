//go:build linux

package main

import (
	"context"
	"errors"
	"io"
	"os"
	"sync"
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
	mu      sync.Mutex
	binding native.Binding
	rows    map[string]native.StateValue
	closed  bool
}

func (n *runtimeStateNative) Binding() native.Binding { return n.binding }
func (n *runtimeStateNative) Close() error {
	n.mu.Lock()
	defer n.mu.Unlock()
	n.closed = true
	return nil
}
func (n *runtimeStateNative) StateGet(_ context.Context, _ uint64, key []byte) (native.StateValue, error) {
	n.mu.Lock()
	defer n.mu.Unlock()
	return n.rows[string(key)], nil
}
func (n *runtimeStateNative) StateTransaction(_ context.Context, _ id.ID, changes []native.StateChange) ([]uint64, error) {
	n.mu.Lock()
	defer n.mu.Unlock()
	c := changes[0]
	old := n.rows[string(c.Key)]
	if old.Revision != c.ExpectedRevision {
		return nil, persistence.ErrConflict
	}
	revision := old.Revision + 1
	n.rows[string(c.Key)] = native.StateValue{Revision: revision, Value: append([]byte(nil), c.Value...)}
	return []uint64{revision}, nil
}

func TestMusicSnapshotBridgeRejectsStaleAndMissingSessions(t *testing.T) {
	community, channel := id.New(), id.New()
	n := &runtimeStateNative{binding: native.Binding{Instance: id.New(), Community: community, Installation: id.New()}, rows: map[string]native.StateValue{}}
	store, err := persistence.New(n, community)
	if err != nil {
		t.Fatal(err)
	}
	starter := unavailableMusicQueueStarter()
	supervisor, err := newMusicSupervisor(context.Background(), channel, store, starter)
	if err != nil {
		t.Fatal(err)
	}
	runtime := &musicQueueRuntime{community: community, store: store, supervisors: map[id.ID]*music.Supervisor{channel: supervisor}}
	next, err := music.Apply(music.InitialState(), 0, music.Operation{Kind: music.OpEnqueue, Tracks: []music.Track{{ID: "one", Provider: music.ProviderYouTube, CanonicalID: "abcdefghijk", Title: "One", RequesterID: "member"}}})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.Save(context.Background(), channel, 0, next); err != nil {
		t.Fatal(err)
	}
	next, err = music.Apply(next, next.Revision, music.Operation{Kind: music.OpResume})
	if err != nil {
		t.Fatal(err)
	}
	saved, err := store.Save(context.Background(), channel, 1, next)
	if err != nil {
		t.Fatal(err)
	}
	if err := runtime.ApplyPersistedSnapshot(context.Background(), channel, saved.Revision-1, starter); !errors.Is(err, music.ErrRevisionConflict) {
		t.Fatalf("stale bridge error = %v, want revision conflict", err)
	}
	if err := runtime.ApplyPersistedSnapshot(context.Background(), id.New(), saved.Revision, starter); err == nil {
		t.Fatal("missing session was accepted")
	}
	if got := runtime.supervisors[channel]; got != supervisor {
		t.Fatal("failed refresh replaced the current supervisor")
	}
}

func TestMusicSnapshotBridgeRefreshesChannelsConcurrentlyAndClosesOnTeardown(t *testing.T) {
	community := id.New()
	n := &runtimeStateNative{binding: native.Binding{Instance: id.New(), Community: community, Installation: id.New()}, rows: map[string]native.StateValue{}}
	store, err := persistence.New(n, community)
	if err != nil {
		t.Fatal(err)
	}
	starter := unavailableMusicQueueStarter()
	channels := []id.ID{id.New(), id.New()}
	runtime := &musicQueueRuntime{community: community, store: store, supervisors: map[id.ID]*music.Supervisor{}}
	for _, channel := range channels {
		s, err := newMusicSupervisor(context.Background(), channel, store, starter)
		if err != nil {
			t.Fatal(err)
		}
		runtime.supervisors[channel] = s
		state, err := music.Apply(music.InitialState(), 0, music.Operation{Kind: music.OpEnqueue, Tracks: []music.Track{{ID: channel.String(), Provider: music.ProviderYouTube, CanonicalID: "abcdefghijk", Title: "One", RequesterID: "member"}}})
		if err != nil {
			t.Fatal(err)
		}
		if _, err := store.Save(context.Background(), channel, 0, state); err != nil {
			t.Fatal(err)
		}
		state, err = music.Apply(state, state.Revision, music.Operation{Kind: music.OpResume})
		if err != nil {
			t.Fatal(err)
		}
		if _, err := store.Save(context.Background(), channel, 1, state); err != nil {
			t.Fatal(err)
		}
	}
	installation := id.New()
	registry := &musicQueueRegistry{runtimes: map[id.ID]*retainedMusicRuntime{installation: {community: community, queues: runtime, native: n}}}
	var wg sync.WaitGroup
	errCh := make(chan error, len(channels))
	for _, channel := range channels {
		channel := channel
		wg.Add(1)
		go func() {
			defer wg.Done()
			errCh <- registry.ApplyPersistedSnapshot(context.Background(), installation, community, channel, 2, starter)
		}()
	}
	wg.Wait()
	close(errCh)
	for err := range errCh {
		if err != nil {
			t.Fatal(err)
		}
	}
	for _, channel := range channels {
		if state := runtime.supervisors[channel].State(); state.Revision != 2 || !state.Paused || state.Current == nil {
			t.Fatalf("channel %s refreshed to %#v; want active revision 2 restored paused", channel, state)
		}
	}
	if err := registry.Close(); err != nil {
		t.Fatal(err)
	}
	if err := registry.ApplyPersistedSnapshot(context.Background(), installation, community, channels[0], 2, starter); err == nil {
		t.Fatal("bridge after teardown was accepted")
	}
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
	starts := 0
	queues, err := restoreMusicQueuesIfEnabled(context.Background(), community, botMusicCapability, func(context.Context, id.ID) ([]client.Channel, error) {
		return []client.Channel{
			{ID: voice, CommunityID: community, Kind: 1},
			{ID: textChannel, CommunityID: community, Kind: 0},
		}, nil
	}, n, session.QueueStarter{OptionsFor: func(context.Context, music.Track) (session.Options, error) {
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

func TestMusicRuntimeWithoutApprovedCapabilityDoesNotLoadOrRestore(t *testing.T) {
	loads := 0
	runtime, err := restoreMusicQueuesIfEnabled(context.Background(), id.New(), 1<<1, func(context.Context, id.ID) ([]client.Channel, error) {
		loads++
		return nil, nil
	}, nil, unavailableMusicQueueStarter())
	if err != nil {
		t.Fatal(err)
	}
	if runtime != nil || loads != 0 {
		t.Fatalf("runtime=%v inventory loads=%d; disabled music capability must skip restoration", runtime, loads)
	}
}

func TestMusicQueueRegistryRetainsSupervisorsUntilCapabilityIsDisabled(t *testing.T) {
	community, installation, voice := id.New(), id.New(), id.New()
	nativeClient := &runtimeStateNative{binding: native.Binding{Instance: id.New(), Community: community, Installation: installation}, rows: map[string]native.StateValue{}}
	registry := newMusicQueueRegistry()
	channels := []client.Channel{{ID: voice, CommunityID: community, Kind: musicVoiceChannelKind}}
	owned, err := registry.Reconcile(context.Background(), installation, community, botMusicCapability, channels, nativeClient, unavailableMusicQueueStarter())
	if err != nil || !owned {
		t.Fatalf("first reconcile owned=%v err=%v, want ownership transfer", owned, err)
	}
	first := registry.runtimes[installation].queues.supervisors[voice]
	owned, err = registry.Reconcile(context.Background(), installation, community, botMusicCapability, channels, &runtimeStateNative{binding: nativeClient.binding, rows: map[string]native.StateValue{}}, unavailableMusicQueueStarter())
	if err != nil || owned {
		t.Fatalf("second reconcile owned=%v err=%v, want retained native client", owned, err)
	}
	if got := registry.runtimes[installation].queues.supervisors[voice]; got != first {
		t.Fatal("supervisor was reconstructed between polling iterations")
	}
	if got := registry.Native(installation, community); got != nativeClient {
		t.Fatal("reconcile did not expose the retained native client for reuse")
	}
	currentNative := &runtimeStateNative{binding: nativeClient.binding, rows: map[string]native.StateValue{}}
	owned, err = registry.Reconcile(context.Background(), installation, community, 0, channels, currentNative, unavailableMusicQueueStarter())
	if err != nil || owned {
		t.Fatalf("disabled reconcile owned=%v err=%v, want no ownership transfer", owned, err)
	}
	if !nativeClient.closed {
		t.Fatal("retained native client was not closed on capability loss")
	}
	if currentNative.closed {
		t.Fatal("caller-owned native client was closed by disabled reconcile")
	}
	if err := registry.ApplyPersistedSnapshot(context.Background(), installation, community, voice, 0, unavailableMusicQueueStarter()); err == nil {
		t.Fatal("snapshot bridge remained available after capability loss")
	}
	if _, err := first.Apply(context.Background(), first.State().Revision, music.Operation{Kind: music.OpPause}); !errors.Is(err, music.ErrSupervisorClosed) {
		t.Fatalf("supervisor after capability loss error=%v, want closed", err)
	}
}

func TestMusicQueueRegistryClosesRuntimesForRemovedInstallations(t *testing.T) {
	community, installation, voice := id.New(), id.New(), id.New()
	nativeClient := &runtimeStateNative{binding: native.Binding{Instance: id.New(), Community: community, Installation: installation}, rows: map[string]native.StateValue{}}
	registry := newMusicQueueRegistry()
	_, err := registry.Reconcile(context.Background(), installation, community, botMusicCapability, []client.Channel{{ID: voice, CommunityID: community, Kind: musicVoiceChannelKind}}, nativeClient, unavailableMusicQueueStarter())
	if err != nil {
		t.Fatal(err)
	}
	if err := registry.RetainOnly(nil); err != nil {
		t.Fatal(err)
	}
	if !nativeClient.closed || len(registry.runtimes) != 0 {
		t.Fatalf("removed installation cleanup closed=%v retained=%d", nativeClient.closed, len(registry.runtimes))
	}
}
