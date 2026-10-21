package main

// UP8 (R-UP11): TURN moves into `dillad media`. Who binds what, media.json's "turn", the public
// mode's relay, `--idle`'s recent mints and the doctor's owner.

import (
	"bytes"
	"context"
	"crypto/tls"
	"crypto/x509"
	"errors"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/pion/turn/v5"

	"github.com/jonasthim/dilla/internal/clock"
	"github.com/jonasthim/dilla/internal/config"
	"github.com/jonasthim/dilla/internal/exit"
	"github.com/jonasthim/dilla/internal/id"
	"github.com/jonasthim/dilla/internal/obs"
	"github.com/jonasthim/dilla/internal/ops"
	"github.com/jonasthim/dilla/internal/server"
	"github.com/jonasthim/dilla/internal/sfu"
)

// noMints is an API that minted no call token within 60 s.
func noMints(context.Context) (int, error) { return 0, nil }

// writeMedia writes a media.json of this process (MainPID stubbed to it).
func writeMedia(t *testing.T, dir string, level int, caps ...string) {
	t.Helper()
	stubMediaMainPID(t, os.Getpid(), nil)
	if caps == nil {
		caps = []string{}
	}
	if err := writeMediaState(dir, mediaState{Version: Version, MediaLevel: level, Capabilities: caps, PID: os.Getpid(), Started: time.Now()}); err != nil {
		t.Fatal(err)
	}
}

// R-UP4: `--idle` is busy while a call token was minted within 60 s, and while api.sock does not
// answer; an empty SFU with an API that minted nothing is idle.
func TestMediaIdleAsksTheAPIForRecentMints(t *testing.T) {
	empty := fakeRoomInfos{}
	run := func(m recentMints) (string, error) {
		var stderr bytes.Buffer
		err := mediaIdle(t.Context(), empty, m, time.Now(), &bytes.Buffer{}, &stderr, time.Second)
		return stderr.String(), err
	}
	if _, err := run(noMints); err != nil {
		t.Fatalf("no mints: %v, want idle", err)
	}
	if stderr, err := run(func(context.Context) (int, error) { return 2, nil }); !errors.Is(err, exit.Fail) || !strings.Contains(stderr, "2 call tokens") {
		t.Fatalf("two recent mints: %v %q, want busy (exit 1)", err, stderr)
	}
	if stderr, err := run(func(context.Context) (int, error) { return 0, errors.New("connection refused") }); !errors.Is(err, exit.Fail) ||
		!strings.Contains(stderr, "did not answer") {
		t.Fatalf("an API that does not answer: %v %q, want busy (exit 1)", err, stderr)
	}

	// Over the real socket: api.sock absent is busy; served with a count, the count decides.
	dir := shortSocketDir(t)
	if _, err := run(apiRecentMints(dir)); !errors.Is(err, exit.Fail) {
		t.Fatalf("with no api.sock: %v, want busy", err)
	}
	count := 0
	ln, err := server.ListenControl(t.Context(), server.ControlSocketPath(dir, server.APISocketName), nil)
	if err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /media/recent-mints", func(w http.ResponseWriter, _ *http.Request) {
		server.WriteControlJSON(w, map[string]int{"count": count, "window_ms": 60_000})
	})
	defer server.ServeControl(ln, mux, nil)()
	if _, err := run(apiRecentMints(dir)); err != nil {
		t.Fatalf("api.sock answering 0: %v, want idle", err)
	}
	count = 1
	if _, err := run(apiRecentMints(dir)); !errors.Is(err, exit.Fail) {
		t.Fatalf("api.sock answering 1: %v, want busy", err)
	}
}

// sidecarTURNConfig is a behind_proxy sidecar configuration with TURN on turn.listen.
func sidecarTURNConfig(t *testing.T) *config.Config {
	t.Helper()
	cfg := sidecarConfig(t)
	cfg.TLS.Mode = config.TLSModeBehindProxy
	cfg.TURN.Enabled, cfg.TURN.Listen = true, freePort(t)
	cfg.Server.PlainListen = "127.0.0.1:0"
	return cfg
}

