// Package youtube contains bounded metadata and PCM adapters. Network-capable
// subprocesses run only inside bubblewrap and use a host CONNECT broker that
// permits public HTTPS destinations on the YouTube host allowlist.
package youtube

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"net/url"
	"os/exec"
	"regexp"
	"strings"
	"syscall"
	"time"
	"unicode"

	"github.com/jonasthim/dilla/internal/bot/music"
)

const (
	MaxInputBytes    = 200
	MaxSearchResults = 5
	MaxPlaylistItems = 500
	MaxTitleBytes    = music.MaxMetadataBytes
	MaxMetadataBytes = 2 << 20
	MaxDuration      = 24 * time.Hour
)

var (
	ErrInvalidInput       = errors.New("youtube: invalid or unsupported input")
	ErrMetadataTooLarge   = errors.New("youtube: metadata output exceeds limit")
	ErrMetadataInvalid    = errors.New("youtube: invalid or incomplete metadata")
	ErrRunnerRequired     = errors.New("youtube: package-approved sandbox runner required")
	ErrExtractFailed      = errors.New("youtube: metadata extraction failed")
	DefaultProcessTimeout = 2 * time.Minute
	idPattern             = regexp.MustCompile(`^[A-Za-z0-9_-]{11}$`)
	playlistPattern       = regexp.MustCompile(`^[A-Za-z0-9_-]{1,128}$`)
	schemePattern         = regexp.MustCompile(`^[A-Za-z][A-Za-z0-9+.-]*:`)
)

type inputKind uint8

const (
	kindSearch inputKind = iota + 1
	kindVideo
	kindPlaylist
)

// NormalizeInput validates the intentionally small input grammar and returns
// a canonical URL or yt-dlp search expression. All other extractor syntax is
// rejected before it can reach yt-dlp.
func NormalizeInput(value string) (kind string, canonical string, err error) {
	if value == "" || len(value) > MaxInputBytes || strings.TrimSpace(value) != value {
		return "", "", ErrInvalidInput
	}
	for _, r := range value {
		if unicode.IsControl(r) {
			return "", "", ErrInvalidInput
		}
	}

	if strings.Contains(value, "://") || strings.HasPrefix(value, "//") {
		k, normalized, parseErr := normalizeURL(value)
		if parseErr != nil {
			return "", "", ErrInvalidInput
		}
		return k, normalized, nil
	}
	lower := strings.ToLower(value)
	if strings.HasPrefix(lower, "ytsearch") || strings.HasPrefix(lower, "youtube:") ||
		strings.HasPrefix(lower, "file:") || strings.HasPrefix(lower, "ftp:") ||
		schemePattern.MatchString(value) ||
		strings.Contains(lower, "youtube.com/") || strings.Contains(lower, "youtu.be/") ||
		looksLikeHost(value) {
		return "", "", ErrInvalidInput
	}
	return "search", "ytsearch5:" + value, nil
}

func normalizeURL(raw string) (string, string, error) {
	if strings.Contains(raw, "#") {
		return "", "", ErrInvalidInput
	}
	u, err := url.Parse(raw)
	if err != nil || u.Scheme != "https" || u.Opaque != "" || u.User != nil || u.Fragment != "" || u.RawFragment != "" {
		return "", "", ErrInvalidInput
	}
	host := strings.ToLower(u.Hostname())
	if host == "" || u.Port() != "" || u.Host != host {
		return "", "", ErrInvalidInput
	}
	if host != "youtube.com" && host != "www.youtube.com" && host != "m.youtube.com" && host != "youtu.be" {
		return "", "", ErrInvalidInput
	}
	values, err := url.ParseQuery(u.RawQuery)
	if err != nil {
		return "", "", ErrInvalidInput
	}
	for key, all := range values {
		if len(all) != 1 || all[0] == "" {
			return "", "", ErrInvalidInput
		}
		_ = key
	}
	if host == "youtu.be" {
		videoID := strings.TrimPrefix(u.EscapedPath(), "/")
		if strings.Count(u.EscapedPath(), "/") != 1 || !idPattern.MatchString(videoID) || len(values) != 0 {
			return "", "", ErrInvalidInput
		}
		return "video", videoURL(videoID), nil
	}
	if u.Path == "/watch" && len(values) == 1 && values.Has("v") && idPattern.MatchString(values.Get("v")) && u.RawQuery == "v="+values.Get("v") {
		return "video", videoURL(values.Get("v")), nil
	}
	if match := strings.TrimPrefix(u.Path, "/shorts/"); match != u.Path && idPattern.MatchString(match) && len(values) == 0 {
		return "video", videoURL(match), nil
	}
	if u.Path == "/playlist" && len(values) == 1 && values.Has("list") && playlistPattern.MatchString(values.Get("list")) && u.RawQuery == "list="+values.Get("list") {
		return "playlist", "https://www.youtube.com/playlist?list=" + values.Get("list"), nil
	}
	return "", "", ErrInvalidInput
}

