// Package dillad is the composition root: the one place that knows how the
// config, the store, the auth layer, the API handlers, the metrics and the
// health gates fit together. cmd/dillad's serve verb is a thin wrapper over it,
// and so is every end-to-end test, which is why the test path and the
// production path cannot drift.
package dillad

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"sync"
	"time"

	"github.com/jonasthim/dilla/internal/api"
	"github.com/jonasthim/dilla/internal/auth"
	"github.com/jonasthim/dilla/internal/ds"
	"github.com/jonasthim/dilla/internal/gateway"
	"github.com/jonasthim/dilla/internal/id"
	"github.com/jonasthim/dilla/internal/mlswasi"
	"github.com/jonasthim/dilla/internal/server"
	"github.com/jonasthim/dilla/internal/store"
)

type Server struct {
	o        Options
	mux      *server.Mux
	handler  http.Handler
	sessions *auth.Sessions
	httpSrv  *http.Server
	instance store.InstanceRow

	// Part 1b's three subsystems (task 27a). ownsWasm records that New compiled
	// the runtime itself, so Shutdown closes it; a runtime passed in through
	// Options.Wasm stays the caller's.
	wasm     *mlswasi.Runtime
	ownsWasm bool
	gw       *gateway.Gateway
	ds       *ds.DS

	// throttle and limiter are swept by the gateway's maintenance loop, whose stop function
	// Shutdown calls before it stops the gateway.
	throttle    *auth.Throttle
	limiter     *server.RateLimiter
	maintenance func()

	shutdownOnce sync.Once
	shutdownErr  error
}

