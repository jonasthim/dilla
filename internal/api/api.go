// Package api is dillad's HTTP surface over internal/store and internal/auth:
// the accounts, devices, device-list, invite, session, auth-ceremony and
// delivery-service routes, all of them deterministic CBOR (interfaces.md §5).
//
// It knows nothing about transport — internal/server owns the mux, the codec,
// the error body and the token buckets — and nothing about MLS, which reaches
// it through internal/ds.
package api

import (
	"context"
	"log/slog"
	"net/http"

	"github.com/jonasthim/dilla/internal/auth"
	"github.com/jonasthim/dilla/internal/clock"
	"github.com/jonasthim/dilla/internal/config"
	"github.com/jonasthim/dilla/internal/id"
	"github.com/jonasthim/dilla/internal/obs"
	"github.com/jonasthim/dilla/internal/server"
	"github.com/jonasthim/dilla/internal/store"
)

// Deps is everything the handlers need, declared once so no handler reaches for
// a package-level variable and no test has to build a server to exercise a
// route. Handlers hang off it by value: a Deps is a bag of pointers and is
// copied per route, never per request.
//
// A field a later task fills is declared nil here and named with that task, so
// no task silently widens a struct another task owns.
type Deps struct {
	Repo         store.Repository
	Clock        clock.Clock
	Log          *slog.Logger
	Limiter      *server.RateLimiter
	Metrics      *obs.Metrics
	Instance     store.InstanceRow
	Domain       string
	Config       *config.Config
	Registration config.Registration
	Sessions     *auth.Sessions

	// CloseGateway closes a device's gateway connections inside the same
	// transaction that revokes it. Nil until part 1b's gateway exists; the
	// composition root wires it to Sessions.OnRevoke.
	CloseGateway func(deviceID id.ID)

	// Hasher is the Argon2id password hasher. It is an interface for the same
	// reason GatewayTickets is: the concrete *auth.Hasher is task 9's, and a
	// struct cannot name a type that does not exist yet. Nil until then, and a
	// registration that carries a password is refused rather than stored
	// unhashed.
	Hasher PasswordHasher

	// Tickets mints single-use gateway tickets. Nil here; part 1b task 17
	// supplies the implementation and task 12 registers the route, which
	// answers 501 while this is nil.
	Tickets GatewayTickets

	// Throttle is the login-attempt bucket and the account lockout ledger, and
	// Assertions holds the one-time enrolment assertions the three
	// unauthenticated ceremonies mint and POST /v1/devices/{device_id}/sessions
	// spends. Both are task 9's. Every route in auth.go refuses with
	// E_INTERNAL while either is nil rather than running unmetered.
	Throttle   *auth.Throttle
	Assertions *Assertions

	// Still to come, each with the task that declares its type and fills it:
	//
	//	Passkeys   *auth.Passkeys   // task 10 — WebAuthn ceremonies
	//	OIDC       *auth.OIDC       // task 11 — nil unless auth.oidc.enabled
	//
	// They are NOT declared yet because Go cannot name a type that does not
	// exist: internal/auth gains Passkeys and OIDC in tasks 10-11. Each of
	// those tasks adds its one field here, with the spelling above, and
	// nothing else.
}

// GatewayTickets is the one-method view api needs of internal/gateway's ticket
// store. The interface is declared here so Deps can carry a nil of it; the
// implementation is part 1b's (interfaces.md §1, §6.1).
type GatewayTickets interface {
	Mint(userID, deviceID id.ID) (ticket string, expires int64)
}

// PasswordHasher is the view api needs of internal/auth's Argon2id hasher. Both
// methods are bounded by a weighted semaphore inside the implementation and
// refuse with E_RATE_LIMITED over it, rather than queueing: Argon2id at the
// configured 19 456 KiB is a memory bomb an unauthenticated route must not be
// able to aim at the instance.
type PasswordHasher interface {
	Hash(ctx context.Context, pw string) (string, error)
	Verify(ctx context.Context, pw, phc string) (ok bool, needsRehash bool, err error)
}

// Body caps. interfaces.md §5.3: 64 KiB on every CBOR route but the two the
// delivery service and Plan 2's readable channels own.
const maxCBORBody = 64 << 10

