package sfu

import (
	"context"
	"errors"
	"fmt"
	"net"
	"time"

	"github.com/livekit/livekit-server/pkg/config"
	"github.com/livekit/livekit-server/pkg/routing"
	"github.com/livekit/livekit-server/pkg/service"
	"github.com/livekit/livekit-server/pkg/telemetry/prometheus"
	"github.com/livekit/protocol/auth"
)

// tokenTTL matches the spec's one-hour, leaf-gated JWT.
const tokenTTL = time.Hour

// startTimeout bounds how long Start waits for the HTTP listener.
const startTimeout = 15 * time.Second

// Server is a running in-process LiveKit SFU.
type Server struct {
	cfg    Config
	server *service.LivekitServer
	errCh  chan error
}

// Start boots the SFU. LivekitServer.Start blocks on <-s.doneChan, so it runs in
// its own goroutine and Start returns once the HTTP port accepts a connection.
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

	s := &Server{cfg: c, server: srv, errCh: make(chan error, 1)}
	go func() { s.errCh <- s.server.Start() }()

	addr := net.JoinHostPort(c.BindAddress, fmt.Sprint(c.Port))
	deadline := time.Now().Add(startTimeout)
	for {
		select {
		case err := <-s.errCh:
			return nil, fmt.Errorf("sfu: server exited during startup: %w", err)
		case <-ctx.Done():
			s.server.Stop(true)
			return nil, ctx.Err()
		default:
		}
		if s.server.IsRunning() {
			conn, err := net.DialTimeout("tcp", addr, 500*time.Millisecond)
			if err == nil {
				_ = conn.Close()
				return s, nil
			}
		}
		if time.Now().After(deadline) {
			s.server.Stop(true)
			return nil, fmt.Errorf("sfu: %s did not accept a connection within %s", addr, startTimeout)
		}
		time.Sleep(50 * time.Millisecond)
	}
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

// Token mints a room-join JWT for one identity. The identity is the dilla
// device id in production; the grants mirror the spec's speak/video/stream
// permissions.
func (s *Server) Token(room, identity string) (string, error) {
	if room == "" || identity == "" {
		return "", errors.New("sfu: room and identity must both be set")
	}
	yes := true
	grant := &auth.VideoGrant{
		RoomJoin:       true,
		Room:           room,
		CanPublish:     &yes,
		CanSubscribe:   &yes,
		CanPublishData: &yes,
	}
	return auth.NewAccessToken(s.cfg.APIKey, s.cfg.APISecret).
		SetIdentity(identity).
		SetName(identity).
		SetValidFor(tokenTTL).
		SetVideoGrant(grant).
		ToJWT()
}

// Stop shuts the server down and waits for Start to return.
func (s *Server) Stop(ctx context.Context) error {
	s.server.Stop(true)
	select {
	case err := <-s.errCh:
		if err != nil && !errors.Is(err, net.ErrClosed) {
			return fmt.Errorf("sfu: server: %w", err)
		}
		return nil
	case <-ctx.Done():
		return ctx.Err()
	case <-time.After(startTimeout):
		return errors.New("sfu: server did not stop within the timeout")
	}
}