// New builds the server. It reads the instance row once — the instance id is in
// every session signature preimage and the generation is in every response
// header, and neither changes without a restart or a restore.
func New(ctx context.Context, o Options) (*Server, error) {
	if err := o.validate(ctx); err != nil {
		return nil, err
	}
	instance, err := o.Repo.GetInstance(ctx)
	if err != nil {
		return nil, fmt.Errorf("dillad: read instance row (has `dillad init` run?): %w", err)
	}
	keys, err := instanceKeys(instance)
	if err != nil {
		return nil, err
	}
	// The generation goes into every 201 from POST /v1/devices/{device_id}/sessions
	// and into the X-Dilla-Generation header below; one source, so they agree.
	sessions := auth.NewSessions(o.Repo, o.Clock, o.Config.Auth.Session, instance.InstanceID, instance.Generation)
	limiter := server.NewRateLimiter(o.Config.Limits.Rate, o.Clock)
	hasher := auth.NewHasher(auth.ParamsFromConfig(o.Config.Auth.Password), o.Config.Limits.Rate.PasswordConcurrency)
	throttle := auth.NewThrottle(o.Config.Limits.Rate, o.Config.Auth.Lockout, o.Clock)

	// Passkeys is built only when `passkey` is one of auth.methods: go-webauthn
	// refuses a config with no relying-party origins, and an instance that
	// never configured one must start with the four ceremonies answering 501
	// rather than failing to start at all (internal/api.Deps.Passkeys).
	var passkeys *auth.Passkeys
	if slices.Contains(o.Config.Auth.Methods, "passkey") {
		passkeys, err = auth.NewPasskeys(auth.ConfigFromDilla(o.Config.Auth.WebAuthn), o.Repo, o.Clock)
		if err != nil {
			return nil, fmt.Errorf("dillad: passkeys: %w", err)
		}
	}

	deps := api.Deps{
		Repo: o.Repo, Clock: o.Clock, Log: o.Log, Limiter: limiter, Metrics: o.Metrics,
		Instance: instance, Domain: o.Config.Instance.Domain,
		Registration: o.Config.Registration, Config: o.Config,
		Sessions: sessions, Hasher: hasher, Throttle: throttle, Passkeys: passkeys,
		Assertions: api.NewAssertions(o.Clock, api.AssertionTTL),
	}
	// GET /v1/instance publishes the external-sender public key, derived from the seed the
	// delivery service signs with, so the two cannot disagree. An ed25519.PrivateKey is
	// seed || public, so its second half is the public key.
	deps.ExternalSenderPub = []byte(ed25519.NewKeyFromSeed(keys.ExternalSenderPriv[:])[ed25519.SeedSize:])
	// The pending path spends an enrolment assertion, and internal/auth cannot
	// import internal/api, so the store is handed over through the interface.
	sessions.Assertions = deps.Assertions
	if o.Config.Auth.OIDC.Enabled {
		secret, err := readSecretFile(o.Config.Auth.OIDC.ClientSecretFile)
		if err != nil {
			return nil, err
		}
		deps.OIDC = auth.NewOIDC(o.Config.Auth.OIDC, secret, o.Clock)
	}

	// The wasm runtime. One per process: it holds the compiled module and the
	// instance pool, and compiling the OpenMLS module twice is the single most
	// expensive thing this binary can do.
	wasm, ownsWasm := o.Wasm, false
	if wasm == nil {
		wasm, err = newWasmRuntime(ctx, o)
		if err != nil {
			return nil, err
		}
		ownsWasm = true
	}
	closeWasmOnError := func() {
		if ownsWasm {
			_ = wasm.Close(context.Background())
		}
	}

	// The gateway, then the delivery service: ds holds *gateway.Gateway, and
	// the gateway calls back into ds for ready's per-group digest and for
	// invariant 7's acknowledgement. gateway.Options takes both as plain
	// functions, so they close over `delivery`, which is assigned before New
	// returns and therefore before any connection can reach either callback.
	policy := policyFromConfig(o.Config)
	var delivery *ds.DS
	gw := gateway.New(gateway.Options{
		Store:   o.Repo,
		Clock:   o.Clock,
		Log:     o.Log,
		Metrics: o.Metrics,
		Auth:    sessions,
		Outstanding: func(ctx context.Context, groupID id.ID) uint64 {
			rows, err := delivery.Outstanding(ctx, groupID)
			if err != nil {
				return 0
			}
			return uint64(len(rows))
		},
		CommitAck: func(ctx context.Context, groupID, deviceID id.ID, round uint64) {
			_ = delivery.AckCommitNeeded(ctx, groupID, deviceID, round)
		},
		InstanceID:     instance.InstanceID,
		Generation:     instance.Generation,
		HeartbeatMS:    uint64(o.Config.Gateway.HeartbeatInterval.Value() / time.Millisecond), //nolint:gosec // G115: a non-negative duration in milliseconds
		IdleClose:      o.Config.Gateway.SessionIdleClose.Value(),
		ReadLimit:      o.Config.Gateway.ReadLimitBytes,
		MaxFrameBytes:  o.Config.MaxFrameBytes(),
		TrustedOrigins: o.Config.HTTP.TrustedOrigins,
		// Invariant 7's back-off window, advertised in hello (deviation B23).
		Backoff:       policy.Backoff,
		BackoffJitter: policy.BackoffJitter,
		// The inbound frame bucket: gateway.frame_burst frames a second, gateway.frame_burst_max
		// at once.
		FramesPerSecond: float64(o.Config.Gateway.FrameBurst),
		FrameBurst:      o.Config.Gateway.FrameBurstMax,
	})
	// Invariant 1's channel mode and the registration ACL read the channels, communities and
	// members tables (Plan 2 task 2; this replaced Plan 1's ds.PermissiveChannels, NV-B5). A
	// harness may inject its own source through Options.Channels.
	channels := o.Channels
	if channels == nil {
		channels = api.StructureChannels{Repo: o.Repo}
	}
	delivery, err = ds.New(ds.Options{
		Store:    o.Repo,
		Wasm:     wasm,
		Gateway:  gw,
		Clock:    o.Clock,
		Log:      o.Log,
		Metrics:  o.Metrics,
		Keys:     keys,
		Policy:   policy,
		Channels: channels,
		ACL:      o.ACL, // nil: ds.DenyUnlessMember (NV-B6)
		// The device lists are verified in the guest (NV-B8, deviation B32).
		DeviceLists: ds.NewDeviceLists(o.Repo, wasm),
	})
	if err != nil {
		closeWasmOnError()
		return nil, err
	}

	// Revoking a device closes its sockets in the same breath as its sessions
	// (protocol/02, "Device sessions", rule 6).
	closeDevice := func(device id.ID) {
		gw.CloseDevice(device, gateway.CloseSessionRevoked, "device revoked")
	}
	sessions.OnRevoke = closeDevice
	deps.CloseGateway = closeDevice
	// POST /v1/gateway/ticket mints from the gateway's own store; a second
	// store would mint tickets the upgrade has never heard of.
	deps.Tickets = gw.Tickets()

	mux := server.NewMux()
	api.Register(mux, deps)

	// The upgrade is HTTP/1.1 only: a WebSocket needs Hijacker, so this route
	// is never served over h2c (R19).
	mux.Handle("GET /gateway", gw.Handler())

	// Every Register method on *api.Groups is called exactly once (deviations
	// B29, B31): there is no api.KeyPackages, api.Welcomes or api.Heal type.
	//
	// MaxBody is left at zero, which is each handler group's own §5.3 cap (the
	// delivery service's 2 MiB, the small routes' 64 KiB): dilla.toml carries no
	// body-size key, and the plan's `o.Config.Limits.MaxBodyBytes` does not
	// exist (deviation B35).
	// Every delivery-service route is metered per device session from [limits.rate], on the
	// same limiter the unauthenticated routes use (its keys are class-prefixed).
	groups := &api.Groups{DS: delivery, Limiter: limiter}
	groups.Register(mux, sessions)          // rows 1-3
	groups.RegisterSequencer(mux, sessions) // rows 4-7, 19
	groups.RegisterRecovery(mux, sessions)  // rows 8-9
	groups.RegisterDirectory(mux, sessions) // rows 10, 12, 15-16
	groups.RegisterHeal(mux, sessions)      // rows 13-14
	(&api.Messages{
		DS:                 delivery,
		MaxCiphertextBytes: o.Config.Limits.MaxCiphertextBytes,
		Limiter:            limiter,
	}).Register(mux, sessions) // rows 11, 17, 18 and the cursor

	if err := delivery.Start(ctx); err != nil {
		closeWasmOnError()
		return nil, err
	}
	// From here an error return must also stop what Start started: the watchdog and the sweeper
	// would otherwise keep running against a runtime closeWasmOnError has just closed.
	stopOnError := func() {
		_ = delivery.Shutdown(context.Background())
		closeWasmOnError()
	}
	// The extension point parts 1b and 2 mount through. Registering after the 1a
	// routes means a conflicting pattern panics at start-up, where the stdlib
	// mux reports which two patterns collide.
	for _, register := range o.Extra {
		register(mux)
	}
	mux.Handle("GET /healthz", o.Health.Liveness())
	mux.Handle("GET /readyz", o.Health.Readiness())
	if o.Config.Metrics.Enabled {
		token, err := scrapeToken(o)
		if err != nil {
			stopOnError()
			return nil, err
		}
		mux.Handle("GET "+o.Config.Metrics.Path, o.Metrics.Handler(o.Config.Metrics.RequireAdmin, token))
	}

	var h http.Handler = mux
	h = generationHeader(h, instance.Generation)
	// Recover sits INSIDE RequestLog, not outside it. server.RequestLog logs
	// and calls observe after next.ServeHTTP returns, with no defer, so a panic
	// unwinding past it skips both: the outer-Recover order produced no
	// msg=http line and no dilla_http_requests_total sample for a panicking
	// request, and handler panics never reached the 5xx rate an operator
	// alerts on. This way Recover writes its 500 through RequestLog's
	// statusWriter, so the request is logged and counted as the 5xx it is.
	h = server.Recover(o.Log)(h)
	h = server.RequestLog(o.Log, o.Clock, o.Metrics.ObserveHTTP)(h)

	s := &Server{
		o: o, mux: mux, handler: h, sessions: sessions, instance: instance,
		wasm: wasm, ownsWasm: ownsWasm, gw: gw, ds: delivery,
		throttle: throttle, limiter: limiter,
	}
	s.httpSrv = &http.Server{
		Handler: h,
		// Never zero: net/http reads that as "no limit", and a client trickling a header holds a
		// connection open for as long as it likes. The commit route adds a body deadline of its
		// own (api.withReadDeadline); ReadTimeout stays unset because the gateway upgrade shares
		// the listener.
		ReadHeaderTimeout: readHeaderTimeout(o.Config.Server.ReadHeaderTimeout.Value()),
		IdleTimeout:       o.Config.Server.IdleTimeout.Value(),
		// WriteTimeout is deliberately unset: the gateway's per-connection write
		// deadlines live in its writer goroutine, and hijacking clears the
		// server deadline anyway.
	}
	// h2c is stdlib in Go 1.27 — Server.Protocols plus SetUnencryptedHTTP2 —
	// and x/net/http2/h2c is banned precisely because this field replaces it
	// (facts-http-gateway §4.1). Without it Go's default for a non-TLS listener
	// is HTTP/1 only, so a front proxy configured for unencrypted HTTP/2
	// (`h2c://` in Traefik) cannot reach the API in behind_proxy mode.
	//
	// Caveat from the same fact: the /gateway route must stay HTTP/1.1, because
	// a WebSocket upgrade is an HTTP/1.1 mechanism. A proxy's gateway service
	// therefore stays `http://` even when its API service is `h2c://`.
	protocols := new(http.Protocols)
	protocols.SetHTTP1(true)
	protocols.SetUnencryptedHTTP2(true)
	s.httpSrv.Protocols = protocols
	o.Health.Gate("db").Set(true, "")
	o.Health.Gate("schema").Set(true, "")
	// The wasi runtime is built (or was handed in) and the delivery service it validates in has
	// started its watchdog and sweeper, which is what the heal machinery of invariant 11 runs on.
	o.Health.Gate("wasi").Set(true, "")
	o.Health.Gate("heal").Set(true, "")
	// Plan 1 runs neither the SFU nor the ACME client: both gates belong to Plan 2, which sets
	// them from the subsystems it starts. Left red they would keep /readyz at 503 for the life of
	// every Plan 1 instance.
	o.Health.Gate("livekit").Set(true, "not run until Plan 2")
	o.Health.Gate("tls").Set(true, "not run until Plan 2")
	// The gateway's maintenance loop: 4009 for an overdue heartbeat and the resume window's
	// expiry, every heartbeat interval on the instance clock, with the login throttle, the rate
	// limiter's idle buckets and the expired sessions swept on the same tick. Without it a
	// connection that stops heartbeating stays "online" forever and every suspended connection
	// keeps its ring for the life of the process.
	s.maintenance = gw.Run(context.WithoutCancel(ctx), s.sweep)
	return s, nil
}

