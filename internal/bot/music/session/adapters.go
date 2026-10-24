package session

import (
	"context"
	"io"
	"time"

	"github.com/jonasthim/dilla/internal/bot/client"
	"github.com/jonasthim/dilla/internal/bot/music/encode"
	"github.com/jonasthim/dilla/internal/bot/music/livekit"
	musicruntime "github.com/jonasthim/dilla/internal/bot/music/runtime"
	"github.com/jonasthim/dilla/internal/bot/music/spotify"
	"github.com/jonasthim/dilla/internal/bot/music/youtube"
	"github.com/jonasthim/dilla/internal/bot/native"
	"github.com/jonasthim/dilla/internal/id"
)

type Spotify struct{ Adapter *spotify.Adapter }

// YouTubePCM maps the provider-native video ID stored in a queue entry to the
// canonical URL accepted by the sandboxed YouTube PCM source.
type YouTubePCM struct{ Source youtube.PCMSourceStarter }

func (s YouTubePCM) Start(ctx context.Context, track string) (io.ReadCloser, error) {
	if ctx == nil || s.Source == nil || len(track) != 11 {
		return nil, ErrInvalid
	}
	for i := 0; i < len(track); i++ {
		c := track[i]
		if (c < 'a' || c > 'z') && (c < 'A' || c > 'Z') && (c < '0' || c > '9') && c != '_' && c != '-' {
			return nil, ErrInvalid
		}
	}
	canonical := "https://www.youtube.com/watch?v=" + track
	kind, normalized, err := youtube.NormalizeInput(canonical)
	if err != nil || kind != "video" || normalized != canonical {
		return nil, ErrInvalid
	}
	return s.Source.Start(ctx, canonical)
}

func (s Spotify) Start(ctx context.Context, track string) (io.ReadCloser, error) {
	return s.Adapter.Start(ctx, track)
}

type EncoderConfig struct {
	Capacity int
	Options  encode.Options
	start    func(context.Context, io.ReadCloser, musicruntime.PCMFormat, int, encode.Options) (Encoder, error)
}
type RuntimeEncoder struct{ Config EncoderConfig }

const spotifyPCMRate = 44100

func (e RuntimeEncoder) Start(ctx context.Context, pcm io.ReadCloser) (Encoder, error) {
	format := musicruntime.PCMFormat{SampleRate: spotifyPCMRate, Channels: 2}
	if e.Config.start != nil {
		return e.Config.start(ctx, pcm, format, e.Config.Capacity, e.Config.Options)
	}
	return musicruntime.Start(ctx, pcm, format, e.Config.Capacity, e.Config.Options)
}

type LiveKitPublisher struct{ Lifetime time.Duration }

func (p LiveKitPublisher) Start(ctx context.Context, call client.Call, group id.ID, epochs livekit.EpochSource, enc Encoder) (Publisher, error) {
	concrete, ok := enc.(*musicruntime.Session)
	if !ok {
		_ = enc.Close()
		return nil, ErrInvalid
	}
	return livekit.Start(ctx, call, group, epochs, concrete, p.Lifetime)
}

var _ livekit.EpochSource = (*native.Client)(nil)
