package youtube

import (
	"context"
	"errors"
	"os"
	"strings"
	"testing"
	"time"
)

func TestNormalizeInputAcceptsSearchVideoAndPlaylist(t *testing.T) {
	cases := []struct{ input, kind, canonical string }{
		{"instrumental study music", "search", "ytsearch5:instrumental study music"},
		{"https://www.youtube.com/watch?v=aqz-KE-bpKQ", "video", "https://www.youtube.com/watch?v=aqz-KE-bpKQ"},
		{"https://youtu.be/aqz-KE-bpKQ", "video", "https://www.youtube.com/watch?v=aqz-KE-bpKQ"},
		{"https://youtube.com/playlist?list=PLabc_123", "playlist", "https://www.youtube.com/playlist?list=PLabc_123"},
	}
	for _, tc := range cases {
		t.Run(tc.input, func(t *testing.T) {
			kind, canonical, err := NormalizeInput(tc.input)
			if err != nil || kind != tc.kind || canonical != tc.canonical {
				t.Fatalf("NormalizeInput() = %q, %q, %v", kind, canonical, err)
			}
		})
	}
}

func TestNormalizeInputRejectsUnsafeURLsAndExtractorSyntax(t *testing.T) {
	inputs := []string{
		"file:///etc/passwd", "ftp://youtube.com/a", "http://youtube.com/watch?v=aqz-KE-bpKQ",
		"https://youtube.com.evil.test/watch?v=aqz-KE-bpKQ", "https://user:pass@youtube.com/watch?v=aqz-KE-bpKQ",
		"https://127.0.0.1/watch?v=aqz-KE-bpKQ", "https://youtube.com:443/watch?v=aqz-KE-bpKQ",
		"https://youtube.com/watch?v=aqz-KE-bpKQ&v=aqz-KE-bpKQ", "ytsearchall:cat", "youtube:aqz-KE-bpKQ",
		"https://youtube.com/shorts/aqz-KE-bpKQ?list=PLabc_123", "https://youtube.com/watch?v=aqz-KE-bpKQ#",
		"https://youtube.com/watch?v=aqz-KE-bpKQ&", "example.org song", "javascript:alert(1)",
	}
	for _, input := range inputs {
		if _, _, err := NormalizeInput(input); err == nil {
			t.Errorf("NormalizeInput(%q) accepted unsafe input", input)
		}
	}
}

func TestResolveBuildsBoundedQueueDescriptors(t *testing.T) {
	body := `{"_type":"playlist","extractor_key":"Youtube","playlist_count":2,"entries":[{"_type":"url","ie_key":"Youtube","id":"aqz-KE-bpKQ","title":"one","duration":12.345,"availability":"public"},{"_type":"url","ie_key":"Youtube","id":"BaW_jenozKc","title":"two"}]}`
	runner := runnerFunc(func(_ context.Context, executable string, args []string, limit int) ([]byte, error) {
		if executable != "/qualified/yt-dlp" || limit != MaxMetadataBytes {
			t.Fatalf("runner executable/limit = %q/%d", executable, limit)
		}
		if len(args) == 0 || args[len(args)-1] != "ytsearch5:study music" {
			t.Fatalf("yt-dlp final argument = %q", args[len(args)-1])
		}
		return []byte(body), nil
	})
	resolver := NonProductionMetadataResolver{YTDLP: "/qualified/yt-dlp", Node: "/qualified/node", runner: runner}
	tracks, err := resolver.Resolve(context.Background(), "study music")
	if err != nil {
		t.Fatal(err)
	}
	if len(tracks) != 2 || tracks[0].ID != "yt:aqz-KE-bpKQ" || tracks[0].Provider != "youtube" || tracks[0].DurationMS != 12345 || tracks[1].DurationMS != 0 {
		t.Fatalf("resolved descriptors = %#v", tracks)
	}
}

func TestResolveRequiresSandboxedRunner(t *testing.T) {
	resolver := NonProductionMetadataResolver{YTDLP: "/yt-dlp", Node: "/node"}
	if _, err := resolver.Resolve(context.Background(), "study music"); !errors.Is(err, ErrRunnerRequired) {
		t.Fatalf("Resolve without runner error = %v", err)
	}
	if _, err := resolver.Resolve(nil, "study music"); !errors.Is(err, ErrExtractFailed) {
		t.Fatalf("Resolve with nil context error = %v", err)
	}
}

