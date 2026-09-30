package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/netip"
	"os"
	"strings"
	"time"

	"github.com/pires/go-proxyproto"

	"github.com/jonasthim/dilla/internal/clock"
	"github.com/jonasthim/dilla/internal/config"
	"github.com/jonasthim/dilla/internal/exit"
	"github.com/jonasthim/dilla/internal/obs"
	"github.com/jonasthim/dilla/internal/server"
	"github.com/jonasthim/dilla/internal/sfu"
)

// handshakeTimeout bounds the 443 demux's TLS handshake and its eight-byte
// peek (facts-http-gateway §5.3).
const handshakeTimeout = 10 * time.Second

// front is what tls.mode puts in front of the composition root's handler: the
// listener http.Server serves, the TURN relay when turn.enabled, the ACME
// state in the direct-TLS modes and the in-process SFU when livekit.enabled.
// close releases all of it; it runs after the HTTP drain.
type front struct {
	http    net.Listener
	closers []func()
}

func (f *front) close() {
	for i := len(f.closers) - 1; i >= 0; i-- {
		f.closers[i]()
	}
	f.closers = nil
}

// frontDeps is what openFront reads and reports to.
type frontDeps struct {
	cfg     *config.Config
	log     *slog.Logger
	health  *obs.Health
	metrics *obs.Metrics
	stdout  io.Writer
}

// openFront binds the listeners tls.mode chooses and starts what sits behind
// them. runCtx bounds the background ACME issuance.
//
//   - behind_proxy: only server.plain_listen. certmagic is not constructed;
//     the proxy terminates TLS and X-Forwarded-For is read against
//     server.trusted_proxy_cidrs. TURN, when turn.enabled, is its own plain
//     TCP listener on turn.listen — never 443, where the proxy routes only
//     HTTP — optionally behind a PROXY protocol header from a trusted proxy.
//   - acme_tls_alpn, acme_dns, acme_ip: server.listen through the 443 demux,
//     which terminates TLS with certmagic's certificate and hands STUN to the
//     TURN relay and everything else to HTTP. The certificate is obtained in
//     the background once the listener is up, because TLS-ALPN-01 is answered
//     on it; the tls readiness gate is red until one is held.
//
// The livekit and tls gates are touched only when their subsystem is
// configured here; otherwise they keep what the composition root set.
func openFront(ctx, runCtx context.Context, d frontDeps) (*front, error) {
	f := &front{}
	err := startSFU(ctx, d, f)
	if err == nil {
		if d.cfg.BehindProxy() {
			err = openBehindProxy(ctx, d, f)
		} else {
			err = openDirectTLS(ctx, runCtx, d, f)
		}
	}
	if err != nil {
		// Whatever did start is released: a half-open front would leave the SFU's
		// ports or the demux's listener bound past a failed start.
		f.close()
		return nil, err
	}
	return f, nil
}

// listen binds addr and, when it asked the kernel for a port, prints which
// one it got: there is nowhere else an operator (or a test) can read it.
func listen(ctx context.Context, d frontDeps, what, addr string) (net.Listener, error) {
	ln, err := (&net.ListenConfig{}).Listen(ctx, "tcp", addr)
	if err != nil {
		return nil, fmt.Errorf("serve: listen %s %s: %w: %w", what, addr, err, exit.Unavailable)
	}
	if strings.HasSuffix(addr, ":0") {
		fmt.Fprintln(d.stdout, ln.Addr().String())
	}
	return ln, nil
}

func openBehindProxy(ctx context.Context, d frontDeps, f *front) error {
	ln, err := listen(ctx, d, "server.plain_listen", d.cfg.Server.PlainListen)
	if err != nil {
		return err
	}
	f.http = ln
	f.closers = append(f.closers, func() { _ = ln.Close() })
	if !d.cfg.TURN.Enabled {
		return nil
	}
	tln, err := (&net.ListenConfig{}).Listen(ctx, "tcp", d.cfg.TURN.Listen)
	if err != nil {
		return fmt.Errorf("serve: listen turn.listen %s: %w: %w", d.cfg.TURN.Listen, err, exit.Unavailable)
	}
	if d.cfg.TURN.ProxyProtocol {
		tln = proxyProtocolListener(tln, d.cfg.Server.TrustedProxyCIDRs)
	}
	return startTURN(d, f, tln)
}

// proxyProtocolListener requires a PROXY protocol header (v1 or v2) from a
// peer inside trusted and refuses every other peer: TURN is a byte stream with
// no X-Forwarded-For, so this header is the only way a relay behind a TCP proxy
// learns the client's address, and an untrusted peer must not be able to set
// it.
func proxyProtocolListener(ln net.Listener, trusted []netip.Prefix) net.Listener {
	return &proxyproto.Listener{
		Listener:          ln,
		ReadHeaderTimeout: handshakeTimeout,
		ConnPolicy: func(o proxyproto.ConnPolicyOptions) (proxyproto.Policy, error) {
			if ap, perr := netip.ParseAddrPort(o.Upstream.String()); perr == nil {
				for _, p := range trusted {
					if p.Contains(ap.Addr().Unmap()) {
						return proxyproto.REQUIRE, nil
					}
				}
			}
			return proxyproto.REJECT, nil
		},
	}
}