func videoURL(id string) string { return "https://www.youtube.com/watch?v=" + id }

func looksLikeHost(value string) bool {
	if strings.ContainsAny(value, "/?#@") {
		return false
	}
	if strings.Contains(value, ".") {
		return true
	}
	return false
}

// sandboxedRunner can only be implemented by this package. A future concrete
// runner must connect to the qualification harness's verified network sandbox.
type sandboxedRunner interface {
	Run(ctx context.Context, executable string, args []string, outputLimit int) ([]byte, error)
	youtubeSandboxedRunner()
}

// ExecRunner bounds process time, output, and child cleanup, but provides no
// network or memory isolation. It deliberately does not satisfy sandboxedRunner.
type ExecRunner struct {
	MaxStderr int
	Timeout   time.Duration
}

func (r ExecRunner) Run(ctx context.Context, executable string, args []string, outputLimit int) ([]byte, error) {
	if ctx == nil || executable == "" || outputLimit < 1 {
		return nil, ErrExtractFailed
	}
	timeout := r.Timeout
	if timeout <= 0 || timeout > DefaultProcessTimeout {
		timeout = DefaultProcessTimeout
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	if r.MaxStderr <= 0 {
		r.MaxStderr = 64 << 10
	}
	cmd := exec.CommandContext(ctx, executable, args...) // #nosec G204 -- executable is resolved from configured dependencies; args use validated URLs.
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.Cancel = func() error {
		if cmd.Process == nil {
			return nil
		}
		return syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
	}
	cmd.WaitDelay = 2 * time.Second
	stdout := &limitedBuffer{limit: outputLimit}
	stderr := &limitedBuffer{limit: r.MaxStderr}
	cmd.Stdout, cmd.Stderr = stdout, stderr
	err := cmd.Run()
	if stdout.exceeded || stderr.exceeded {
		return nil, ErrMetadataTooLarge
	}
	if err != nil {
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		return nil, ErrExtractFailed
	}
	return bytes.Clone(stdout.Bytes()), nil
}

type limitedBuffer struct {
	buf      bytes.Buffer
	limit    int
	exceeded bool
}

func (b *limitedBuffer) Write(p []byte) (int, error) {
	remaining := b.limit - b.buf.Len()
	if len(p) > remaining {
		if remaining > 0 {
			_, _ = b.buf.Write(p[:remaining])
		}
		b.exceeded = true
		return remaining, errors.New("output limit exceeded")
	}
	return b.buf.Write(p)
}

func (b *limitedBuffer) Bytes() []byte { return b.buf.Bytes() }

// MetadataResolver uses configured yt-dlp and JavaScript runtime paths and
// validates metadata before returning queue descriptors.
type MetadataResolver struct {
	YTDLP   string
	Node    string
	runner  sandboxedRunner
	Timeout time.Duration
}

// NonProductionMetadataResolver remains an alias for callers of the original
// qualification-only adapter name.
type NonProductionMetadataResolver = MetadataResolver

func (r MetadataResolver) Resolve(ctx context.Context, input string) ([]music.Track, error) {
	if ctx == nil {
		return nil, ErrExtractFailed
	}
	if r.runner == nil {
		return nil, ErrRunnerRequired
	}
	if r.YTDLP == "" || r.Node == "" {
		return nil, ErrExtractFailed
	}
	kindName, canonical, err := NormalizeInput(input)
	if err != nil {
		return nil, err
	}
	kind := kindSearch
	switch kindName {
	case "video":
		kind = kindVideo
	case "playlist":
		kind = kindPlaylist
	}
	args := []string{
		"--ignore-config", "--no-plugin-dirs", "--no-remote-components", "--flat-playlist",
		"--js-runtimes", "node:" + r.Node, "--no-warnings", "--no-progress", "--color", "never",
		"--socket-timeout", "10", "--extractor-retries", "1", "--playlist-end", "501",
		"--dump-single-json", canonical,
	}
	deadline := r.Timeout
	if deadline <= 0 || deadline > 2*time.Minute {
		deadline = 2 * time.Minute
	}
	ctx, cancel := context.WithTimeout(ctx, deadline)
	defer cancel()
	output, err := r.runner.Run(ctx, r.YTDLP, args, MaxMetadataBytes)
	if err != nil {
		return nil, err
	}
	if len(output) > MaxMetadataBytes {
		return nil, ErrMetadataTooLarge
	}
	var data metadata
	if err := json.Unmarshal(output, &data); err != nil {
		return nil, ErrMetadataInvalid
	}
	return parseTracks(data, kind)
}

type metadata struct {
	Type          *string         `json:"_type"`
	Extractor     string          `json:"extractor_key"`
	ID            string          `json:"id"`
	Title         string          `json:"title"`
	Uploader      string          `json:"uploader"`
	Duration      json.RawMessage `json:"duration"`
	Availability  string          `json:"availability"`
	PlaylistCount *int            `json:"playlist_count"`
	Entries       []metadataEntry `json:"entries"`
}

type metadataEntry struct {
	Type         *string         `json:"_type"`
	Extractor    string          `json:"ie_key"`
	Extractor2   string          `json:"extractor_key"`
	ID           string          `json:"id"`
	Title        string          `json:"title"`
	Uploader     string          `json:"uploader"`
	Duration     json.RawMessage `json:"duration"`
	Availability string          `json:"availability"`
}

func parseTracks(data metadata, kind inputKind) ([]music.Track, error) {
	if data.Type != nil && *data.Type == "" {
		return nil, ErrMetadataInvalid
	}
	if kind == kindVideo {
		if data.Extractor != "Youtube" || (data.Type != nil && *data.Type != "video") || len(data.Entries) != 0 {
			return nil, ErrMetadataInvalid
		}
		track, err := makeTrack(data.ID, data.Title, data.Uploader, data.Duration, data.Availability, data.Extractor)
		if err != nil {
			return nil, err
		}
		return []music.Track{track}, nil
	}
	rootIsYouTube := data.Extractor == "Youtube" || kind == kindPlaylist && data.Extractor == "YoutubeTab"
	if !rootIsYouTube || data.Type == nil || *data.Type != "playlist" || data.PlaylistCount == nil || *data.PlaylistCount <= 0 ||
		*data.PlaylistCount > MaxPlaylistItems || len(data.Entries) != *data.PlaylistCount ||
		(kind == kindSearch && len(data.Entries) > MaxSearchResults) {
		return nil, ErrMetadataInvalid
	}
	tracks := make([]music.Track, 0, len(data.Entries))
	for _, entry := range data.Entries {
		extractor := entry.Extractor
		if entry.Type == nil || *entry.Type == "video" {
			extractor = entry.Extractor2
		} else if *entry.Type != "url" {
			return nil, ErrMetadataInvalid
		}
		track, err := makeTrack(entry.ID, entry.Title, entry.Uploader, entry.Duration, entry.Availability, extractor)
		if err != nil {
			return nil, err
		}
		tracks = append(tracks, track)
	}
	return tracks, nil
}

func makeTrack(id, title, uploader string, rawDuration json.RawMessage, availability, extractor string) (music.Track, error) {
	if extractor != "Youtube" || !idPattern.MatchString(id) || title == "" || len(title) > MaxTitleBytes || strings.TrimSpace(title) != title {
		return music.Track{}, ErrMetadataInvalid
	}
	if invalidText(title) || len(uploader) > music.MaxMetadataBytes || invalidText(uploader) ||
		(availability != "" && availability != "public" && availability != "unlisted") {
		return music.Track{}, ErrMetadataInvalid
	}
	duration, err := parseDuration(rawDuration)
	if err != nil {
		return music.Track{}, ErrMetadataInvalid
	}
	return music.Track{
		ID: "yt:" + id, Provider: music.ProviderYouTube,
		CanonicalID: id, Title: title, Artist: uploader, DurationMS: duration,
	}, nil
}

func invalidText(value string) bool {
	for _, r := range value {
		if unicode.IsControl(r) {
			return true
		}
	}
	return false
}

func parseDuration(raw json.RawMessage) (int64, error) {
	if len(raw) == 0 || string(raw) == "null" {
		return 0, nil
	}
	var seconds float64
	if err := json.Unmarshal(raw, &seconds); err != nil || math.IsNaN(seconds) || math.IsInf(seconds, 0) || seconds <= 0 || seconds > MaxDuration.Seconds() {
		return 0, fmt.Errorf("invalid duration")
	}
	return int64(math.Round(seconds * 1000)), nil
}
