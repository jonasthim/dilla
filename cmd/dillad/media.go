package main

import (
	"context"
	"fmt"
	"io"
	"os"
	"os/signal"
	"syscall"

	"github.com/jonasthim/dilla/internal/clock"
	"github.com/jonasthim/dilla/internal/config"
	"github.com/jonasthim/dilla/internal/exit"
	"github.com/jonasthim/dilla/internal/obs"
)

// runMedia keeps the SFU in its own process while dillad serve is replaced. It opens no database,
// API listener or web client. The API process owns the webhook receiver and the /rtc join gate.
func runMedia(args []string, stdout, stderr io.Writer) error {
	fs, cfgPath := newFlagSet("media", stderr)
	if err := parse(fs, args, stdout); err != nil {
		return err
	}
	cfg, err := config.Load(*cfgPath)
	if err != nil {
		return err
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	return serveMedia(ctx, cfg, stdout, stderr)
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