func openDirectTLS(ctx, runCtx context.Context, d frontDeps, f *front) error {
	domain := d.cfg.Instance.Domain
	if d.cfg.TLS.Mode == config.TLSModeACMEIP {
		domain = d.cfg.Instance.PublicIP.String()
	}
	domains := []string{domain}
	manageCtx, stopManage := context.WithCancel(runCtx)
	f.closers = append(f.closers, stopManage)
	tl, tlsCfg, err := server.BuildTLS(manageCtx, d.cfg.TLS, domains)
	if err != nil {
		return fmt.Errorf("serve: %w: %w", err, exit.Config)
	}
	f.closers = append(f.closers, tl.Close)
	tl.SetHooks(func(msg string) {
		// certmagic keeps serving the last certificate; this is the alert.
		d.metrics.CertRenewalFailures.Inc()
		d.log.Error("ACME issuance or renewal failed; the existing certificate, if any, is still served",
			"name", domain, "err", msg)
	}, func() {
		d.log.Info("certificate obtained", "name", domain)
	})

	raw, err := listen(ctx, d, "server.listen", d.cfg.Server.Listen)
	if err != nil {
		return err
	}
	dm := server.NewDemux(raw, tlsCfg, handshakeTimeout)
	go dm.Serve()
	f.closers = append(f.closers, func() { _ = dm.Close() })
	f.http = dm.HTTP()
	if d.cfg.TURN.Enabled {
		if err := startTURN(d, f, dm.TURN()); err != nil {
			return err
		}
	} else {
		// No relay: the demux closes every STUN connection it would route here.
		_ = dm.TURN().Close()
	}

	gate := d.health.Gate("tls")
	gate.Set(false, "obtaining a certificate for "+domain)
	go manageCertificate(manageCtx, tl, domains, gate, d.log)
	return nil
}

// manageCertificate runs the ACME round trip until a certificate is held,
// retrying with a back-off: a first start whose DNS has not propagated yet, or
// whose port 443 is not forwarded yet, must not need a restart once it is.
// From then on certmagic's cache renews in the background, and a failed
// renewal keeps the gate green — the existing certificate is still valid, and
// the alert is the failure hook, not taking the instance out of rotation.
func manageCertificate(ctx context.Context, tl *server.TLS, domains []string, gate *obs.Gate, log *slog.Logger) {
	backoff := time.Minute
	for {
		err := tl.Manage(ctx, domains)
		if err == nil {
			gate.Set(true, "certificate held for "+domains[0])
			return
		}
		if ctx.Err() != nil {
			return
		}
		gate.Set(false, "no certificate for "+domains[0]+" yet: "+err.Error())
		log.Error("obtaining a certificate failed; retrying", "name", domains[0], "err", err, "retry_in", backoff)
		t := time.NewTimer(backoff)
		select {
		case <-ctx.Done():
			t.Stop()
			return
		case <-t.C:
		}
		backoff = min(2*backoff, time.Hour)
	}
}

func startTURN(d frontDeps, f *front, ln net.Listener) error {
	t, err := server.StartTURN(d.cfg.TURN, ln, clock.System(), d.log)
	if err != nil {
		_ = ln.Close()
		return fmt.Errorf("serve: %w: %w", err, exit.Config)
	}
	f.closers = append(f.closers, func() { _ = t.Close() })
	return nil
}

// startSFU runs LiveKit v1.13.7 in this process through internal/sfu, on
// livekit.bind_address, when livekit.enabled. Its readiness gate is red until
// the SFU accepts connections. A failure stops serve: an instance configured
// for voice that silently has none is worse than one that says why it did not
// start.
func startSFU(ctx context.Context, d frontDeps, f *front) error {
	lk := d.cfg.LiveKit
	if !lk.Enabled {
		return nil
	}
	if lk.Mode != "in_process" {
		return fmt.Errorf("serve: livekit.mode %q is not supported; the one mode is in_process: %w", lk.Mode, exit.Config)
	}
	gate := d.health.Gate("livekit")
	gate.Set(false, "starting the in-process SFU")
	body, err := os.ReadFile(lk.APISecretFile)
	if err != nil {
		return fmt.Errorf("serve: livekit.api_secret_file: %w: %w", err, exit.Config)
	}
	nodeIP := lk.NodeIP
	if nodeIP == "" {
		nodeIP = "127.0.0.1"
	}
	loopback := false
	if a, err := netip.ParseAddr(nodeIP); err == nil {
		loopback = a.IsLoopback()
	}
	s, err := sfu.Start(ctx, sfu.Config{
		Port:        lk.Port,
		BindAddress: lk.BindAddress,
		NodeIP:      nodeIP,
		UDPPort:     lk.UDPPort,
		TCPPort:     lk.TCPPort,
		// On a loopback-only node LiveKit gathers no host candidate without it
		// (internal/sfu's package comment).
		EnableLoopbackCandidate: loopback,
		APIKey:                  lk.APIKey,
		APISecret:               strings.TrimSpace(string(body)),
	})
	if err != nil {
		gate.Set(false, err.Error())
		return fmt.Errorf("serve: %w: %w", err, exit.Unavailable)
	}
	gate.Set(true, "in-process SFU on "+s.URL())
	f.closers = append(f.closers, func() {
		stopCtx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
		defer cancel()
		if err := s.Stop(stopCtx); err != nil && !errors.Is(err, context.Canceled) {
			d.log.Warn("stopping the SFU", "err", err)
		}
	})
	return nil
}