// sweep is the maintenance tick's non-gateway half.
func (s *Server) sweep(ctx context.Context) {
	s.throttle.Sweep()
	s.limiter.Sweep()
	if _, err := s.o.Repo.PruneSessions(ctx, s.o.Clock.Now().Unix()); err != nil {
		s.o.Log.Warn("pruning expired sessions failed", "err", err)
	}
}

// Throttle is the login throttle New built; the maintenance loop sweeps it.
func (s *Server) Throttle() *auth.Throttle { return s.throttle }

func (s *Server) Handler() http.Handler    { return s.handler }
func (s *Server) Mux() *server.Mux         { return s.mux }
func (s *Server) Repo() store.Repository   { return s.o.Repo }
func (s *Server) Sessions() *auth.Sessions { return s.sessions }

// DS returns the delivery service New built. It is one of three harness accessors of
// deviation B17 (with Gateway and Now): plain getters over what New built.
func (s *Server) DS() *ds.DS                { return s.ds }
func (s *Server) Gateway() *gateway.Gateway { return s.gw }
func (s *Server) Now() time.Time            { return s.o.Clock.Now() }

// CommitCount is the delivery service's own accepted-commit counter. A
// scenario that asserts "at most four commits for 1,000 devices" needs the
// instance's count, not the client's.
func (s *Server) CommitCount() int { return s.ds.AcceptedCommits() }

