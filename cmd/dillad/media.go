package main

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"os"
	"os/signal"
	"sort"
	"syscall"
	"time"

	"github.com/livekit/protocol/livekit"

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
	rooms := fs.Bool("rooms", false, "list the sidecar's live rooms and their participants")
	idle := fs.Bool("idle", false, "exit 0 when no call needs the sidecar, 1 when one does (rooms listed on stderr), 69 when it cannot tell")
	if err := parse(fs, args, stdout); err != nil {
		return err
	}
	modes := 0
	for _, on := range []bool{*probe, *rooms, *idle} {
		if on {
			modes++
		}
	}
	if modes > 1 {
		return usageError(stderr, "media", "--probe, --rooms and --idle are exclusive")
	}
	cfg, err := config.Load(*cfgPath)
	if err != nil {
		return err
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if modes == 1 {
		verb := "media probe"
		switch {
		case *rooms:
			verb = "media rooms"
		case *idle:
			verb = "media idle"
		}
		if !cfg.LiveKit.Enabled || cfg.LiveKit.Mode != "sidecar" {
			return fmt.Errorf("%s: livekit.enabled must be true and livekit.mode must be sidecar: %w", verb, exit.Config)
		}
		secret, err := os.ReadFile(cfg.LiveKit.APISecretFile)
		if err != nil {
			return fmt.Errorf("%s: livekit.api_secret_file: %w: %w", verb, err, exit.Config)
		}
		remote := sfu.NewRemote(sfuConfig(cfg.LiveKit, string(secret)))
		if *idle {
			return mediaIdle(ctx, remote, time.Now(), stdout, stderr, 10*time.Second)
		}
		if *rooms {
			return mediaRooms(ctx, remote, stdout, 20*time.Second)
		}
		return mediaProbe(ctx, remote, stdout, 20*time.Second)
	}
	return serveMedia(ctx, cfg, stdout, stderr)
}

type roomLister interface {
	Rooms(context.Context) ([]string, error)
	Participants(ctx context.Context, room string) ([]*livekit.ParticipantInfo, error)
}

// mediaProbe waits for the sidecar and prints how many rooms are live.
func mediaProbe(ctx context.Context, remote roomLister, stdout io.Writer, deadline time.Duration) error {
	rooms, err := waitRemoteSFURooms(ctx, remote, deadline)
	if err != nil {
		return fmt.Errorf("media probe: %w: %w", err, exit.Unavailable)
	}
	_, err = fmt.Fprintf(stdout, "media probe: ok, %d live rooms\n", len(rooms))
	return err
}

// mediaRooms prints each live room (sorted) as "<room>\t<n> participants", then the participants'
// identities (sorted) indented by two spaces; an empty SFU prints "no live rooms".
func mediaRooms(ctx context.Context, remote roomLister, stdout io.Writer, deadline time.Duration) error {
	// One deadline covers the readiness wait and every Participants call.
	ctx, cancel := context.WithTimeout(ctx, deadline)
	defer cancel()
	rooms, err := waitRemoteSFURooms(ctx, remote, deadline)
	if err != nil {
		return fmt.Errorf("media rooms: %w: %w", err, exit.Unavailable)
	}
	if len(rooms) == 0 {
		_, err = fmt.Fprintln(stdout, "no live rooms")
		return err
	}
	sort.Strings(rooms)
	var buf bytes.Buffer // printed only when every room listed
	for _, room := range rooms {
		parts, err := remote.Participants(ctx, room)
		if err != nil {
			return fmt.Errorf("media rooms: %w: %w", err, exit.Unavailable)
		}
		ids := make([]string, 0, len(parts))
		for _, p := range parts {
			ids = append(ids, p.GetIdentity())
		}
		sort.Strings(ids)
		fmt.Fprintf(&buf, "%s\t%d participants\n", room, len(ids))
		for _, i := range ids {
			fmt.Fprintf(&buf, "  %s\n", i)
		}
	}
	_, err = stdout.Write(buf.Bytes())
	return err
}

// idleMinRoomAge is how long a room counts as in use after it was created, even with nobody in it:
// a call start creates the room a moment before its first participant joins.
const idleMinRoomAge = 60 * time.Second

type roomInfoLister interface {
	RoomInfos(context.Context) ([]*livekit.Room, error)
}

