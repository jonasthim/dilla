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
