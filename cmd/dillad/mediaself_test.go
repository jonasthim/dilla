package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/jonasthim/dilla/internal/config"
	"github.com/jonasthim/dilla/internal/exit"
	"github.com/jonasthim/dilla/internal/server"
	"github.com/jonasthim/dilla/internal/sfu"
)

// UP3 fix round 1: the installer asks the RUNNING media server what it is, over media.sock, and
// never runs a binary to find out. `dillad media` serves GET /media/self whether or not it serves
// TURN, and `dillad media --self` prints that answer, which matches media.json.
func TestDillaMediaReportsItselfOnMediaSock(t *testing.T) {
	stubMediaMainPID(t, os.Getpid(), nil)
	fd := sfuDeps(t, func(lk *config.LiveKit) { lk.Mode = "sidecar"; lk.NodeIP = "127.0.0.1" })
	cfg := fd.cfg
	cfg.Instance.DataDir = shortSocketDir(t)
	cfg.TURN.Enabled = false

	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- serveMedia(ctx, cfg, &bytes.Buffer{}, &bytes.Buffer{}) }()
	deadline := time.Now().Add(30 * time.Second)
	for {
		if _, err := readMediaState(t.Context(), cfg.Instance.DataDir); err == nil {
			break
		}
		select {
		case err := <-done:
			t.Fatalf("media exited: %v", err)
		default:
		}
		if time.Now().After(deadline) {
			t.Fatal("media.json never appeared")
		}
		time.Sleep(50 * time.Millisecond)
	}
	var out bytes.Buffer
	if err := mediaSelf(t.Context(), cfg.Instance.DataDir, &out); err != nil {
		t.Fatalf("media --self: %v", err)
	}
	if strings.Count(out.String(), "\n") != 1 {
		t.Fatalf("media --self printed %q, want one line", out.String())
	}
	var got mediaState
	if err := json.Unmarshal(out.Bytes(), &got); err != nil {
		t.Fatalf("media --self is not JSON: %v (%q)", err, out.String())
	}
	if got.PID != os.Getpid() || got.Version != Version || got.MediaLevel != sfu.MediaLevel {
		t.Fatalf("media --self = %+v, want pid %d, version %s, level %d", got, os.Getpid(), Version, sfu.MediaLevel)
	}
	file, err := readMediaState(t.Context(), cfg.Instance.DataDir)
	if err != nil || file.PID != got.PID || file.Version != got.Version {
		t.Fatalf("media.json = %+v (%v), media --self = %+v: they must agree", file, err, got)
	}
	// Without a relay, media.sock carries no relay routes.
	c := server.ControlClient(server.ControlSocketPath(cfg.Instance.DataDir, server.MediaSocketName))
	if _, err := server.FetchRelayState(t.Context(), c); err == nil {
		t.Fatal("media.sock answers GET /relay/state without a relay")
	}
	cancel()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("media shutdown: %v", err)
		}
	case <-time.After(25 * time.Second):
		t.Fatal("media did not stop")
	}
	if err := mediaSelf(t.Context(), cfg.Instance.DataDir, &bytes.Buffer{}); !errors.Is(err, exit.Unavailable) {
		t.Fatalf("media --self with no media process = %v, want exit.Unavailable", err)
	}
}

// The answer comes from a dillad-controlled process: anything malformed is refused, not passed on.
func TestMediaSelfRefusesAMalformedAnswer(t *testing.T) {
	for name, body := range map[string]string{
		"no pid":       `{"version":"0.1.0-web3.12","media_level":2,"capabilities":[],"started":"2026-10-22T08:00:00Z"}`,
		"no version":   `{"media_level":2,"capabilities":[],"pid":42,"started":"2026-10-22T08:00:00Z"}`,
		"odd version":  `{"version":"0.1.0 web3.12;rm","media_level":2,"capabilities":[],"pid":42}`,
		"bad level":    `{"version":"0.1.0-web3.12","media_level":-1,"capabilities":[],"pid":42}`,
		"odd capacity": `{"version":"0.1.0-web3.12","media_level":2,"capabilities":["tu rn"],"pid":42}`,
		"not json":     `hello`,
	} {
		t.Run(name, func(t *testing.T) {
			dir := shortSocketDir(t)
			ln, err := server.ListenControl(t.Context(), server.ControlSocketPath(dir, server.MediaSocketName), nil)
			if err != nil {
				t.Fatal(err)
			}
			mux := http.NewServeMux()
			mux.HandleFunc("GET /media/self", func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write([]byte(body)) })
			stop := server.ServeControl(ln, mux, nil)
			defer stop()
			var out bytes.Buffer
			if err := mediaSelf(t.Context(), dir, &out); !errors.Is(err, exit.Unavailable) || out.Len() != 0 {
				t.Fatalf("media --self = %v, printed %q; want exit.Unavailable and nothing", err, out.String())
			}
		})
	}
}