// DebugState is the counter bundle the test control listener reports. The type
// is ds.DebugState and not a dilladtest one (deviation B35): dilladtest imports
// this package, and the release binary must never link it.
type DebugState = ds.DebugState

// DebugState reads the delivery service's counters.
func (s *Server) DebugState(ctx context.Context) (DebugState, error) {
	return s.ds.DebugState(ctx)
}

// Protocols reports the HTTP protocols the listener is configured for, so a
// doctor leg and a test can both assert that unencrypted HTTP/2 is on.
func (s *Server) Protocols() *http.Protocols { return s.httpSrv.Protocols }

func (s *Server) Serve(ctx context.Context, ln net.Listener) error {
	if err := s.httpSrv.Serve(ln); err != nil && !errors.Is(err, http.ErrServerClosed) {
		return fmt.Errorf("dillad: serve: %w", err)
	}
	return nil
}

// Shutdown drains within shutdown_grace and then closes what is left, in
// dependency order: the HTTP server, the delivery service (it fans out to the
// gateway, and its watchdog and sweeper stop here), the gateway, the wasm
// runtime when New compiled it, and the repository when New opened it — a
// caller that supplied its own store or runtime still owns it.
//
// Shutdown is idempotent: the second and later calls return the first call's
// result and touch nothing.
func (s *Server) Shutdown(ctx context.Context) error {
	s.shutdownOnce.Do(func() { s.shutdownErr = s.shutdown(ctx) })
	return s.shutdownErr
}