// R-UP11: serve binds turn.listen only while dilla-media's valid media.json lacks "turn" (or the
// SFU is in serve itself); a media.json that lists it means dilla-media holds the port. A stale
// file counts as absent. During the handoff — a TURN-capable level whose bind is pending — serve
// waits for the bind before it decides.
func TestServeBindsTURNListenOnlyWhenDillaMediaDoesNot(t *testing.T) {
	log := slog.New(slog.DiscardHandler)
	prevWait := turnHandoffWait
	turnHandoffWait = 2 * time.Second
	t.Cleanup(func() { turnHandoffWait = prevWait })

	t.Run("no media.json (a web3.11 SFU) binds as before", func(t *testing.T) {
		cfg := sidecarTURNConfig(t)
		stubMediaMainPID(t, os.Getpid(), nil)
		if p := planTURN(t.Context(), cfg, log); !p.listen || p.media || p.demux {
			t.Fatalf("plan = %+v, want this process on turn.listen", p)
		}
	})
	t.Run("a web3.11 media.json (level 1, no turn) binds at once", func(t *testing.T) {
		cfg := sidecarTURNConfig(t)
		writeMedia(t, cfg.Instance.DataDir, 1)
		start := time.Now()
		if p := planTURN(t.Context(), cfg, log); !p.listen {
			t.Fatalf("plan = %+v, want turn.listen", p)
		}
		if waited := time.Since(start); waited > time.Second {
			t.Fatalf("serve waited %v for a level that never serves TURN", waited)
		}
	})
	t.Run("a valid media.json with turn binds nothing", func(t *testing.T) {
		cfg := sidecarTURNConfig(t)
		writeMedia(t, cfg.Instance.DataDir, sfu.MediaLevel, turnCapability)
		if p := planTURN(t.Context(), cfg, log); !p.media || p.listen || p.demux {
			t.Fatalf("plan = %+v, want dilla-media's relay only", p)
		}
		// And openFront binds nothing on turn.listen.
		fr, err := openFront(t.Context(), t.Context(), frontDeps{cfg: cfg, log: log, health: obs.NewHealth(clock.System()),
			metrics: newMetrics(), stdout: &bytes.Buffer{}, turn: &turnPlan{media: true}})
		if err != nil {
			t.Fatal(err)
		}
		defer fr.close()
		if c, err := (&net.Dialer{Timeout: time.Second}).DialContext(t.Context(), "tcp", cfg.TURN.Listen); err == nil {
			_ = c.Close()
			t.Fatal("serve bound turn.listen although dilla-media serves TURN")
		}
	})
	t.Run("a stale media.json with turn counts as absent", func(t *testing.T) {
		cfg := sidecarTURNConfig(t)
		writeMedia(t, cfg.Instance.DataDir, sfu.MediaLevel, turnCapability)
		stubMediaMainPID(t, os.Getpid()+1, nil)
		if p := planTURN(t.Context(), cfg, log); !p.listen {
			t.Fatalf("plan = %+v, want turn.listen", p)
		}
	})
	t.Run("the SFU in serve binds whatever a media.json says", func(t *testing.T) {
		cfg := sidecarTURNConfig(t)
		writeMedia(t, cfg.Instance.DataDir, sfu.MediaLevel, turnCapability)
		cfg.LiveKit.Mode = "in_process"
		if p := planTURN(t.Context(), cfg, log); !p.listen {
			t.Fatalf("plan = %+v, want turn.listen", p)
		}
	})
	t.Run("the handoff: serve waits for a pending bind", func(t *testing.T) {
		cfg := sidecarTURNConfig(t)
		writeMedia(t, cfg.Instance.DataDir, sfu.MediaLevel)
		go func() {
			time.Sleep(400 * time.Millisecond)
			_ = writeMediaState(cfg.Instance.DataDir, mediaState{Version: Version, MediaLevel: sfu.MediaLevel,
				Capabilities: []string{turnCapability}, PID: os.Getpid(), Started: time.Now()})
		}()
		if p := planTURN(t.Context(), cfg, log); !p.media {
			t.Fatalf("plan = %+v, want dilla-media's relay once it bound", p)
		}
	})
	t.Run("the handoff: a bind that never comes leaves turn.listen to serve", func(t *testing.T) {
		cfg := sidecarTURNConfig(t)
		writeMedia(t, cfg.Instance.DataDir, sfu.MediaLevel)
		start := time.Now()
		if p := planTURN(t.Context(), cfg, log); !p.listen {
			t.Fatalf("plan = %+v, want turn.listen", p)
		}
		if waited := time.Since(start); waited < turnHandoffWait {
			t.Fatalf("serve gave up after %v, before turnHandoffWait", waited)
		}
	})
}

