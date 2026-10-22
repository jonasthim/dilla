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

func TestPCMStarterStreamsDecodedPCMFromCanonicalVideo(t *testing.T) {
	dir := t.TempDir()
	argsFile := filepath.Join(dir, "yt-args")
	ytdlp := writeScript(t, dir, "yt-dlp", `printf '%s\n' "$@" > "$ARGS_FILE"
printf 'encoded audio'`)
	ffmpeg := writeScript(t, dir, "ffmpeg", `cat`)
	_ = os.Setenv("ARGS_FILE", argsFile)
	t.Cleanup(func() { _ = os.Unsetenv("ARGS_FILE") })

	pcm, err := (PCMStarter{YTDLP: ytdlp, FFmpeg: ffmpeg}).Start(context.Background(), "https://www.youtube.com/watch?v=aqz-KE-bpKQ")
	if err != nil {
		t.Fatal(err)
	}
	got, err := io.ReadAll(pcm)
	closeErr := pcm.Close()
	if err != nil || closeErr != nil {
		t.Fatalf("read/close = %v/%v", err, closeErr)
	}
	if string(got) != "encoded audio" {
		t.Fatalf("PCM = %q", got)
	}
	args, err := os.ReadFile(argsFile)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(args), "--ignore-config") || !strings.Contains(string(args), "--no-playlist") || !strings.Contains(string(args), "https://www.youtube.com/watch?v=aqz-KE-bpKQ") {
		t.Fatalf("yt-dlp args = %q", args)
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

func TestPCMStarterBoundsDecodedOutput(t *testing.T) {
	dir := t.TempDir()
	pcm, err := (PCMStarter{YTDLP: writeScript(t, dir, "yt-dlp", `printf encoded`), FFmpeg: writeScript(t, dir, "ffmpeg", `printf 123456`), MaxPCMBytes: 5}).Start(context.Background(), "https://www.youtube.com/watch?v=aqz-KE-bpKQ")
	if err != nil {
		t.Fatal(err)
	}
	got, err := io.ReadAll(pcm)
	if !errors.Is(err, ErrPCMLimit) || string(got) != "12345" {
		t.Fatalf("ReadAll = %q, %v; want 12345 and ErrPCMLimit", got, err)
	}
	_ = pcm.Close()
}

func TestPCMStarterCancellationKillsBothProcesses(t *testing.T) {
	dir := t.TempDir()
	ytdlp := writeScript(t, dir, "yt-dlp", `sleep 30`)
	ffmpeg := writeScript(t, dir, "ffmpeg", `cat >/dev/null; sleep 30`)
	ctx, cancel := context.WithCancel(context.Background())
	pcm, err := (PCMStarter{YTDLP: ytdlp, FFmpeg: ffmpeg}).Start(ctx, "https://www.youtube.com/watch?v=aqz-KE-bpKQ")
	if err != nil {
		t.Fatal(err)
	}
	cancel()
	_ = pcm.Close()
	select {
	case <-pcm.(*boundedPCM).done:
	case <-time.After(2 * time.Second):
		t.Fatal("child process group did not stop after cancellation")
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
