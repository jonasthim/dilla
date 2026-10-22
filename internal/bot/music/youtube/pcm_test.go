package youtube

import (
	"context"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestPCMStarterFailsClosedWithoutProductionNetworkSandbox(t *testing.T) {
	dir := t.TempDir()
	marker := filepath.Join(dir, "invoked")
	ytdlp := writeScript(t, dir, "yt-dlp", `touch "$MARKER"; printf encoded`)
	ffmpeg := writeScript(t, dir, "ffmpeg", `touch "$MARKER"; cat`)
	t.Setenv("MARKER", marker)

	pcm, err := (PCMStarter{YTDLP: ytdlp, FFmpeg: ffmpeg}).Start(context.Background(), "https://www.youtube.com/watch?v=aqz-KE-bpKQ")
	if pcm != nil || !errors.Is(err, ErrSandboxUnavailable) {
		t.Fatalf("Start = (%v, %v), want nil and ErrSandboxUnavailable", pcm, err)
	}
	if _, statErr := os.Stat(marker); !errors.Is(statErr, os.ErrNotExist) {
		t.Fatalf("unsandboxed subprocess started: stat error = %v", statErr)
	}
}

func TestPCMStarterRejectsAnythingButCanonicalVideoBeforeStartingProcesses(t *testing.T) {
	marker := filepath.Join(t.TempDir(), "invoked")
	ytdlp := writeScript(t, t.TempDir(), "yt-dlp", `touch "$MARKER"`)
	_ = os.Setenv("MARKER", marker)
	t.Cleanup(func() { _ = os.Unsetenv("MARKER") })
	for _, input := range []string{"ytsearch5:hello", "https://example.org/video", "file:///tmp/audio", "https://youtube.com/playlist?list=PLabc_123"} {
		if _, err := (PCMStarter{YTDLP: ytdlp, FFmpeg: ytdlp}).Start(context.Background(), input); err == nil {
			t.Errorf("Start(%q) succeeded", input)
		}
	}
	if _, err := os.Stat(marker); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("yt-dlp invoked for invalid input, stat error = %v", err)
	}
}

func writeScript(t *testing.T, dir, name, body string) string {
	t.Helper()
	path := filepath.Join(dir, name)
	if err := os.WriteFile(path, []byte("#!/bin/sh\n"+body+"\n"), 0700); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestBoundedPCMReaderStopsAtByteLimit(t *testing.T) {
	r, err := NewBoundedPCMReader(context.Background(), io.NopCloser(strings.NewReader("abcdef")), 4)
	if err != nil {
		t.Fatal(err)
	}
	defer r.Close()
	got, err := io.ReadAll(r)
	if !errors.Is(err, ErrPCMTooLarge) || string(got) != "abcd" {
		t.Fatalf("ReadAll = %q, %v", got, err)
	}
}

func TestBoundedPCMReaderAllowsEOFAtLimit(t *testing.T) {
	r, err := NewBoundedPCMReader(context.Background(), io.NopCloser(strings.NewReader("abcd")), 4)
	if err != nil {
		t.Fatal(err)
	}
	defer r.Close()
	got, err := io.ReadAll(r)
	if err != nil || string(got) != "abcd" {
		t.Fatalf("ReadAll = %q, %v", got, err)
	}
}

func TestBoundedPCMReaderCancellationClosesBlockedSource(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	source := &blockingPCMSource{closed: make(chan struct{})}
	r, err := NewBoundedPCMReader(ctx, source, 1024)
	if err != nil {
		t.Fatal(err)
	}
	readDone := make(chan error, 1)
	go func() { _, readErr := r.Read(make([]byte, 8)); readDone <- readErr }()
	cancel()
	select {
	case err := <-readDone:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("Read error = %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("Read remained blocked after cancellation")
	}
	select {
	case <-source.closed:
	case <-time.After(time.Second):
		t.Fatal("source was not closed after cancellation")
	}
	_ = r.Close()
}

type blockingPCMSource struct{ closed chan struct{} }

func (s *blockingPCMSource) Read([]byte) (int, error) {
	<-s.closed
	return 0, errors.New("source closed")
}
func (s *blockingPCMSource) Close() error {
	select {
	case <-s.closed:
	default:
		close(s.closed)
	}
	return nil
}