// publicConfig is an acme_tls_alpn configuration whose certificate is already in storage, with a
// sidecar SFU on loopback; pool trusts its certificate.
func publicConfig(t *testing.T) (*config.Config, *x509.CertPool) {
	t.Helper()
	ca := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, "no", http.StatusInternalServerError)
	}))
	t.Cleanup(ca.Close)
	c, err := config.Load(bootstrapServeConfig(t))
	if err != nil {
		t.Fatal(err)
	}
	c.TLS.Mode = config.TLSModeACMETLSALPN
	c.TLS.CA = ca.URL + "/directory"
	c.Server.Listen = "127.0.0.1:0"
	c.Server.TrustedProxyCIDRs = nil
	c.TURN.Enabled, c.TURN.Listen, c.TURN.RelayIP = true, "", "127.0.0.1"
	c.LiveKit.Enabled, c.LiveKit.Mode, c.LiveKit.NodeIP = true, "sidecar", "127.0.0.1"
	pool := seedCertificate(t, c.TLS.StorageDir, c.TLS.CA, c.Instance.Domain)
	return c, pool
}

// allocateOverTLS allocates a relay at addr over TLS with a fresh credential.
func allocateOverTLS(t *testing.T, c *config.Config, pool *x509.CertPool, addr string) error {
	t.Helper()
	secret, err := ops.ReadSecret(c.TURN.SharedSecretFile)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	conn, err := (&tls.Dialer{Config: &tls.Config{RootCAs: pool, ServerName: c.Instance.Domain, MinVersion: tls.VersionTLS12}}).
		DialContext(ctx, "tcp", addr)
	if err != nil {
		return err
	}
	_ = conn.SetDeadline(time.Now().Add(5 * time.Second))
	user, pass := server.TURNCredential(secret, id.New(), time.Hour, time.Now())
	tc, err := turn.NewClient(&turn.ClientConfig{TURNServerAddr: addr, Username: user, Password: pass, Realm: c.TURN.Realm,
		Conn: turn.NewSTUNConn(conn), RTO: 500 * time.Millisecond})
	if err != nil {
		_ = conn.Close()
		return err
	}
	defer tc.Close()
	if err := tc.Listen(); err != nil {
		return err
	}
	relay, err := tc.Allocate()
	if err != nil {
		return err
	}
	return relay.Close()
}

// openPublicFront opens serve's front for c as planTURN decides it.
func openPublicFront(t *testing.T, c *config.Config) (*front, turnPlan) {
	t.Helper()
	log := slog.New(slog.DiscardHandler)
	plan := planTURN(t.Context(), c, log)
	fr, err := openFront(t.Context(), t.Context(), frontDeps{cfg: c, log: log, health: obs.NewHealth(clock.System()),
		metrics: newMetrics(), stdout: &bytes.Buffer{}, relay: server.NewRelayRevocations(2*time.Hour, clock.System()), turn: &plan})
	if err != nil {
		t.Fatalf("openFront: %v", err)
	}
	t.Cleanup(fr.close)
	return fr, plan
}

