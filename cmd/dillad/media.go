package main

import (
	"context"
	"fmt"
	"io"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/jonasthim/dilla/internal/clock"
	"github.com/jonasthim/dilla/internal/config"
	"github.com/jonasthim/dilla/internal/exit"
	"github.com/jonasthim/dilla/internal/obs"
	"github.com/jonasthim/dilla/internal/sfu"
)

// runMedia keeps the SFU in its own process while dillad serve is replaced. It opens no database,
// API listener or web client. The API process owns the webhook receiver and the /rtc join gate.
func runMedia(args []string, stdout, stderr io.Writer) error {
	fs, cfgPath := newFlagSet("media", stderr)
	probe := fs.Bool("probe", false, "check whether the media sidecar accepts RoomService requests")
	if err := parse(fs, args, stdout); err != nil {
		return err
	}
	cfg, err := config.Load(*cfgPath)
	if err != nil {
		return err
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if *probe {
		if !cfg.LiveKit.Enabled || cfg.LiveKit.Mode != "sidecar" {
			return fmt.Errorf("media probe: livekit.enabled must be true and livekit.mode must be sidecar: %w", exit.Config)
		}
		secret, err := os.ReadFile(cfg.LiveKit.APISecretFile)
		if err != nil {
			return fmt.Errorf("media probe: livekit.api_secret_file: %w: %w", err, exit.Config)
		}
		remote := sfu.NewRemote(sfuConfig(cfg.LiveKit, string(secret)))
		if err := waitRemoteSFU(ctx, remote, 20*time.Second); err != nil {
			return fmt.Errorf("media probe: %w: %w", err, exit.Unavailable)
		}
		return nil
	}
	return serveMedia(ctx, cfg, stdout, stderr)
}

type roomLister interface {
	Rooms(context.Context) ([]string, error)
}

// A systemd Type=simple or Compose process can exist before LiveKit accepts requests. A
// successful authenticated RoomService call is the readiness signal shared by serve and install.
func waitRemoteSFU(ctx context.Context, remote roomLister, deadline time.Duration) error {
	ctx, cancel := context.WithTimeout(ctx, deadline)
	defer cancel()
	var last error
	for {
		probeCtx, stop := context.WithTimeout(ctx, 2*time.Second)
		_, err := remote.Rooms(probeCtx)
		stop()
		if err == nil {
			return nil
		}
		last = err
		select {
		case <-ctx.Done():
			return fmt.Errorf("sidecar did not become ready: %w: %w", last, ctx.Err())
		case <-time.After(200 * time.Millisecond):
		}
	}
}

func serveMedia(ctx context.Context, cfg *config.Config, stdout, stderr io.Writer) error {
	if !cfg.LiveKit.Enabled || cfg.LiveKit.Mode != "sidecar" {
		return fmt.Errorf("media: livekit.enabled must be true and livekit.mode must be sidecar: %w", exit.Config)
	}
	// startSFU's in_process check protects the ordinary serve path. This copy selects the same
	// validated SFU settings without changing the API process's sidecar configuration.
	mediaCfg := *cfg
	mediaCfg.LiveKit.Mode = "in_process"
	fd := frontDeps{cfg: &mediaCfg, log: obs.NewLogger(cfg.Log, stderr), health: obs.NewHealth(clock.System()), stdout: stdout}
	s, closeSFU, err := startSFU(ctx, fd)
	if err != nil {
		if ctx.Err() != nil {
			return nil
		}
		return err
	}
	defer closeSFU()
	select {
	case <-ctx.Done():
		return nil
	case err := <-s.Done():
		if ctx.Err() != nil {
			return nil
		}
		return fmt.Errorf("media: SFU stopped: %w: %w", err, exit.Unavailable)
	}
}