// roomCreated is when a room was created; the zero time when the SFU did not say.
func roomCreated(r *livekit.Room) time.Time {
	switch {
	case r.GetCreationTimeMs() > 0:
		return time.UnixMilli(r.GetCreationTimeMs())
	case r.GetCreationTime() > 0:
		return time.Unix(r.GetCreationTime(), 0)
	}
	return time.Time{}
}

// mediaIdle answers "may the SFU be restarted now": nil when it may, exit.Fail when a room is in
// use (each listed on stderr), exit.Unavailable when the SFU cannot be asked. A room is in use
// while it has participants or is younger than idleMinRoomAge; a room whose age is unknown counts
// as young. One attempt, no retry: the refresh timer asks again a minute later, and an SFU that
// does not answer must never be restarted on a guess.
func mediaIdle(ctx context.Context, remote roomInfoLister, now time.Time, stdout, stderr io.Writer, deadline time.Duration) error {
	ctx, cancel := context.WithTimeout(ctx, deadline)
	defer cancel()
	rooms, err := remote.RoomInfos(ctx)
	if err != nil {
		return fmt.Errorf("media idle: %w: %w", err, exit.Unavailable)
	}
	sort.Slice(rooms, func(i, j int) bool { return rooms[i].GetName() < rooms[j].GetName() })
	busy := 0
	for _, r := range rooms {
		created := roomCreated(r)
		young := created.IsZero() || now.Sub(created) < idleMinRoomAge
		if r.GetNumParticipants() == 0 && !young {
			continue
		}
		busy++
		age := "age unknown"
		if !created.IsZero() {
			age = fmt.Sprintf("created %s ago", now.Sub(created).Round(time.Second))
		}
		fmt.Fprintf(stderr, "%s\t%d participants\t%s\n", r.GetName(), r.GetNumParticipants(), age)
	}
	if busy > 0 {
		return fmt.Errorf("media idle: %d of %d rooms in use: %w", busy, len(rooms), exit.Fail)
	}
	_, err = fmt.Fprintf(stdout, "media idle: %d rooms, none in use\n", len(rooms))
	return err
}

func waitRemoteSFU(ctx context.Context, remote roomLister, deadline time.Duration) error {
	_, err := waitRemoteSFURooms(ctx, remote, deadline)
	return err
}

// A systemd Type=simple or Compose process can exist before LiveKit accepts requests. A
// successful authenticated RoomService call is the readiness signal shared by serve and install;
// it returns the rooms that call listed.
func waitRemoteSFURooms(ctx context.Context, remote interface {
	Rooms(context.Context) ([]string, error)
}, deadline time.Duration) ([]string, error) {
	ctx, cancel := context.WithTimeout(ctx, deadline)
	defer cancel()
	var last error
	for {
		probeCtx, stop := context.WithTimeout(ctx, 2*time.Second)
		rooms, err := remote.Rooms(probeCtx)
		stop()
		if err == nil {
			return rooms, nil
		}
		last = err
		select {
		case <-ctx.Done():
			return nil, fmt.Errorf("sidecar did not become ready: %w: %w", last, ctx.Err())
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
	secret, err := os.ReadFile(cfg.LiveKit.APISecretFile)
	if err != nil {
		return fmt.Errorf("media: livekit.api_secret_file: %w: %w", err, exit.Config)
	}
	// Ready means the SFU accepts authenticated RoomService requests, as `serve` and the installer
	// already define it. media.json is written first and READY=1 sent after, so the installer's
	// wait for READY can rely on a valid file (R-UP5).
	if err := waitRemoteSFU(ctx, sfu.NewRemote(sfuConfig(mediaCfg.LiveKit, string(secret))), 30*time.Second); err != nil {
		if ctx.Err() != nil {
			return nil
		}
		return fmt.Errorf("media: %w: %w", err, exit.Unavailable)
	}
	if err := writeMediaState(cfg.Instance.DataDir, mediaState{
		Version:      Version,
		MediaLevel:   sfu.MediaLevel,
		Capabilities: []string{}, // "turn" is listed by UP8 once a TURN listener is bound
		PID:          os.Getpid(),
		Started:      time.Now().UTC(),
	}); err != nil {
		return err
	}
	defer func() { _ = os.Remove(mediaStatePath(cfg.Instance.DataDir)) }() // a clean stop; a crash leaves a stale file the pid check catches
	notifyReady()
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