// R-UP11, public mode: without the opt-in, serve keeps its 443 demux relay even when dilla-media's
// media.json lists turn — public mode never loses TURN — and a relayed allocation over 443 works.
// With the opt-in turn.listen, serve binds no 443 relay (the demux closes STUN), and binds
// turn.listen itself only while dilla-media does not serve it.
func TestPublicModeKeepsARelay(t *testing.T) {
	t.Run("without the opt-in the 443 relay runs whatever media.json says", func(t *testing.T) {
		c, pool := publicConfig(t)
		writeMedia(t, c.Instance.DataDir, sfu.MediaLevel, turnCapability)
		fr, plan := openPublicFront(t, c)
		if !plan.demux || plan.media || plan.listen {
			t.Fatalf("plan = %+v, want the 443 demux relay", plan)
		}
		if err := allocateOverTLS(t, c, pool, fr.http.Addr().String()); err != nil {
			t.Fatalf("a relayed allocation over 443 failed: %v", err)
		}
	})
	t.Run("with the opt-in and dilla-media serving TURN there is no 443 relay", func(t *testing.T) {
		c, pool := publicConfig(t)
		c.TURN.Listen = freePort(t)
		writeMedia(t, c.Instance.DataDir, sfu.MediaLevel, turnCapability)
		fr, plan := openPublicFront(t, c)
		if !plan.media || plan.demux || plan.listen {
			t.Fatalf("plan = %+v, want dilla-media's relay only", plan)
		}
		if err := allocateOverTLS(t, c, pool, fr.http.Addr().String()); err == nil {
			t.Fatal("an allocation over 443 succeeded beside the opt-in turn.listen: two relays")
		}
		if conn, err := (&net.Dialer{Timeout: time.Second}).DialContext(t.Context(), "tcp", c.TURN.Listen); err == nil {
			_ = conn.Close()
			t.Fatal("serve bound turn.listen although dilla-media serves it")
		}
	})
	t.Run("with the opt-in and a web3.11 SFU serve takes turn.listen over TLS", func(t *testing.T) {
		c, pool := publicConfig(t)
		c.TURN.Listen = freePort(t)
		writeMedia(t, c.Instance.DataDir, 1)
		fr, plan := openPublicFront(t, c)
		if !plan.listen || plan.demux {
			t.Fatalf("plan = %+v, want turn.listen", plan)
		}
		if err := allocateOverTLS(t, c, pool, c.TURN.Listen); err != nil {
			t.Fatalf("an allocation over TLS on turn.listen failed: %v", err)
		}
		if err := allocateOverTLS(t, c, pool, fr.http.Addr().String()); err == nil {
			t.Fatal("an allocation over 443 succeeded beside turn.listen: two relays")
		}
	})
}

// R-UP5, R-UP11: dilla-media lists "turn" in media.json only once its relay is bound. With the
// port held by another listener (the API, during the handoff) it is ready without "turn", retries
// the bind, and rewrites media.json with "turn" once the port is free; its relay then allocates,
// and media.sock reports it serving.
func TestDillaMediaListsTurnOnlyAfterItsBindSucceeded(t *testing.T) {
	prev := mediaTURNRetry
	mediaTURNRetry = 100 * time.Millisecond
	t.Cleanup(func() { mediaTURNRetry = prev })
	stubMediaMainPID(t, os.Getpid(), nil)
	fd := sfuDeps(t, func(lk *config.LiveKit) { lk.Mode = "sidecar"; lk.NodeIP = "127.0.0.1" })
	cfg := fd.cfg
	cfg.Instance.DataDir = shortSocketDir(t)
	cfg.TLS.Mode = config.TLSModeBehindProxy
	cfg.Server.TrustedProxyCIDRs = []netip.Prefix{netip.MustParsePrefix("127.0.0.1/32")}
	secretFile := filepath.Join(t.TempDir(), "turn.secret")
	if err := os.WriteFile(secretFile, []byte(strings.Repeat("t", 32)), 0o600); err != nil {
		t.Fatal(err)
	}
	cfg.TURN.Enabled, cfg.TURN.SharedSecretFile, cfg.TURN.RelayIP, cfg.TURN.Realm = true, secretFile, "127.0.0.1", "chat.example"
	held, err := (&net.ListenConfig{}).Listen(t.Context(), "tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	cfg.TURN.Listen = held.Addr().String()

	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- serveMedia(ctx, cfg, &bytes.Buffer{}, &bytes.Buffer{}) }()
	var st mediaState
	deadline := time.Now().Add(30 * time.Second)
	for {
		if _, err = readMediaState(t.Context(), cfg.Instance.DataDir); err == nil {
			break
		}
		select {
		case err := <-done:
			t.Fatalf("media exited: %v", err)
		default:
		}
		if time.Now().After(deadline) {
			t.Fatal("media.json never appeared")
		}
		time.Sleep(50 * time.Millisecond)
	}
	mediaSock := server.ControlClient(server.ControlSocketPath(cfg.Instance.DataDir, server.MediaSocketName))
	time.Sleep(5 * mediaTURNRetry) // several retries against the held port
	if st, err = readMediaState(t.Context(), cfg.Instance.DataDir); err != nil || slices.Contains(st.Capabilities, turnCapability) {
		t.Fatalf("media.json with the port held = %+v (%v), want no turn", st, err)
	}
	if rs, err := server.FetchRelayState(t.Context(), mediaSock); err != nil || rs.Serving || rs.Owner != "media" {
		t.Fatalf("media.sock with the port held = %+v (%v), want owner media, not serving", rs, err)
	}

	_ = held.Close() // the API lets go
	for deadline = time.Now().Add(10 * time.Second); ; {
		st, err = readMediaState(t.Context(), cfg.Instance.DataDir)
		if err == nil && slices.Contains(st.Capabilities, turnCapability) {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("media.json never listed turn after the port was freed: %+v %v", st, err)
		}
		time.Sleep(50 * time.Millisecond)
	}
	secret, _ := ops.ReadSecret(secretFile)
	if leg := ops.TURNLeg(t.Context(), cfg.TURN.Listen, cfg.TURN.Realm, secret); leg.Status != ops.Green {
		t.Fatalf("dilla-media's relay: %+v", leg)
	}
	if rs, err := server.FetchRelayState(t.Context(), mediaSock); err != nil || !rs.Serving {
		t.Fatalf("media.sock once bound = %+v (%v), want serving", rs, err)
	}
	if p := planTURN(t.Context(), cfg, slog.New(slog.DiscardHandler)); !p.media {
		t.Fatalf("serve's plan beside this dilla-media = %+v, want dilla-media's relay", p)
	}
	cancel()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("media shutdown: %v", err)
		}
	case <-time.After(25 * time.Second):
		t.Fatal("media did not stop")
	}
	if _, err := os.Lstat(server.ControlSocketPath(cfg.Instance.DataDir, server.MediaSocketName)); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("media.sock after a clean stop: %v, want it removed", err)
	}
}

