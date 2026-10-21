package main

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"slices"
	"sync"
	"sync/atomic"
	"time"

	"github.com/caddyserver/certmagic"

	"github.com/jonasthim/dilla/internal/config"
	"github.com/jonasthim/dilla/internal/dillad"
	"github.com/jonasthim/dilla/internal/exit"
	"github.com/jonasthim/dilla/internal/ops"
	"github.com/jonasthim/dilla/internal/server"
)

// turnCapability is the media.json capability a `dillad media` lists once it has bound turn.listen.
const turnCapability = "turn"

// mediaTURNLevel is the first media level whose `dillad media` serves TURN (web3.12, R-UP11).
const mediaTURNLevel = 2

// turnPlan is who serves TURN while this `dillad serve` runs, decided once at its start (R-UP11).
// At most one of demux and listen is set; media means `dillad media` serves turn.listen and every
// cut is forwarded to it over media.sock.
type turnPlan struct {
	demux  bool // this process's relay behind the 443 TLS demux (public mode without turn.listen)
	listen bool // this process binds turn.listen
	media  bool // dillad media holds turn.listen
}

// staticTURNPlan is planTURN without asking dilla-media: TURN on the 443 demux without turn.listen,
// on turn.listen with it, and nowhere when turn.enabled is false.
func staticTURNPlan(cfg *config.Config) turnPlan {
	switch {
	case !cfg.TURN.Enabled:
		return turnPlan{}
	case cfg.TURN.Listen == "":
		return turnPlan{demux: true}
	}
	return turnPlan{listen: true}
}

// mediaTURNRetry is how often `dillad media` retries a turn.listen bind that failed: during the
// R-UP4 handoff the API still holds the port. A variable so a test can shorten it.
var mediaTURNRetry = 5 * time.Second

// turnHandoffWait is how long serve waits, at its start, for a `dillad media` of a TURN-capable
// level that has not bound turn.listen yet: during the R-UP4 handoff the old API held the port, and
// the media process retries its bind every mediaTURNRetry, so it takes the port within one retry
// of the old API letting go. A variable so a test can shorten it.
var turnHandoffWait = mediaTURNRetry + 2*time.Second

// planTURN decides who serves TURN (R-UP11):
//
//   - turn.enabled false: nobody.
//   - no turn.listen (public mode without the opt-in): this process's 443 demux relay, whatever
//     media.json says, so public mode never loses TURN.
//   - the SFU in this process (livekit.mode in_process, or LiveKit off): this process binds
//     turn.listen, as before.
//   - a sidecar SFU whose valid media.json lists "turn": `dillad media` holds turn.listen, and this
//     process binds nothing.
//   - a sidecar SFU without "turn" in its media.json (a web3.11 SFU, no file, or a stale one): this
//     process binds turn.listen, so exactly one process holds it. When the file names a level that
//     serves TURN, serve first waits up to turnHandoffWait for its bind (the handoff).
func planTURN(ctx context.Context, cfg *config.Config, log *slog.Logger) turnPlan {
	if !cfg.TURN.Enabled || cfg.TURN.Listen == "" || !cfg.LiveKit.Enabled || cfg.LiveKit.Mode != "sidecar" {
		return staticTURNPlan(cfg)
	}
	st, err := readMediaState(ctx, cfg.Instance.DataDir)
	if err == nil && !slices.Contains(st.Capabilities, turnCapability) && st.MediaLevel >= mediaTURNLevel {
		log.Info("dilla-media serves TURN at its level but has not bound turn.listen yet; waiting for it",
			"listen", cfg.TURN.Listen, "wait", turnHandoffWait)
		deadline := time.Now().Add(turnHandoffWait)
		for time.Now().Before(deadline) && ctx.Err() == nil {
			time.Sleep(250 * time.Millisecond)
			if st, err = readMediaState(ctx, cfg.Instance.DataDir); err != nil || slices.Contains(st.Capabilities, turnCapability) {
				break
			}
		}
	}
	if err == nil && slices.Contains(st.Capabilities, turnCapability) {
		log.Info("TURN is served by dilla-media on turn.listen; cuts are forwarded to it over media.sock",
			"listen", cfg.TURN.Listen, "media_version", st.Version)
		return turnPlan{media: true}
	}
	why := "its media.json does not list turn"
	if err != nil {
		why = err.Error()
	}
	log.Info("TURN is served by this process on turn.listen: dilla-media does not serve it", "listen", cfg.TURN.Listen, "why", why)
	return turnPlan{listen: true}
}