func TestResolveRejectsOversizedMetadataBeforeParsing(t *testing.T) {
	runner := runnerFunc(func(context.Context, string, []string, int) ([]byte, error) {
		return []byte(strings.Repeat("x", MaxMetadataBytes+1)), nil
	})
	resolver := NonProductionMetadataResolver{YTDLP: "/qualified/yt-dlp", Node: "/usr/bin/node", runner: runner}
	if _, err := resolver.Resolve(context.Background(), "study music"); !errors.Is(err, ErrMetadataTooLarge) {
		t.Fatalf("Resolve oversized metadata error = %v, want ErrMetadataTooLarge", err)
	}
}

func TestResolveRejectsIncompleteOrNonYouTubeMetadata(t *testing.T) {
	cases := []string{
		`{"_type":"playlist","playlist_count":2,"entries":[{"_type":"url","ie_key":"Youtube","id":"aqz-KE-bpKQ","title":"one"}]}`,
		`{"_type":"playlist","playlist_count":1,"entries":[{"_type":"url","ie_key":"Generic","id":"aqz-KE-bpKQ","title":"bad"}]}`,
		`{"_type":"playlist","extractor_key":"Generic","playlist_count":1,"entries":[{"_type":"url","ie_key":"Youtube","id":"aqz-KE-bpKQ","title":"one"}]}`,
		`{"_type":"playlist","playlist_count":1,"entries":[{"_type":"url","ie_key":"Youtube","id":"aqz-KE-bpKQ","title":"one"}]}`,
		`{"_type":"playlist","extractor_key":"Youtube","playlist_count":1,"entries":[{"_type":"","ie_key":"Youtube","id":"aqz-KE-bpKQ","title":"one"}]}`,
	}
	for _, body := range cases {
		r := NonProductionMetadataResolver{YTDLP: "/yt-dlp", Node: "/node", runner: runnerFunc(func(context.Context, string, []string, int) ([]byte, error) { return []byte(body), nil })}
		if _, err := r.Resolve(context.Background(), "study music"); err == nil {
			t.Errorf("Resolve accepted invalid metadata %s", body)
		}
	}
}

func TestResolveRejectsBlankRootType(t *testing.T) {
	body := `{"_type":"","extractor_key":"Youtube","id":"aqz-KE-bpKQ","title":"one"}`
	r := NonProductionMetadataResolver{YTDLP: "/yt-dlp", Node: "/node", runner: runnerFunc(func(context.Context, string, []string, int) ([]byte, error) { return []byte(body), nil })}
	if _, err := r.Resolve(context.Background(), "https://youtube.com/watch?v=aqz-KE-bpKQ"); !errors.Is(err, ErrMetadataInvalid) {
		t.Fatalf("Resolve blank root _type error = %v, want ErrMetadataInvalid", err)
	}
}

func TestExecRunnerHonorsContextCancellation(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 40*time.Millisecond)
	defer cancel()
	runner := ExecRunner{MaxStderr: 1024}
	_, err := runner.Run(ctx, "/bin/sh", []string{"-c", "sleep 5"}, 1024)
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("Run cancellation error = %v, want context deadline", err)
	}
}

func TestExecRunnerAppliesItsOwnDeadlineAndKillsProcessGroup(t *testing.T) {
	marker := t.TempDir() + "/late-child-write"
	runner := ExecRunner{Timeout: 80 * time.Millisecond}
	_, err := runner.Run(context.Background(), "/bin/sh", []string{"-c", "sleep 0.2; touch \"$1\"", "sh", marker}, 1024)
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("Run timeout error = %v, want context deadline", err)
	}
	time.Sleep(250 * time.Millisecond)
	if _, statErr := os.Stat(marker); !errors.Is(statErr, os.ErrNotExist) {
		t.Fatalf("child process survived cancellation; marker stat error = %v", statErr)
	}
}

func TestExecRunnerStopsAtOutputLimit(t *testing.T) {
	runner := ExecRunner{}
	output, err := runner.Run(context.Background(), "/bin/sh", []string{"-c", "printf 123456"}, 3)
	if !errors.Is(err, ErrMetadataTooLarge) {
		t.Fatalf("Run output limit error = %v, want ErrMetadataTooLarge; output %q", err, output)
	}
}

type runnerFunc func(context.Context, string, []string, int) ([]byte, error)

func (f runnerFunc) Run(ctx context.Context, executable string, args []string, limit int) ([]byte, error) {
	return f(ctx, executable, args, limit)
}

func (runnerFunc) youtubeSandboxedRunner() {}