// The doctor's turn leg names the owner from the control sockets (or media.json and the
// configuration when they do not answer), and is red when both or neither serve TURN.
func TestTheDoctorNamesTheTURNOwner(t *testing.T) {
	serveState := func(t *testing.T, dir, sock string, st server.RelayState) {
		t.Helper()
		ln, err := server.ListenControl(t.Context(), server.ControlSocketPath(dir, sock), nil)
		if err != nil {
			t.Fatal(err)
		}
		mux := http.NewServeMux()
		mux.HandleFunc("GET /relay/state", func(w http.ResponseWriter, _ *http.Request) { server.WriteControlJSON(w, st) })
		t.Cleanup(server.ServeControl(ln, mux, nil))
	}
	cfgFor := func(t *testing.T) *config.Config {
		cfg := sidecarTURNConfig(t)
		cfg.Instance.DataDir = shortSocketDir(t)
		cfg.Doctor.TURNProbe = false // the owner is the point here
		return cfg
	}
	for _, tc := range []struct {
		name         string
		media, api   *bool // nil: that socket does not answer
		mediaJSON    bool  // media.json lists turn
		status       ops.Status
		says, absent string
	}{
		{"dilla-media serves", ptr(true), ptr(false), true, ops.Green, "served by dilla-media", ""},
		{"the API serves", ptr(false), ptr(true), false, ops.Green, "served by the API", ""},
		{"both serve", ptr(true), ptr(true), true, ops.Red, "both dilla-media and the API", ""},
		{"neither serves", ptr(false), ptr(false), false, ops.Red, "neither process", ""},
		{"no sockets, media.json lists turn", nil, nil, true, ops.Green, "served by dilla-media", "did not answer; media.json says turn=false"},
		{"no sockets, no turn in media.json", nil, nil, false, ops.Green, "served by the API", ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			cfg := cfgFor(t)
			if tc.mediaJSON {
				writeMedia(t, cfg.Instance.DataDir, sfu.MediaLevel, turnCapability)
			} else {
				writeMedia(t, cfg.Instance.DataDir, sfu.MediaLevel)
			}
			if tc.media != nil {
				serveState(t, cfg.Instance.DataDir, server.MediaSocketName, server.RelayState{Owner: "media", Serving: *tc.media})
			}
			if tc.api != nil {
				serveState(t, cfg.Instance.DataDir, server.APISocketName, server.RelayState{Owner: "api", Serving: *tc.api})
			}
			leg := doctorTURNLeg(t.Context(), cfg)
			if leg.Status != tc.status || !strings.Contains(leg.Detail, tc.says) || (tc.absent != "" && strings.Contains(leg.Detail, tc.absent)) {
				t.Fatalf("leg = %v %q, want %v naming %q", leg.Status, leg.Detail, tc.status, tc.says)
			}
		})
	}
}

func ptr[T any](v T) *T { return &v }