// listenAPISocket binds api.sock in the state directory (R-UP11). When dilla-media serves TURN
// (plan.media) the socket is required — its relay's barred lookup and `dillad media --idle` depend
// on it — so a bind failure is an error that ends serve with exit 69, which systemd retries and the
// operator sees. Otherwise the failure is logged at ERROR and serve goes on without it (nil, nil):
// `dillad media --idle` then reads busy, so the refresh timer never restarts the SFU on a guess.
func listenAPISocket(ctx context.Context, cfg *config.Config, plan turnPlan, log *slog.Logger) (net.Listener, error) {
	path := server.ControlSocketPath(cfg.Instance.DataDir, server.APISocketName)
	ln, err := server.ListenControl(ctx, path, log)
	switch {
	case err == nil:
		return ln, nil
	case plan.media:
		return nil, fmt.Errorf("serve: dilla-media serves TURN and needs api.sock: %w: %w", err, exit.Unavailable)
	}
	log.Error("api.sock is not served: `dillad media --idle` reads busy until it is", "err", err)
	return nil, nil
}

// serveAPISocket serves api.sock on ln: the composition root's routes
// (dillad.Server.ControlHandler) and GET /relay/state, which says whether this process serves a
// relay itself (the doctor's owner check) and how many cuts dilla-media has not acknowledged yet
// (fwd, nil when the relay is this process's). It returns the stop.
func serveAPISocket(ln net.Listener, cfg *config.Config, srv *dillad.Server, rev *server.RelayRevocations,
	fwd *server.RelayRevoker, started *atomic.Pointer[server.TURN], log *slog.Logger) (stop func()) {
	since := time.Now().UnixMilli()
	mux := srv.ControlHandler()
	mux.HandleFunc("GET /relay/state", func(w http.ResponseWriter, _ *http.Request) {
		cut := rev.State()
		st := server.RelayState{Owner: "api", Cuts: cut.Cuts, Floor: cut.Floor, Started: since}
		if fwd != nil {
			st.Unacked = fwd.UnackedCount()
		}
		if t := started.Load(); t != nil {
			st.Serving, st.Allocations = true, t.AllocationCount()
			st.Listen = cfg.TURN.Listen
			if st.Listen == "" {
				st.Listen = cfg.Server.Listen + " (the TLS demux)"
			}
		}
		server.WriteControlJSON(w, st)
	})
	return server.ServeControl(ln, mux, log)
}

// storedCertificate serves, read-only, the certificate `dillad serve`'s certmagic keeps for name
// under storageDir (the public-mode opt-in turn.listen of `dillad media`, R-UP11). It never issues
// or renews: it re-reads the storage when a certificate file there has changed, looking at most
// every certRecheck, so a renewal by serve reaches the relay's next handshake after that.
type storedCertificate struct {
	dir, name string
	load      func(*tls.ClientHelloInfo) (*tls.Certificate, error)

	mu      sync.Mutex
	cert    *tls.Certificate
	stamp   string
	checked time.Time
}

// certRecheck is how often storedCertificate looks for a renewed certificate.
var certRecheck = 30 * time.Second

func newStoredCertificate(storageDir, name string) *storedCertificate {
	safe := certmagic.StorageKeys.Safe(name)
	return &storedCertificate{dir: storageDir, name: safe, load: ops.CertificateFromStorage(storageDir, safe)}
}

// stampOf is the certificate files' names, sizes and modification times: what changes when
// certmagic writes a renewed certificate.
func (s *storedCertificate) stampOf() string {
	matches, _ := filepath.Glob(filepath.Join(s.dir, "certificates", "*", s.name, s.name+".*"))
	stamp := ""
	for _, m := range matches {
		if fi, err := os.Stat(m); err == nil {
			stamp += fmt.Sprintf("%s:%d:%d;", m, fi.Size(), fi.ModTime().UnixNano())
		}
	}
	return stamp
}

// GetCertificate is tls.Config's: the certificate on disk, re-read when it changed.
func (s *storedCertificate) GetCertificate(hello *tls.ClientHelloInfo) (*tls.Certificate, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	now := time.Now()
	if s.cert != nil && now.Sub(s.checked) < certRecheck {
		return s.cert, nil
	}
	s.checked = now
	stamp := s.stampOf()
	if s.cert != nil && stamp == s.stamp {
		return s.cert, nil
	}
	c, err := s.load(hello)
	if err != nil {
		if s.cert != nil {
			return s.cert, nil // keep serving the last good one
		}
		return nil, err
	}
	if c.Leaf == nil && len(c.Certificate) > 0 {
		c.Leaf, _ = x509.ParseCertificate(c.Certificate[0])
	}
	s.cert, s.stamp = c, stamp
	return c, nil
}

// errNoTLSName is a public-mode config without the name its certificate is for.
var errNoTLSName = errors.New("no instance.domain or instance.public_ip to read a certificate for")

// relayTLSConfig is the TLS the public-mode opt-in turn.listen serves (`turns:`): the certificate
// serve's certmagic keeps, read from its storage, never issued or renewed here.
func relayTLSConfig(cfg *config.Config) (*tls.Config, error) {
	name := cfg.Instance.Domain
	if cfg.TLS.Mode == config.TLSModeACMEIP {
		name = cfg.Instance.PublicIP.String()
	}
	if name == "" {
		return nil, errNoTLSName
	}
	sc := newStoredCertificate(cfg.TLS.StorageDir, name)
	return &tls.Config{GetCertificate: sc.GetCertificate, MinVersion: tls.VersionTLS12}, nil
}
