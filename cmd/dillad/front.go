package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/netip"
	"os"
	"strings"
	"time"

	"github.com/livekit/protocol/livekit"
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
// listener http.Server serves, the TURN relay when turn.enabled and the ACME
// state in the direct-TLS modes. close releases all of it; it runs after the
// HTTP drain. The in-process SFU is started before the composition root
// (startSFU), because the call routes and /rtc are built over it.
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
// The tls gate is touched only in the direct-TLS modes; otherwise it keeps
// what the composition root set.
func openFront(ctx, runCtx context.Context, d frontDeps) (*front, error) {
	f := &front{}
	var err error
	if d.cfg.BehindProxy() {
		err = openBehindProxy(ctx, d, f)
	} else {
		err = openDirectTLS(ctx, runCtx, d, f)
	}
	if err != nil {
		// Whatever did start is released: a half-open front would leave the TURN
		// relay or the demux's listener bound past a failed start.
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

// turnPeers is the co-located SFU's media addresses, the only peers the relay admits (C9):
// livekit.node_ip, or loopback when it is unset, and, with livekit.advertise_internal_ip, the host
// candidates LiveKit offers beside it — this host's own unicast interface addresses (link-local and,
// unless the node itself is loopback, loopback ones excluded, as LiveKit excludes them). With LiveKit
// off there is no SFU and the relay admits no peer.
func turnPeers(cfg *config.Config, interfaceAddrs func() ([]net.Addr, error)) ([]netip.Addr, error) {
	lk := cfg.LiveKit
	if !lk.Enabled {
		return nil, nil
	}
	sc := sfuConfig(lk, "")
	var peers []netip.Addr
	seen := map[netip.Addr]bool{}
	add := func(a netip.Addr) {
		if a = a.Unmap(); a.IsValid() && !seen[a] {
			seen[a] = true
			peers = append(peers, a)
		}
	}
	node, err := netip.ParseAddr(sc.NodeIP)
	if err != nil {
		return nil, fmt.Errorf("livekit.node_ip %q is not an IP address: %w", sc.NodeIP, err)
	}
	add(node)
	if !lk.AdvertiseInternalIP {
		return peers, nil
	}
	addrs, err := interfaceAddrs()
	if err != nil {
		return nil, fmt.Errorf("list the interface addresses LiveKit advertises: %w", err)
	}
	for _, a := range addrs {
		ipn, ok := a.(*net.IPNet)
		if !ok {
			continue
		}
		ip, ok := netip.AddrFromSlice(ipn.IP)
		if !ok || ip.IsLinkLocalUnicast() || (ip.IsLoopback() && !sc.EnableLoopbackCandidate) {
			continue
		}
		add(ip)
	}
	return peers, nil
}

// turnStartError is serve's exit status for a relay that did not start: 78 (exit.Config, which the
// unit's RestartPreventExitStatus leaves stopped) only when dilla.toml is at fault, and 69
// (exit.Unavailable, restarted) for the host's network — a sandbox that blocks netlink, a bind.
func turnStartError(err error) error {
	if server.IsTURNConfigError(err) {
		return fmt.Errorf("serve: %w: %w", err, exit.Config)
	}
	return fmt.Errorf("serve: %w: %w", err, exit.Unavailable)
}

func startTURN(d frontDeps, f *front, ln net.Listener) error {
	peers, err := turnPeers(d.cfg, net.InterfaceAddrs)
	if err != nil {
		_ = ln.Close()
		return fmt.Errorf("serve: turn: %w: %w", err, exit.Unavailable)
	}
	t, err := server.StartTURN(d.cfg.TURN, ln, peers, clock.System(), d.log)
	if err != nil {
		_ = ln.Close()
		return turnStartError(err)
	}
	f.closers = append(f.closers, func() { _ = t.Close() })
	return nil
}

// sfuConfig maps [livekit] onto the SFU's config: every key config.Validate accepts reaches LiveKit
// (livekit.max_voice_participants as the room cap) or the call routes (livekit.max_publishers is
// the publisher lease's, callsConfig), and the reserved ones Validate refuses (extra_config_file,
// use_external_ip) have nowhere to go. An unset node_ip is loopback, which needs the loopback
// candidate. room.auto_create is false (DEV-44, MD-16): the call route opens each room with
// CreateRoom before it mints a token for it.
func sfuConfig(lk config.LiveKit, secret string) sfu.Config {
	nodeIP := lk.NodeIP
	if nodeIP == "" {
		nodeIP = "127.0.0.1"
	}
	loopback := false
	if a, err := netip.ParseAddr(nodeIP); err == nil {
		loopback = a.IsLoopback()
	}
	return sfu.Config{
		Port:        lk.Port,
		BindAddress: lk.BindAddress,
		NodeIP:      nodeIP,
		UDPPort:     lk.UDPPort,
		TCPPort:     lk.TCPPort,
		// On a loopback-only node LiveKit gathers no host candidate without it
		// (internal/sfu's package comment).
		EnableLoopbackCandidate: loopback,
		APIKey:                  lk.APIKey,
		APISecret:               strings.TrimSpace(secret),
		AdvertiseInternalIP:     lk.AdvertiseInternalIP,
		STUNServers:             lk.STUNServers,
		MaxParticipants:         uint32(max(lk.MaxVoiceParticipants, 0)), //nolint:gosec // clamped at 0
		AutoCreate:              false,
		EmptyTimeout:            300,
		DepartureTimeout:        20,
		VP9:                     lk.VP9,
		WebhookURL:              webhookURL(lk.WebhookListen),
		LimitNumTracks:          int32(lk.LimitNumTracks),     //nolint:gosec // Validate bounds it to 0..MaxInt32
		LimitBytesPerSec:        float32(lk.LimitBytesPerSec), // LiveKit's config type
		IPsExcludes:             lk.IPsExcludes,
	}
}

func webhookURL(listen string) string {
	if listen == "" {
		return ""
	}
	return "http://" + listen + sfu.WebhookPath
}

// listenWebhook binds livekit.webhook_listen before the SFU starts, when LiveKit is enabled, and
// writes the bound address back into the config: sfuConfig renders LiveKit's webhook URL from it, so
// a port 0 (tests) reaches LiveKit as the port the kernel chose. serveWebhook serves the listener
// once the composition root exists; until then LiveKit's POSTs wait in the accept queue.
func listenWebhook(ctx context.Context, d frontDeps) (net.Listener, error) {
	lk := d.cfg.LiveKit
	if !lk.Enabled || lk.WebhookListen == "" {
		return nil, nil
	}
	ln, err := listen(ctx, d, "livekit.webhook_listen", lk.WebhookListen)
	if err != nil {
		return nil, err
	}
	d.cfg.LiveKit.WebhookListen = ln.Addr().String()
	return ln, nil
}

// serveWebhook serves exactly POST /livekit/webhook on ln (SP-21): sfu.NewWebhookHandler verifies
// under the SFU's own key and hands each event to sink on its worker. The returned stop shuts the
// listener down and drains the worker. A nil ln (LiveKit off) serves nothing.
func serveWebhook(d frontDeps, ln net.Listener, sink func(context.Context, *livekit.WebhookEvent)) (func(), error) {
	if ln == nil {
		return func() {}, nil
	}
	body, err := os.ReadFile(d.cfg.LiveKit.APISecretFile)
	if err != nil {
		_ = ln.Close()
		return nil, fmt.Errorf("serve: livekit.api_secret_file: %w: %w", err, exit.Config)
	}
	h := sfu.NewWebhookHandler(d.cfg.LiveKit.APIKey, strings.TrimSpace(string(body)), sink, d.log)
	mux := http.NewServeMux()
	mux.Handle("POST "+sfu.WebhookPath, h)
	srv := &http.Server{Handler: mux, ReadHeaderTimeout: handshakeTimeout}
	go func() {
		if err := srv.Serve(ln); err != nil && !errors.Is(err, http.ErrServerClosed) {
			d.log.Error("the LiveKit webhook listener stopped", "err", err)
		}
	}()
	return func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = srv.Shutdown(ctx)
		if c, ok := h.(io.Closer); ok {
			_ = c.Close()
		}
	}, nil
}

// watchSFU reports a post-boot SFU exit and marks readiness red.
func watchSFU(ctx context.Context, done <-chan error, gate *obs.Gate, log *slog.Logger) <-chan error {
	out := make(chan error, 1)
	go func() {
		defer close(out)
		select {
		case err := <-done:
			gate.Set(false, "the in-process SFU exited: "+err.Error())
			log.Error("the in-process SFU exited; dillad exits for its supervisor to restart it", "err", err)
			out <- err
		case <-ctx.Done():
		}
	}()
	return out
}

// startSFU runs LiveKit v1.13.7 in this process through internal/sfu, on
// livekit.bind_address, when livekit.enabled. Its readiness gate is red until
// the SFU accepts connections. A failure stops serve: an instance configured
// for voice that silently has none is worse than one that says why it did not
// start.
//
// It runs before the composition root, which builds the call routes over the
// SFU's token mint and proxies /rtc to it, and returns the running SFU (nil
// when livekit.enabled is false) with the function that stops it; serve runs
// that after the HTTP drain.
func startSFU(ctx context.Context, d frontDeps) (*sfu.Server, func(), error) {
	lk := d.cfg.LiveKit
	if !lk.Enabled {
		return nil, func() {}, nil
	}
	if lk.Mode != "in_process" {
		return nil, nil, fmt.Errorf("serve: livekit.mode %q is not supported; the one mode is in_process: %w", lk.Mode, exit.Config)
	}
	gate := d.health.Gate("livekit")
	gate.Set(false, "starting the in-process SFU")
	body, err := os.ReadFile(lk.APISecretFile)
	if err != nil {
		return nil, nil, fmt.Errorf("serve: livekit.api_secret_file: %w: %w", err, exit.Config)
	}
	sc := sfuConfig(lk, string(body))
	sc.Log = d.log
	s, err := sfu.Start(ctx, sc)
	if err != nil {
		gate.Set(false, err.Error())
		return nil, nil, fmt.Errorf("serve: %w: %w", err, exit.Unavailable)
	}
	gate.Set(true, "in-process SFU on "+s.URL())
	return s, func() {
		stopCtx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
		defer cancel()
		if err := s.Stop(stopCtx); err != nil && !errors.Is(err, context.Canceled) {
			d.log.Warn("stopping the SFU", "err", err)
		}
	}, nil
}
