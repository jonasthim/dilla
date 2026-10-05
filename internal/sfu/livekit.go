package sfu

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"sync/atomic"
	"time"

	"github.com/livekit/livekit-server/pkg/config"
	"github.com/livekit/livekit-server/pkg/routing"
	"github.com/livekit/livekit-server/pkg/service"
	"github.com/livekit/livekit-server/pkg/telemetry/prometheus"
	"github.com/livekit/protocol/auth"
	"github.com/livekit/protocol/livekit"
)

// adminTokenTTL bounds the short-lived RoomService token DeleteRoom signs for itself.
const adminTokenTTL = time.Minute

// tokenTTL bounds when a call token may first be used to join. It does not bound a session: LiveKit
// re-mints a connected participant's token every five minutes from its CURRENT grants
// (roommanager.go:62-63, 1146-1170), so only DeleteRoom or RemoveParticipants ends one.
const tokenTTL = time.Hour

// startTimeout bounds how long Start waits for the HTTP listener. It is a var,
// not a const, only so livekit_test.go can shorten it and exercise the
// deadline-expired abort path without waiting 15 s.
var startTimeout = 15 * time.Second

// Server is a running in-process LiveKit SFU.
type Server struct {
	cfg    Config
	server *service.LivekitServer
	// errCh carries LivekitServer.Start's result. Start reads it while booting; after boot only
	// watch reads it.
	errCh chan error
	// exited is closed once LivekitServer.Start has returned after boot; exitErr is its result.
	exited  chan struct{}
	exitErr error
	// done receives one error when Start returned without Stop (DEV-42 a).
	done     chan error
	stopping atomic.Bool
}

// Start boots the SFU. LivekitServer.Start blocks on <-s.doneChan, so it runs in
// its own goroutine and Start returns once the HTTP port accepts a connection.
//
// Start is not repeatable within one process as far as metrics are concerned.
// prometheus.Init is idempotent by design — its first statement is
// `if initialized.Swap(true) { return nil }` (livekit-server v1.13.7
// pkg/telemetry/prometheus/node.go:51) — so a second Start in the same process
// returns nil from it without re-creating a single collector. The node_id and
// node_type ConstLabels baked into every LiveKit metric therefore remain the
// *first* node's, whatever node the second Start was given. Nothing here can fix
// that: the vectors are package-level in livekit-server and registered on the
// global default registry. Run one SFU per process, or read the metrics knowing
// whose labels they carry.
func Start(ctx context.Context, c Config) (*Server, error) {
	yaml, err := c.YAML()
	if err != nil {
		return nil, err
	}
	// Both trailing arguments are untyped nils: NewConfig's third parameter is
	// *cli.Command and its fourth is []cli.Flag, so urfave/cli is never
	// imported, and with c == nil the CLI branch is not even entered.
	conf, err := config.NewConfig(yaml, true, nil, nil)
	if err != nil {
		return nil, fmt.Errorf("sfu: config: %w", err)
	}
	if err := conf.ValidateKeys(); err != nil {
		return nil, fmt.Errorf("sfu: keys: %w", err)
	}
	if err := conf.LoadTURNSecrets(); err != nil {
		return nil, fmt.Errorf("sfu: turn secrets: %w", err)
	}
	// LiveKit and pion read the logger as transports are built during initialization.
	// The bridge is installed once per process and only its handler is swapped here, so LiveKit's
	// package-level logger is never written again while an earlier server's goroutines read it.
	// It does not replace slog.Default.
	sink := slog.DiscardHandler
	if c.Log != nil {
		sink = c.Log.Handler()
	}
	installLiveKitLogger(sink)
	node, err := routing.NewLocalNode(conf)
	if err != nil {
		return nil, fmt.Errorf("sfu: local node: %w", err)
	}
	// Before InitializeServer: Init registers on the global default registry and
	// the package's metric vectors are nil until it runs.
	if err := prometheus.Init(string(node.NodeID()), node.NodeType()); err != nil {
		return nil, fmt.Errorf("sfu: prometheus: %w", err)
	}
	srv, err := service.InitializeServer(conf, node)
	if err != nil {
		return nil, fmt.Errorf("sfu: initialize: %w", err)
	}

	s := &Server{cfg: c, server: srv, errCh: make(chan error, 1), exited: make(chan struct{}), done: make(chan error, 1)}
	go func() { s.errCh <- s.server.Start() }()

	addr := net.JoinHostPort(c.BindAddress, fmt.Sprint(c.Port))
	deadline := time.Now().Add(startTimeout)
	for {
		select {
		case err := <-s.errCh:
			return nil, fmt.Errorf("sfu: server exited during startup: %w", err)
		case <-ctx.Done():
			return nil, s.abort(ctx.Err())
		default:
		}
		// The dial only confirms what IsRunning already says; a squatter cannot fool it. LiveKit sets
		// its running flag (server.go:333) only after its own net.Listen on <bind>:<port> succeeded
		// (server.go:246-251); on a squatted address that Listen fails with EADDRINUSE, Start
		// returns it on errCh and the select above reports it (TestASquattedPortFailsStart). The bind
		// address is a loopback literal (YAML refuses a hostname), so the dial reaches the address
		// LiveKit bound and no other.
		if s.server.IsRunning() {
			conn, err := (&net.Dialer{Timeout: 500 * time.Millisecond}).DialContext(ctx, "tcp", addr)
			if err == nil {
				_ = conn.Close()
				go s.watch()
				return s, nil
			}
		}
		if time.Now().After(deadline) {
			return nil, s.abort(fmt.Errorf("sfu: %s did not accept a connection within %s", addr, startTimeout))
		}
		time.Sleep(50 * time.Millisecond)
	}
}

