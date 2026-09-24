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

	// Still to come, each with the task that declares its type and fills it:
	//
	//	Throttle   *auth.Throttle   // task 9 — login throttle and lockout
	//	Assertions *Assertions      // task 9 — the one-time enrolment assertion
	//	Passkeys   *auth.Passkeys   // task 10 — WebAuthn ceremonies
	//	OIDC       *auth.OIDC       // task 11 — nil unless auth.oidc.enabled
	//
	// They are NOT declared yet because Go cannot name a type that does not
	// exist: internal/auth gains Hasher, Throttle, Passkeys and OIDC in tasks
	// 9-11 and internal/api gains Assertions in task 9. Each of those tasks
	// adds its one field here, with the spelling above, and nothing else.
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
	// are the only /v1 surface a caller reaches without a bearer token, so they
	// carry their own buckets (§5.3) rather than the session-keyed ones.
	m.HandleFunc("GET /i/{code}", d.InviteLanding)
	m.HandleFunc("POST /v1/invites/redeem", d.RedeemInvite)
	m.HandleFunc("POST /v1/accounts", d.CreateAccount)

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