// Register mounts every route this part of the plan owns. It is one call, so a
// route that exists in the document and not in the binary is a missing line
// here rather than a forgotten wiring in a composition root.
func Register(m *server.Mux, d Deps) {
	// Unauthenticated. The invite landing page and the two registration routes
	// are the only /v1 surface a caller reaches without a bearer token, so each
	// is metered here on its own §5.3 bucket, keyed by the client address,
	// rather than on the session-keyed ones every route below uses. The third
	// unauthenticated bucket §5.3 names, `unauth`, is deliberately not applied:
	// no route this task owns is on it, and the next unauthenticated surface —
	// task 12's session challenge — meters itself.
	m.Handle("GET /i/{code}", d.metered(classInvite, d.InviteLanding, d.landingRefusal))
	m.Handle("POST /v1/invites/redeem", d.metered(classInvite, d.RedeemInvite, refuseCBOR))
	m.Handle("POST /v1/accounts", d.metered(classRegister, d.CreateAccount, refuseCBOR))

	// Auth ceremonies (protocol/09 § Auth ceremonies). The three
	// unauthenticated ones meter themselves on the `login` and `login_failed`
	// buckets inside the handler — they need the client address for the
	// lockout ledger anyway, so metering them here as well would take two
	// tokens per attempt.
	m.Handle("POST /v1/auth/password/login", http.HandlerFunc(d.PasswordLogin))
	m.Handle("POST /v1/auth/totp/verify", http.HandlerFunc(d.VerifyTOTP))
	m.Handle("POST /v1/auth/recovery/verify", http.HandlerFunc(d.VerifyRecovery))
	m.Handle("POST /v1/auth/password", d.enrolled(d.ChangePassword))
	m.Handle("POST /v1/auth/totp/enroll", d.enrolled(d.EnrollTOTP))
	m.Handle("POST /v1/auth/totp/confirm", d.enrolled(d.ConfirmTOTP))

	// Accounts. Every one of these is an enrolled session.
	m.Handle("GET /v1/accounts/me", d.enrolled(d.GetMe))
	m.Handle("PATCH /v1/accounts/me", d.enrolled(d.PatchMe))
	m.Handle("DELETE /v1/accounts/me", d.enrolled(d.DeleteMe))

	// Devices. POST /v1/devices also accepts a `pending` session: a device
	// enrolled through a host login holds one until it is paired.
	m.Handle("POST /v1/devices", d.scoped(d.CreateDevice, auth.ScopePending))
	m.Handle("GET /v1/devices", d.enrolled(d.ListDevices))
	m.Handle("DELETE /v1/devices/{device_id}", d.enrolled(d.DeleteDevice))
	m.Handle("PUT /v1/users/{user_id}/device-list", d.enrolled(d.PutDeviceList))
	m.Handle("GET /v1/users/{user_id}/device-list", d.enrolled(d.GetDeviceList))
}

// The two §5.3 buckets this task's routes are on. The names are config's own
// spelling (internal/config/validate.go's rateBuckets), so the knob an operator
// writes in dilla.toml and the class a route is metered on are one string.
const (
	classRegister = "register"
	classInvite   = "invite"
)

// metered wraps an unauthenticated handler in the named token bucket, keyed by
// the client address (IPv6 by /64 — server.RateKey). refuse writes the refusal
// in the shape that route answers in: CBOR for a /v1 route, and content
// negotiation for the landing page, which a browser renders.
func (d Deps) metered(class string, h http.HandlerFunc, refuse func(http.ResponseWriter, *http.Request, error)) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := d.meter(class, r); err != nil {
			refuse(w, r, err)
			return
		}
		h(w, r)
	})
}

// meter takes one token from class's bucket for this caller and returns the
// refusal when there is none. The refusal carries the bucket's own deficit as
// retry_after_ms; server.WriteError turns that into the Retry-After header.
//
// It fails CLOSED. A nil Limiter or a nil Config is a composition-root bug, and
// the outcome of treating it as "no limit configured" is precisely what these
// buckets exist to prevent: an unmetered registration route. Every handler
// below this line is behind a session; these three are not.
func (d Deps) meter(class string, r *http.Request) error {
	if d.Limiter == nil || d.Config == nil {
		return server.Errorf(server.CodeInternal, "the %s rate bucket is not wired", class)
	}
	c, err := rateClass(d.Config.Limits.Rate, class)
	if err != nil {
		return err
	}
	key := server.RateKey(server.RealIP(r, d.Config.Server.TrustedProxyCIDRs))
	if ok, wait := d.Limiter.Allow(c, key); !ok {
		return server.RateLimited(uint64(wait.Milliseconds()))
	}
	return nil
}

// rateClass reads one (per_second, burst) pair out of the configured limits.
func rateClass(r config.Rate, name string) (server.Class, error) {
	switch name {
	case classRegister:
		return server.Class{Name: classRegister, PerSecond: r.RegisterPerSecond, Burst: r.RegisterBurst}, nil
	case classInvite:
		return server.Class{Name: classInvite, PerSecond: r.InvitePerSecond, Burst: r.InviteBurst}, nil
	}
	return server.Class{}, server.Errorf(server.CodeInternal, "no rate bucket named %q", name)
}

// refuseCBOR is the refusal writer of every route whose body is CBOR.
func refuseCBOR(w http.ResponseWriter, _ *http.Request, err error) { server.WriteError(w, err) }

func (d Deps) enrolled(h http.HandlerFunc) http.Handler {
	return d.scoped(h, auth.ScopeEnrolled)
}

func (d Deps) scoped(h http.HandlerFunc, want auth.Scope) http.Handler {
	return d.Sessions.Middleware(h, want)
}

// session is the resolved session of an authenticated route. A handler that
// reaches this and finds nothing was registered without the middleware, which
// is a programming error and not a client's fault.
func session(r *http.Request) (auth.Session, bool) {
	return auth.FromContext(r.Context())
}

// logf records a server-side cause that never reaches the client. Every refusal
// a client sees is a server.Error with a code from the one table; the detail
// behind an E_INTERNAL stays here.
func (d Deps) logf(r *http.Request, msg string, args ...any) {
	if d.Log == nil {
		return
	}
	d.Log.ErrorContext(r.Context(), msg, args...)
}

// notImplemented is the refusal for a route whose backing store method this
// part of the plan does not yet have. It is 501 with E_INTERNAL, whose detail
// WriteError blanks, so a client learns "not this instance, not yet" and
// nothing about the instance's internals.
func notImplemented(detail string) *server.Error {
	return server.WithStatus(http.StatusNotImplemented, server.Errorf(server.CodeInternal, "%s", detail))
}