// watch reports an unrequested post-boot LiveKit exit to dillad.
func (s *Server) watch() {
	err := <-s.errCh
	s.exitErr = err
	close(s.exited)
	if s.stopping.Load() {
		return
	}
	if err == nil {
		err = errors.New("sfu: LiveKit's server returned without a Stop")
	}
	s.done <- err
}

// Done delivers one error if LiveKit exits after boot without Stop.
func (s *Server) Done() <-chan error { return s.done }

// abortPollInterval and abortPollLimit bound the wait inside abort:
// 100 × 50 ms = 5 s, far past LiveKit's deliberate 100 ms sleep.
const (
	abortPollInterval = 50 * time.Millisecond
	abortPollLimit    = 100
)

// abort tears down a server that Start is giving up on, and returns the error
// Start should report.
//
// It cannot simply call Stop: LivekitServer.Stop begins `if !s.running.Swap(false)
// { return }` (server.go:373), so it is a no-op while the running flag is still
// false — and the flag is only set at server.go:333, after a deliberate 100 ms
// sleep, while the TCP listeners were already bound at server.go:246. Stopping
// inside that window does nothing: the boot finishes, the goroutine parks on
// <-doneChan forever, the ports stay bound, and because Start returns no *Server
// on its error paths, nothing can ever stop it.
//
// So wait for the flag — or for the boot goroutine to fail, which frees the
// listeners by itself — before stopping. If neither happens within the bound,
// say so in the returned error instead of leaking silently.
func (s *Server) abort(cause error) error {
	for i := 0; i < abortPollLimit && !s.server.IsRunning(); i++ {
		select {
		case err := <-s.errCh:
			// Start has already returned: there is nothing left to stop.
			if err != nil {
				return errors.Join(cause, fmt.Errorf("sfu: server exited during startup: %w", err))
			}
			return cause
		default:
		}
		time.Sleep(abortPollInterval)
	}
	running := s.server.IsRunning()
	s.server.Stop(true)
	if !running {
		return errors.Join(cause, fmt.Errorf(
			"sfu: server was still not running after %s, so Stop could not take effect; "+
				"the boot goroutine and ports %d/%d may be leaked",
			time.Duration(abortPollLimit)*abortPollInterval, s.cfg.Port, s.cfg.UDPPort))
	}
	return cause
}

// URL is the signalling endpoint participants connect to.
func (s *Server) URL() string {
	return "ws://" + net.JoinHostPort(s.cfg.BindAddress, fmt.Sprint(s.cfg.Port))
}

// HTTPURL is the same endpoint over HTTP, for /metrics and the proxy paths
// /rtc, /rtc/validate, /rtc/v1 and /rtc/v1/validate.
func (s *Server) HTTPURL() string {
	return "http://" + net.JoinHostPort(s.cfg.BindAddress, fmt.Sprint(s.cfg.Port))
}

// Token mints a room-join JWT for identity (the dilla device id in production) whose grants are
// exactly perm — PublishGrant's mirror of speak/video/screen_share, never a data grant — and whose
// participant attributes are attrs (DEV-07's dilla.vdec). perm goes through UpdateFromPermission,
// the same conversion a live UpdateParticipant applies, so a minted grant and a pushed one cannot
// drift.
func (s *Server) Token(room, identity string, perm *livekit.ParticipantPermission, attrs map[string]string) (string, error) {
	if room == "" || identity == "" {
		return "", errors.New("sfu: room and identity must both be set")
	}
	if perm == nil {
		return "", errors.New("sfu: a room token needs a permission")
	}
	grant := &auth.VideoGrant{RoomJoin: true, Room: room}
	grant.UpdateFromPermission(perm)
	t := auth.NewAccessToken(s.cfg.APIKey, s.cfg.APISecret).
		SetIdentity(identity).
		SetName(identity).
		SetValidFor(tokenTTL).
		SetVideoGrant(grant)
	if len(attrs) > 0 {
		t = t.SetAttributes(attrs)
	}
	return t.ToJWT()
}

// DeleteRoom closes room and disconnects every participant still in it, through LiveKit's own
// RoomService API on the loopback HTTP port with a one-minute token carrying roomCreate (the grant
// LiveKit's DeleteRoom checks). A room LiveKit does not know — never joined, already empty and
// reaped, or deleted before — answers twirp's not_found, which is success here: the call is over
// either way.
func (s *Server) DeleteRoom(ctx context.Context, room string) error {
	if room == "" {
		return errors.New("sfu: room must be set")
	}
	rs, ctx, err := s.roomServiceFor(ctx, &auth.VideoGrant{RoomCreate: true})
	if err != nil {
		return err
	}
	if _, err := rs.DeleteRoom(ctx, &livekit.DeleteRoomRequest{Room: room}); err != nil {
		if isTwirpNotFound(err) {
			return nil
		}
		return fmt.Errorf("sfu: delete room %q: %w", room, err)
	}
	return nil
}

// Stop shuts the server down and waits for Start to return.
func (s *Server) Stop(ctx context.Context) error {
	s.stopping.Store(true)
	s.server.Stop(true)
	select {
	case <-s.exited:
		if s.exitErr != nil && !errors.Is(s.exitErr, net.ErrClosed) {
			return fmt.Errorf("sfu: server: %w", s.exitErr)
		}
		return nil
	case <-ctx.Done():
		return ctx.Err()
	case <-time.After(startTimeout):
		return errors.New("sfu: server did not stop within the timeout")
	}
}
