package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/signal"
	"regexp"
	"sort"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/livekit/protocol/livekit"

	"github.com/jonasthim/dilla/internal/clock"
	"github.com/jonasthim/dilla/internal/config"
	"github.com/jonasthim/dilla/internal/exit"
	"github.com/jonasthim/dilla/internal/obs"
	"github.com/jonasthim/dilla/internal/server"
	"github.com/jonasthim/dilla/internal/sfu"
)

// runMedia keeps the SFU in its own process while dillad serve is replaced. It opens no database,
// API listener or web client. The API process owns the webhook receiver and the /rtc join gate.
func runMedia(args []string, stdout, stderr io.Writer) error {
	fs, cfgPath := newFlagSet("media", stderr)
	probe := fs.Bool("probe", false, "check whether the media sidecar accepts RoomService requests")
	rooms := fs.Bool("rooms", false, "list the sidecar's live rooms and their participants")
	idle := fs.Bool("idle", false, "exit 0 when no call needs the sidecar, 1 when one does (rooms listed on stderr), 69 when it cannot tell")
	self := fs.Bool("self", false, "print what the running dilla-media reports about itself on media.sock (version, media_level, capabilities, pid) as one JSON line; 69 when it does not answer")
	if err := parse(fs, args, stdout); err != nil {
		return err
	}
	modes := 0
	for _, on := range []bool{*probe, *rooms, *idle, *self} {
		if on {
			modes++
		}
	}
	if modes > 1 {
		return usageError(stderr, "media", "--probe, --rooms, --idle and --self are exclusive")
	}
	cfg, err := config.Load(*cfgPath)
	if err != nil {
		return err
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if *self {
		return mediaSelf(ctx, cfg.Instance.DataDir, stdout)
	}
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
			return mediaIdle(ctx, remote, apiRecentMints(cfg.Instance.DataDir), time.Now(), stdout, stderr, 10*time.Second)
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
// as young; so does any call token the API minted within the last 60 s, or an API that does not
// say (mints). One attempt, no retry: the refresh timer asks again a minute later, and an SFU that
// does not answer must never be restarted on a guess.
func mediaIdle(ctx context.Context, remote roomInfoLister, mints recentMints, now time.Time, stdout, stderr io.Writer, deadline time.Duration) error {
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
	// R-UP4: a call token minted within the last 60 s may be on its way to the SFU. The API is
	// asked over api.sock; an API that does not answer counts as busy, so a start in flight never
	// races the restart.
	n, err := mints(ctx)
	if err != nil {
		fmt.Fprintf(stderr, "the API did not answer GET /media/recent-mints on api.sock: %v\n", err)
		return fmt.Errorf("media idle: the API cannot say whether a call is starting: %w", exit.Fail)
	}
	if n > 0 {
		fmt.Fprintf(stderr, "%d call tokens minted within the last 60 s\n", n)
		return fmt.Errorf("media idle: %d call tokens minted within 60 s: %w", n, exit.Fail)
	}
	_, err = fmt.Fprintf(stdout, "media idle: %d rooms, none in use, no call token minted within 60 s\n", len(rooms))
	return err
}

// selfToken is the character set a media.sock version or capability may use: the answer comes from
// a dillad-controlled process, and the installer reads it as root.
var selfToken = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9.+_-]{0,63}$`)

// mediaSelf prints the running media process's GET /media/self answer on media.sock as one JSON
// line, after checking it: a version and capabilities of plain tokens, a level of 0 to 999 and a
// positive pid. Anything else, or no answer, is exit.Unavailable and prints nothing.
func mediaSelf(ctx context.Context, dataDir string, stdout io.Writer) error {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	var st mediaState
	c := server.ControlClient(server.ControlSocketPath(dataDir, server.MediaSocketName))
	if err := server.FetchControl(ctx, c, "/media/self", &st); err != nil {
		return fmt.Errorf("media self: %w: %w", err, exit.Unavailable)
	}
	if !selfToken.MatchString(st.Version) || st.MediaLevel < 0 || st.MediaLevel > 999 || st.PID <= 0 {
		return fmt.Errorf("media self: media.sock answered a malformed self-description: %w", exit.Unavailable)
	}
	for _, c := range st.Capabilities {
		if !selfToken.MatchString(c) {
			return fmt.Errorf("media self: media.sock answered a malformed capability: %w", exit.Unavailable)
		}
	}
	if st.Capabilities == nil {
		st.Capabilities = []string{}
	}
	raw, err := json.Marshal(st)
	if err != nil {
		return err
	}
	_, err = fmt.Fprintf(stdout, "%s\n", raw)
	return err
}

// recentMints asks how many call tokens the API minted within the last 60 s.
type recentMints func(ctx context.Context) (int, error)

// apiRecentMints is recentMints over GET /media/recent-mints on the api.sock in dataDir.
func apiRecentMints(dataDir string) recentMints {
	client := server.ControlClient(server.ControlSocketPath(dataDir, server.APISocketName))
	return func(ctx context.Context) (int, error) {
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, "http://dillad/media/recent-mints", nil)
		if err != nil {
			return 0, err
		}
		resp, err := client.Do(req)
		if err != nil {
			return 0, err
		}
		defer func() { _ = resp.Body.Close() }()
		if resp.StatusCode != http.StatusOK {
			return 0, fmt.Errorf("GET /media/recent-mints: %s", resp.Status)
		}
		var out struct {
			Count *int `json:"count"`
		}
		if err := json.NewDecoder(io.LimitReader(resp.Body, 4096)).Decode(&out); err != nil {
			return 0, err
		}
		if out.Count == nil {
			return 0, errors.New("GET /media/recent-mints: the answer has no count")
		}
		return *out.Count, nil
	}
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
	// TURN (R-UP11): served here whenever turn.listen is configured. It is bound before READY when
	// the port is free (a fresh start, a reboot), so media.json lists "turn" from the first write
	// and the API, started after READY, binds nothing there. When the API still holds the port (the
	// handoff from a web3.11 SFU), READY means "media ready; TURN bind pending": the bind is retried
	// every mediaTURNRetry, and media.json is rewritten with "turn" once it succeeds — never before.
	var relay *mediaTURN
	if cfg.TURN.Enabled && cfg.TURN.Listen != "" {
		if relay, err = newMediaTURN(ctx, cfg, fd.log); err != nil {
			fd.log.Error("dilla-media serves no TURN; the API keeps serving it", "err", err)
			relay = nil
		} else {
			defer relay.close()
			if err := relay.bind(ctx); err != nil && errors.Is(err, errTURNConfig) {
				fd.log.Error("dilla-media serves no TURN: its configuration is refused", "err", err)
				relay.close()
				relay = nil
			}
		}
	}
	// media.sock: GET /media/self always (what the installer and the refresh timer ask the running
	// process), and the relay's routes while this process serves TURN. Without media.sock the API
	// could not feed the relay its cuts, so a relay is never run without it.
	var self atomic.Pointer[mediaState]
	if ln, err := server.ListenControl(ctx, server.ControlSocketPath(cfg.Instance.DataDir, server.MediaSocketName), fd.log); err != nil {
		fd.log.Error("media.sock is not served: the installer cannot confirm this media server, and it serves no TURN", "err", err)
		if relay != nil {
			relay.close()
			relay = nil
		}
	} else {
		mux := http.NewServeMux()
		mux.HandleFunc("GET /media/self", func(w http.ResponseWriter, _ *http.Request) {
			st := self.Load()
			if st == nil {
				http.Error(w, "not ready", http.StatusServiceUnavailable)
				return
			}
			server.WriteControlJSON(w, st)
		})
		if relay != nil {
			mux.Handle("/relay/", relay.handler())
		}
		defer server.ServeControl(ln, mux, fd.log)()
	}
	started := time.Now().UTC()
	writeState := func() error {
		caps := []string{}
		if relay != nil && relay.bound() {
			caps = append(caps, turnCapability)
		}
		st := mediaState{Version: Version, MediaLevel: sfu.MediaLevel, Capabilities: caps, PID: os.Getpid(), Started: started}
		if err := writeMediaState(cfg.Instance.DataDir, st); err != nil {
			return err
		}
		self.Store(&st)
		return nil
	}
	if err := writeState(); err != nil {
		return err
	}
	defer func() { _ = os.Remove(mediaStatePath(cfg.Instance.DataDir)) }() // a clean stop; a crash leaves a stale file the pid check catches
	notifyReady()
	if relay != nil && !relay.bound() {
		go relay.keepBinding(ctx, func() {
			if ctx.Err() != nil {
				return // stopping: media.json is being removed
			}
			if err := writeState(); err != nil {
				fd.log.Error("media.json could not be rewritten with turn; the API keeps treating TURN as unserved here", "err", err)
				return
			}
			fd.log.Info("TURN bound on turn.listen; media.json lists turn")
		})
	}
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
