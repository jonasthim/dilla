package session

import (
	"context"
	"io"
	"testing"

	"github.com/jonasthim/dilla/internal/bot/music/encode"
	musicruntime "github.com/jonasthim/dilla/internal/bot/music/runtime"
)

func TestRuntimeEncoderUsesSpotifyPCMFormat(t *testing.T) {
	var got musicruntime.PCMFormat
	wantEncoder := &encoderStub{done: make(chan struct{})}
	e := RuntimeEncoder{Config: EncoderConfig{Capacity: 7, Options: encode.Options{FFmpegPath: "ffmpeg-test"}, start: func(_ context.Context, _ io.ReadCloser, format musicruntime.PCMFormat, capacity int, options encode.Options) (Encoder, error) {
		got = format
		if capacity != 7 || options.FFmpegPath != "ffmpeg-test" {
			t.Fatalf("config not forwarded: capacity=%d options=%+v", capacity, options)
		}
		return wantEncoder, nil
	}}}
	if _, err := e.Start(context.Background(), io.NopCloser(nilReader{})); err != nil {
		t.Fatal(err)
	}
	if got != (musicruntime.PCMFormat{SampleRate: 44100, Channels: 2}) {
		t.Fatalf("PCM format=%+v", got)
	}
}

type nilReader struct{}

func (nilReader) Read([]byte) (int, error) { return 0, io.EOF }