func (s *Server) shutdown(ctx context.Context) error {
	s.o.Health.Drain()
	grace := s.o.Config.Server.ShutdownGrace.Value()
	ctx, cancel := context.WithTimeout(ctx, grace)
	defer cancel()
	var err error
	keep := func(e error) {
		if e != nil && err == nil {
			err = e
		}
	}
	if serr := s.httpSrv.Shutdown(ctx); serr != nil {
		keep(s.httpSrv.Close())
	}
	if s.maintenance != nil {
		s.maintenance()
	}
	if derr := s.ds.Shutdown(ctx); derr != nil {
		keep(fmt.Errorf("dillad: stop the delivery service: %w", derr))
	}
	if gerr := s.gw.Shutdown(ctx); gerr != nil {
		keep(fmt.Errorf("dillad: stop the gateway: %w", gerr))
	}
	if s.ownsWasm {
		if werr := s.wasm.Close(ctx); werr != nil {
			keep(fmt.Errorf("dillad: close the wasm runtime: %w", werr))
		}
	}
	if s.o.closeRepo {
		if cerr := s.o.Repo.Close(); cerr != nil {
			keep(fmt.Errorf("dillad: close store: %w", cerr))
		}
	}
	return err
}

// newWasmRuntime compiles the wasi core New was pointed at. The compilation
// cache lives under the data directory, so a restart loads the compiled module
// instead of compiling it again.
func newWasmRuntime(ctx context.Context, o Options) (*mlswasi.Runtime, error) {
	path := o.CorePath
	if path == "" {
		var err error
		if path, err = defaultCorePath(); err != nil {
			return nil, err
		}
	}
	module, err := os.ReadFile(path) //nolint:gosec // G304: path is Options.CorePath or the wasi core beside the binary
	if err != nil {
		return nil, fmt.Errorf("dillad: read the wasi core %s: %w", path, err)
	}
	rt, err := mlswasi.New(ctx, module, mlswasi.Options{
		CacheDir: filepath.Join(o.Config.Instance.DataDir, "wazero-cache"),
		Now:      o.Clock.Now,
	})
	if err != nil {
		return nil, fmt.Errorf("dillad: build the wasi runtime from %s: %w", path, err)
	}
	return rt, nil
}

// scrapeToken is the bearer token /metrics is guarded with. An empty one with
// metrics.require_admin set is NOT "no token required": obs.Metrics.Handler
// compares the Authorization header against it in constant time, and a request
// with no Authorization header compares equal to "", which would leave the
// whole metric surface open on a default configuration. An unsupplied token
// becomes 32 random bytes nobody holds, so the guarded endpoint answers 401 to
// everyone until the operator sets one, and the log line says so.
func scrapeToken(o Options) (string, error) {
	if !o.Config.Metrics.RequireAdmin || o.ScrapeToken != "" {
		return o.ScrapeToken, nil
	}
	buf := make([]byte, 32)
	if _, err := rand.Read(buf); err != nil {
		return "", fmt.Errorf("dillad: generate a placeholder scrape token: %w", err)
	}
	o.Log.Warn("metrics.require_admin is set and no scrape token was supplied; "+
		"every scrape of this instance will be refused until one is",
		"path", o.Config.Metrics.Path)
	return hex.EncodeToString(buf), nil
}

// readHeaderTimeout is server.read_header_timeout, or its 10 s default when a programmatic
// configuration left it zero.
func readHeaderTimeout(d time.Duration) time.Duration {
	if d <= 0 {
		return 10 * time.Second
	}
	return d
}

// ReadHeaderTimeout is the listener's header deadline.
func (s *Server) ReadHeaderTimeout() time.Duration { return s.httpSrv.ReadHeaderTimeout }

// generationHeader stamps X-Dilla-Generation on every response, so an HTTP-only
// client notices a restore without holding a gateway connection.
func generationHeader(next http.Handler, generation uint64) http.Handler {
	value := strconv.FormatUint(generation, 10)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Dilla-Generation", value)
		next.ServeHTTP(w, r)
	})
}
