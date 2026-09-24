// Package dillad is the composition root: the one place that knows how the
// config, the store, the auth layer, the API handlers, the metrics and the
// health gates fit together. cmd/dillad's serve verb is a thin wrapper over it,
// and so is every end-to-end test, which is why the test path and the
// production path cannot drift.
package dillad

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"net"
	"net/http"
	"slices"
	"strconv"

	"github.com/jonasthim/dilla/internal/api"
	"github.com/jonasthim/dilla/internal/auth"
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
	// ds and gateway are filled by part 1b; they are `any` here so that adding
	// them costs 1b a type change and not a new method.
	ds      any
	gateway any
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

	mux := server.NewMux()
	api.Register(mux, deps)
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

	s := &Server{o: o, mux: mux, handler: h, sessions: sessions, instance: instance}
	s.httpSrv = &http.Server{
		Handler:           h,
		ReadHeaderTimeout: o.Config.Server.ReadHeaderTimeout.Value(),
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
	return s, nil
}

func (s *Server) Handler() http.Handler    { return s.handler }
func (s *Server) Mux() *server.Mux         { return s.mux }
func (s *Server) Repo() store.Repository   { return s.o.Repo }
func (s *Server) Sessions() *auth.Sessions { return s.sessions }

// Protocols reports the HTTP protocols the listener is configured for, so a
// doctor leg and a test can both assert that unencrypted HTTP/2 is on.
func (s *Server) Protocols() *http.Protocols { return s.httpSrv.Protocols }

// DS and Gateway are reserved for part 1b, which adds the two fields and
// changes these to return them. interfaces.md §7.3 requires the test harness to
// reach all three, and a 1b test that calls them must not have to edit this
// file's shape as well as its contents.
func (s *Server) DS() any      { return s.ds }
func (s *Server) Gateway() any { return s.gateway }

func (s *Server) Serve(ctx context.Context, ln net.Listener) error {
	if err := s.httpSrv.Serve(ln); err != nil && !errors.Is(err, http.ErrServerClosed) {
		return fmt.Errorf("dillad: serve: %w", err)
	}
	return nil
}

// Shutdown drains within shutdown_grace and then closes what is left. It also
// closes the repository, but only when New opened it: a caller that supplied
// its own store still owns it.
func (s *Server) Shutdown(ctx context.Context) error {
	s.o.Health.Drain()
	grace := s.o.Config.Server.ShutdownGrace.Value()
	ctx, cancel := context.WithTimeout(ctx, grace)
	defer cancel()
	var err error
	if serr := s.httpSrv.Shutdown(ctx); serr != nil {
		err = s.httpSrv.Close()
	}
	if s.o.closeRepo {
		if cerr := s.o.Repo.Close(); cerr != nil && err == nil {
			err = fmt.Errorf("dillad: close store: %w", cerr)
		}
	}
	return err
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

// generationHeader stamps X-Dilla-Generation on every response, so an HTTP-only
// client notices a restore without holding a gateway connection.
func generationHeader(next http.Handler, generation uint64) http.Handler {
	value := strconv.FormatUint(generation, 10)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Dilla-Generation", value)
		next.ServeHTTP(w, r)
	})
}
