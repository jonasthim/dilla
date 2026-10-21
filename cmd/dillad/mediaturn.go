package main

import (
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/netip"
	"sync"
	"time"

	"github.com/jonasthim/dilla/internal/clock"
	"github.com/jonasthim/dilla/internal/config"
	"github.com/jonasthim/dilla/internal/server"
)

// mediaTURN is the TURN relay `dillad media` serves on turn.listen (R-UP11, UP8), so a relayed
// call outlives an API restart: behind a proxy the same turn.listen (and turn.proxy_protocol) the
// API used to bind, in public mode the opt-in turn.listen with `turns:` over the certificate serve's
// certmagic keeps, read only.
//
// The relay keeps revocation state of its own. Its floor is this process's start, raised to the
// moment it binds turn.listen (bind): every credential
// minted before it is refused, so a cut set lost with a restart of this process can never be
// bypassed (and the restart has ended the calls anyway). The API feeds its cuts over media.sock
// (POST /relay/cut, and PUT /relay/cuts on every reconnect: a merge), and the relay asks the API
// over api.sock whether an authenticated device is barred, with today's semantics: a failed lookup
// caches nothing, is logged at WARN, and the cut map stays authoritative. It records every cut —
// the mints happen in the API — within the map's bound.
type mediaTURN struct {
	cfg     *config.Config
	log     *slog.Logger
	rev     *server.RelayRevocations
	started time.Time
	anchor  netip.Addr
	peers   server.TURNPeers
	tls     *tls.Config // the public-mode opt-in's; nil behind a proxy

	stopSock func()

	mu  sync.Mutex
	srv *server.TURN
}

// newMediaTURN prepares the relay and serves media.sock; it binds nothing on turn.listen yet
// (bind). An error is the relay's configuration (or media.sock): the SFU goes on without TURN, and
// the API keeps serving it.
func newMediaTURN(ctx context.Context, cfg *config.Config, log *slog.Logger) (*mediaTURN, error) {
	m := &mediaTURN{cfg: cfg, log: log, started: time.Now()}
	keep := max(cfg.TURN.MaxAllocationAge.Value(), cfg.TURN.CredentialTTL.Value())
	m.rev = server.NewRelayRevocations(keep, clock.System()).WithBarred(server.RemoteBarred{
		Client: server.ControlClient(server.ControlSocketPath(cfg.Instance.DataDir, server.APISocketName)),
	}, log)
	var err error
	if m.anchor, m.peers, err = turnPeers(cfg, hostInterfaces, log); err != nil {
		return nil, fmt.Errorf("turn: %w", err)
	}
	if !cfg.BehindProxy() {
		if m.tls, err = relayTLSConfig(cfg); err != nil {
			return nil, fmt.Errorf("turn: %w", err)
		}
	}
	ln, err := server.ListenControl(ctx, server.ControlSocketPath(cfg.Instance.DataDir, server.MediaSocketName), log)
	if err != nil {
		return nil, err
	}
	m.stopSock = server.ServeControl(ln, server.NewRelayControl(m.rev, m.state), log)
	return m, nil
}

// state is GET /relay/state on media.sock.
func (m *mediaTURN) state() server.RelayState {
	cut := m.rev.State()
	st := server.RelayState{Owner: "media", Cuts: cut.Cuts, Floor: cut.Floor, Started: m.started.UnixMilli()}
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.srv != nil {
		st.Serving, st.Listen, st.Allocations = true, m.cfg.TURN.Listen, m.srv.AllocationCount()
	}
	return st
}

// bound reports whether the relay holds turn.listen.
func (m *mediaTURN) bound() bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.srv != nil
}

// errTURNConfig is a relay start dilla.toml makes fail: retrying cannot help.
var errTURNConfig = errors.New("the relay's configuration is refused")

// bind takes turn.listen and starts the relay on it. A port another process holds (the API during
// the handoff) is an error to retry; errTURNConfig is one that is not.
func (m *mediaTURN) bind(ctx context.Context) error {
	ln, err := (&net.ListenConfig{}).Listen(ctx, "tcp", m.cfg.TURN.Listen)
	if err != nil {
		return err
	}
	// The floor moves to the bind (it stays at least the process start): cuts the API made while it
	// held turn.listen, before this handoff, live only in its own memory and are never replayed
	// here, so every credential issued before this listener existed is refused. Rooms are empty
	// at a handoff (R-UP4); a client that does relay gets a fresh credential from its next start.
	m.rev.RaiseFloor(time.Now())
	switch {
	case m.cfg.TURN.ProxyProtocol:
		ln = proxyProtocolListener(ln, m.cfg.Server.TrustedProxyCIDRs)
	case m.tls != nil:
		ln = tls.NewListener(ln, m.tls)
	}
	srv, err := server.StartTURN(m.cfg.TURN, ln, m.anchor, m.peers, nil, m.rev, clock.System(), m.log)
	if err != nil {
		_ = ln.Close()
		if server.IsTURNConfigError(err) {
			return fmt.Errorf("%w: %w", errTURNConfig, err)
		}
		return err
	}
	m.mu.Lock()
	m.srv = srv
	m.mu.Unlock()
	m.log.Info("TURN relay listening", "listen", m.cfg.TURN.Listen, "tls", m.tls != nil)
	return nil
}

// keepBinding retries bind every mediaTURNRetry until it succeeds (then runs onBound), the
// configuration is refused, or ctx ends. Each failure is logged.
func (m *mediaTURN) keepBinding(ctx context.Context, onBound func()) {
	for attempt := 0; ; attempt++ {
		err := m.bind(ctx)
		if err == nil {
			onBound()
			return
		}
		if errors.Is(err, errTURNConfig) {
			m.log.Error("dilla-media serves no TURN: its configuration is refused", "err", err)
			return
		}
		if attempt%12 == 0 { // the first failure, then about once a minute
			m.log.Warn("turn.listen is not free yet (the API may still hold it); retrying", "listen", m.cfg.TURN.Listen,
				"err", err, "retry_every", mediaTURNRetry, "attempts", attempt+1)
		}
		t := time.NewTimer(mediaTURNRetry)
		select {
		case <-ctx.Done():
			t.Stop()
			return
		case <-t.C:
		}
	}
}

// close stops the relay and media.sock.
func (m *mediaTURN) close() {
	m.mu.Lock()
	srv := m.srv
	m.srv = nil
	m.mu.Unlock()
	if srv != nil {
		_ = srv.Close()
	}
	m.stopSock()
}
