package api

import (
	"crypto/rand"
	"encoding/base64"
	"errors"
	"net/http"
	"net/netip"
	"sync"
	"time"

	"github.com/jonasthim/dilla/internal/auth"
	"github.com/jonasthim/dilla/internal/clock"
	"github.com/jonasthim/dilla/internal/id"
	"github.com/jonasthim/dilla/internal/server"
	"github.com/jonasthim/dilla/internal/store"
)

// Assertions holds the short-lived, one-time enrolment assertions that carry a
// host login across to POST /v1/devices/{device_id}/sessions. An assertion is
// NOT a session token: it reaches exactly one endpoint, is spent on first use
// and lives only in memory, so a restart invalidates every in-flight login
// rather than leaving a second bearer credential in the database.
type Assertions struct {
	clk clock.Clock
	ttl time.Duration

	mu    sync.Mutex
	items map[string]assertion
}

type assertion struct {
	userID            id.ID
	needsSecondFactor bool
	expires           time.Time
}

// auth.Sessions spends an assertion on the pending path of POST
// /v1/devices/{device_id}/sessions through this interface — internal/api
// imports internal/auth, so the seam has to point this way. The assertion below
// is what keeps the two signatures from drifting apart.
var _ auth.AssertionSpender = (*Assertions)(nil)

func NewAssertions(clk clock.Clock, ttl time.Duration) *Assertions {
	return &Assertions{clk: clk, ttl: ttl, items: map[string]assertion{}}
}

func (a *Assertions) Issue(userID id.ID, needsSecondFactor bool) string {
	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		panic("api: crypto/rand failed: " + err.Error())
	}
	token := base64.RawURLEncoding.EncodeToString(raw)
	a.mu.Lock()
	defer a.mu.Unlock()
	a.sweepLocked()
	a.items[token] = assertion{userID: userID, needsSecondFactor: needsSecondFactor,
		expires: a.clk.Now().Add(a.ttl)}
	return token
}

// Spend consumes an assertion. It deletes before it checks the expiry, so a
// replay of an expired token cannot be distinguished from a replay of a live
// one, and neither can be retried.
func (a *Assertions) Spend(token string) (id.ID, bool, bool) {
	a.mu.Lock()
	defer a.mu.Unlock()
	item, ok := a.items[token]
	if !ok {
		return id.ID{}, false, false
	}
	delete(a.items, token)
	if a.clk.Now().After(item.expires) {
		return id.ID{}, false, false
	}
	return item.userID, item.needsSecondFactor, true
}

// Upgrade replaces an assertion that has cleared its second factor with a fresh
// one that has not, so the TOTP and recovery routes hand back something the
// session endpoint will accept.
func (a *Assertions) Upgrade(userID id.ID) string { return a.Issue(userID, false) }

func (a *Assertions) sweepLocked() {
	now := a.clk.Now()
	for k, v := range a.items {
		if now.After(v.expires) {
			delete(a.items, k)
		}
	}
}

// AssertionTTL is how long an enrolment assertion lives. It is deliberately
// short: the only thing it can do is establish one device session, and a client
// that has just logged in is already holding the next request.
const AssertionTTL = 5 * time.Minute

// The login_attempts.method column. The numbers are this file's, because no
// other file writes the column.
const (
	methodPassword uint8 = 0
	methodTOTP     uint8 = 1
	methodRecovery uint8 = 2
)

// classLogin is the §5.3 bucket every unauthenticated auth ceremony is on. The
// second-factor routes share its rate but not its keys: secondFactorKey
// prefixes the address, so a client that has just spent a login token on the
// password step is not refused the TOTP step that must follow it.
const classLogin = "login"

// classLoginFailed is the per-address FAILURE budget. RecordFailure is its one
// writer; PasswordLogin only peeks at it.
const classLoginFailed = "login_failed"

func secondFactorKey(addr string) string { return "2fa\x00" + addr }

// passwordLoginRequest is [username(tstr), password(tstr)].
type passwordLoginRequest struct {
	_        struct{} `cbor:",toarray"`
	Username string
	Password string
}

// assertionRequest is the body both second-factor routes share:
// [assertion(tstr), code(tstr)].
type assertionRequest struct {
	_         struct{} `cbor:",toarray"`
	Assertion string
	Code      string
}

// PasswordLogin is POST /v1/auth/password/login →
// [assertion(tstr), needs_totp(uint)].
//
// Every refusal on this route is the same E_UNAUTHENTICATED with an empty
// detail. An unknown handle, a handle that fails normalisation, an account with
// no password credential and a wrong password are four different server-side
// facts and one client-visible answer, and the Hasher burns a dummy Argon2id
// hash for the first three so they cost the same wall time as the fourth.
func (d Deps) PasswordLogin(w http.ResponseWriter, r *http.Request) {
	if d.Throttle == nil || d.Assertions == nil || d.Hasher == nil || d.Config == nil {
		d.logf(r, "api: the password login route is not wired")
		server.WriteError(w, server.Errorf(server.CodeInternal, "the password login route is not wired"))
		return
	}
	var req passwordLoginRequest
	if err := server.DecodeBody(w, r, maxCBORBody, &req); err != nil {
		server.WriteError(w, err)
		return
	}
	ctx := r.Context()
	ip := server.RealIP(r, d.Config.Server.TrustedProxyCIDRs)
	addrKey := server.RateKey(ip)

	// The standing gate, before a single byte of Argon2id is computed: the
	// attempt rate from this address. The `login_failed` bucket is NOT consulted
	// here, and the omission is deliberate — RateLimiter.Allow takes a token as
	// well as reporting, so checking it on arrival would meter every SUCCESSFUL
	// login on the failure bucket and spend an address's whole failure budget
	// on people who typed their password correctly. Failures reach it through
	// Throttle.RecordFailure, which is the one writer of that bucket.
	if ok, wait := d.Throttle.Allow(classLogin, addrKey); !ok {
		server.WriteError(w, server.RateLimited(uint64(wait.Milliseconds())))
		return
	}

	// And the address's FAILURE budget, PEEKED rather than spent. This is the
	// gate that makes "fifty failures across fifty accounts from one address
	// still throttle that address" true: the `login` bucket above is keyed by
	// address and by handle spelling, so an attacker spreading guesses over
	// many handles empties no handle's bucket, and the per-account lockout
	// below never sees two failures on the same account either. Only the
	// address-wide failure ledger counts that attacker, and Peek is how a
	// bucket whose one writer is Throttle.RecordFailure can be read here
	// without charging a correct password for someone else's guesses.
	if ok, wait := d.Throttle.Peek(classLoginFailed, addrKey); !ok {
		server.WriteError(w, server.RateLimited(uint64(wait.Milliseconds())))
		return
	}

	// The per-handle gate is keyed by the SPELLING, not by a user id, so an
	// account that exists and one that does not are metered identically and the
	// bucket is not itself an enumeration oracle.
	handle, herr := auth.NormalizeHandle(req.Username)
	if herr == nil {
		if ok, wait := d.Throttle.Allow(classLogin, "handle\x00"+handle); !ok {
			server.WriteError(w, server.RateLimited(uint64(wait.Milliseconds())))
			return
		}
	}

	var (
		user  store.UserRow
		found bool
		phc   string
	)
	if herr == nil {
		u, err := d.Repo.GetUserByUsername(ctx, handle)
		switch {
		case err == nil && u.DisabledAt == nil:
			user, found = u, true
			if stored, perr := d.Repo.GetPasswordCredential(ctx, u.ID); perr == nil {
				phc = stored
			} else if !errors.Is(perr, store.ErrNotFound) {
				server.WriteError(w, d.storeError(r, perr))
				return
			}
		case err != nil && !errors.Is(err, store.ErrNotFound):
			server.WriteError(w, d.storeError(r, err))
			return
		}
	}

	ok, _, err := d.Hasher.Verify(ctx, req.Password, phc)
	if err != nil {
		// The only error a bounded Hasher returns is E_RATE_LIMITED, which the
		// client may retry; anything else is already a *server.Error.
		server.WriteError(w, err)
		return
	}
	if !ok || !found {
		d.recordAttempt(r, user, found, addrKey, methodPassword, false)
		server.WriteError(w, d.failure(user, found, ip))
		return
	}

	// A success clears the account's ledger, both the in-memory one the lockout
	// curve reads and the durable one the admin CLI reports.
	d.Throttle.Clear(user.ID)
	if cerr := d.Repo.ClearLoginFailures(ctx, user.ID); cerr != nil {
		d.logf(r, "api: ClearLoginFailures", "err", cerr)
	}
	d.recordAttempt(r, user, true, addrKey, methodPassword, true)

	needsTOTP := uint64(0)
	if row, terr := d.Repo.GetTOTP(ctx, user.ID); terr == nil && row.ConfirmedAt != nil {
		needsTOTP = 1
	} else if terr != nil && !errors.Is(terr, store.ErrNotFound) {
		server.WriteError(w, d.storeError(r, terr))
		return
	}
	d.write(w, r, http.StatusOK, []any{d.Assertions.Issue(user.ID, needsTOTP == 1), needsTOTP})
}

// failure is the one refusal every wrong credential gets. When the account's
// ledger has crossed free_attempts the refusal carries the lockout as
// retry_after_ms — which tells a legitimate user how long to wait and tells an
// attacker only what the growing delay already told them.
//
// A failure against an account that does not exist is still recorded, under the
// all-zero id: the account half of the ledger is meaningless there, and is never
// read back because the refusal below ignores it, but the ADDRESS half is
// exactly what must count — an attacker guessing a thousand handles from one
// address is the case the login_failed bucket exists for.
func (d Deps) failure(user store.UserRow, found bool, ip netip.Addr) error {
	locked := d.Throttle.RecordFailure(user.ID, ip)
	if found && locked > 0 {
		return server.RateLimited(uint64(locked.Milliseconds()))
	}
	return server.Errorf(server.CodeUnauthenticated, "")
}

// recordAttempt writes one login_attempts row. A failure for an unknown account
// is recorded with a NULL user_id, so the address is still countable.
func (d Deps) recordAttempt(r *http.Request, user store.UserRow, found bool, addr string, method uint8, ok bool) {
	row := store.LoginAttemptRow{IP: addr, Method: method, OK: ok, At: d.Clock.Now().Unix()}
	if found {
		uid := user.ID
		row.UserID = &uid
	}
	if err := d.Repo.RecordLoginAttempt(r.Context(), row); err != nil {
		d.logf(r, "api: RecordLoginAttempt", "err", err)
	}
}

// ChangePassword is POST /v1/auth/password: [old(tstr|null), new(tstr)] → 204.
//
// The step-up this route needs is the old password itself, and it is required
// whenever the account has a credential: a stolen session token must not be
// enough to lock the owner out of their own account. An account with no
// password yet (registered through a passkey or OIDC) may set one with a null
// old.
func (d Deps) ChangePassword(w http.ResponseWriter, r *http.Request) {
	sess, ok := session(r)
	if !ok {
		server.WriteError(w, server.Errorf(server.CodeUnauthenticated, ""))
		return
	}
	if d.Hasher == nil || d.Throttle == nil {
		d.logf(r, "api: the password change route is not wired")
		server.WriteError(w, server.Errorf(server.CodeInternal, "the password change route is not wired"))
		return
	}
	var req struct {
		_   struct{} `cbor:",toarray"`
		Old *string
		New string
	}
	if err := server.DecodeBody(w, r, maxCBORBody, &req); err != nil {
		server.WriteError(w, err)
		return
	}
	if req.New == "" {
		server.WriteError(w, server.Errorf(server.CodeInvalidRequest, "the new password is empty"))
		return
	}
	ctx := r.Context()
	phc, err := d.Repo.GetPasswordCredential(ctx, sess.UserID)
	if err != nil && !errors.Is(err, store.ErrNotFound) {
		server.WriteError(w, d.storeError(r, err))
		return
	}
	if phc != "" {
		if req.Old == nil {
			server.WriteError(w, server.Errorf(server.CodeForbidden, "changing a password needs the old one"))
			return
		}
		valid, _, verr := d.Hasher.Verify(ctx, *req.Old, phc)
		if verr != nil {
			server.WriteError(w, verr)
			return
		}
		if !valid {
			ip := netip.Addr{}
			if d.Config != nil {
				ip = server.RealIP(r, d.Config.Server.TrustedProxyCIDRs)
			}
			d.Throttle.RecordFailure(sess.UserID, ip)
			server.WriteError(w, server.Errorf(server.CodeForbidden, "the old password is wrong"))
			return
		}
	}
	next, err := d.Hasher.Hash(ctx, req.New)
	if err != nil {
		server.WriteError(w, err)
		return
	}
	if err := d.Repo.PutPasswordCredential(ctx, sess.UserID, next, d.Clock.Now().Unix()); err != nil {
		server.WriteError(w, d.storeError(r, err))
		return
	}
	d.Throttle.Clear(sess.UserID)
	d.noContent(w, r)
}

// totpParams reads the instance's TOTP policy. The issuer falls back to the
// instance domain, because pquerna/otp refuses to mint a key without one and an
// operator who left auth.totp.issuer empty still gets a usable QR code.
func (d Deps) totpParams() auth.TOTPParams {
	c := d.Config.Auth.TOTP
	issuer := c.Issuer
	if issuer == "" {
		issuer = d.Domain
	}
	return auth.TOTPParams{Issuer: issuer, Period: c.Period, Skew: c.Skew,
		SecretSize: c.SecretSize, Digits: c.Digits, Algorithm: c.Algorithm}
}

// EnrollTOTP is POST /v1/auth/totp/enroll: [] → [secret(tstr), otpauth_url(tstr)].
//
// The row is written UNCONFIRMED (confirmed_at NULL): an enrolment nobody has
// proved they can compute codes for must never make the account's second factor
// mandatory, or a mistyped QR code locks the owner out. POST
// /v1/auth/totp/confirm is what sets confirmed_at.
//
// An account that already has a CONFIRMED authenticator is refused. totp_secrets
// is one row per user, so enrolling over a confirmed secret would overwrite it
// and clear confirmed_at — and `needs_totp` is read from confirmed_at, so a
// stolen session token could turn the victim's second factor off by starting an
// enrolment it never finishes. Rotating an authenticator needs a removal route
// protocol/09 § Auth ceremonies does not declare; until it does, this refuses
// rather than downgrades.
//
// The secret is stored as its base32 TEXT in the BLOB column, which is the same
// spelling the otpauth URL carries and the one pquerna/otp validates against;
// nothing re-encodes it on the way back out.
func (d Deps) EnrollTOTP(w http.ResponseWriter, r *http.Request) {
	sess, ok := session(r)
	if !ok {
		server.WriteError(w, server.Errorf(server.CodeUnauthenticated, ""))
		return
	}
	if d.Config == nil {
		d.logf(r, "api: the TOTP enrolment route has no config")
		server.WriteError(w, server.Errorf(server.CodeInternal, "the TOTP policy is not wired"))
		return
	}
	ctx := r.Context()
	switch existing, err := d.Repo.GetTOTP(ctx, sess.UserID); {
	case err == nil && existing.ConfirmedAt != nil:
		server.WriteError(w, server.Errorf(server.CodeForbidden,
			"this account already has a confirmed authenticator"))
		return
	case err != nil && !errors.Is(err, store.ErrNotFound):
		server.WriteError(w, d.storeError(r, err))
		return
	}
	u, err := d.Repo.GetUser(ctx, sess.UserID)
	if err != nil {
		server.WriteError(w, d.storeError(r, err))
		return
	}
	p := d.totpParams()
	secret, url, err := auth.GenerateTOTP(p.Issuer, u.Username+"@"+d.Domain, p)
	if err != nil {
		d.logf(r, "api: GenerateTOTP", "err", err)
		server.WriteError(w, server.Errorf(server.CodeInternal, ""))
		return
	}
	now := d.Clock.Now().Unix()
	if err := d.Repo.PutTOTP(ctx, store.TOTPRow{
		UserID: sess.UserID, Secret: []byte(secret), Digits: uint64(p.Digits),
		Period: uint64(p.Period), Algorithm: p.Algorithm, Created: now,
	}); err != nil {
		server.WriteError(w, d.storeError(r, err))
		return
	}
	d.write(w, r, http.StatusOK, []any{secret, url})
}

// ConfirmTOTP is POST /v1/auth/totp/confirm: [code(tstr)] → [recovery_codes([tstr])].
//
// The accepted counter is consumed in the same write that sets confirmed_at, so
// the code the user just typed cannot also be the code that clears their first
// second-factor challenge. Regenerating the recovery codes here invalidates
// every earlier set, which is what a re-enrolment must do.
func (d Deps) ConfirmTOTP(w http.ResponseWriter, r *http.Request) {
	sess, ok := session(r)
	if !ok {
		server.WriteError(w, server.Errorf(server.CodeUnauthenticated, ""))
		return
	}
	if d.Config == nil {
		d.logf(r, "api: the TOTP confirm route has no config")
		server.WriteError(w, server.Errorf(server.CodeInternal, "the TOTP policy is not wired"))
		return
	}
	var req struct {
		_    struct{} `cbor:",toarray"`
		Code string
	}
	if err := server.DecodeBody(w, r, maxCBORBody, &req); err != nil {
		server.WriteError(w, err)
		return
	}
	ctx := r.Context()
	row, err := d.Repo.GetTOTP(ctx, sess.UserID)
	if err != nil {
		server.WriteError(w, d.storeError(r, err))
		return
	}
	counter, ok := auth.ValidateTOTP(req.Code, string(row.Secret), rowParams(row, d.totpParams()), d.Clock.Now())
	if !ok || counter <= row.LastCounter {
		server.WriteError(w, server.Errorf(server.CodeInvalidRequest, "the code does not match this secret"))
		return
	}
	now := d.Clock.Now().Unix()
	confirmed := now
	row.ConfirmedAt = &confirmed
	row.LastCounter = counter
	codes, hashes := auth.GenerateRecoveryCodes(d.Config.Auth.TOTP.RecoveryCodes)
	if err := d.Repo.Tx(ctx, func(tx store.Repository) error {
		if err := tx.PutTOTP(ctx, row); err != nil {
			return err
		}
		return tx.PutRecoveryCodes(ctx, sess.UserID, hashes, now)
	}); err != nil {
		server.WriteError(w, d.storeError(r, err))
		return
	}
	out := make([]any, 0, len(codes))
	for _, c := range codes {
		out = append(out, c)
	}
	d.write(w, r, http.StatusOK, []any{out})
}

// rowParams is the enrolled policy: digits, period and algorithm come from the
// ROW, not from config, so changing auth.totp.* does not invalidate every
// authenticator already enrolled. Only the skew, which is a tolerance rather
// than part of the secret, comes from the current config.
func rowParams(row store.TOTPRow, current auth.TOTPParams) auth.TOTPParams {
	return auth.TOTPParams{
		Issuer: current.Issuer, Period: uint(row.Period), Skew: current.Skew,
		SecretSize: current.SecretSize, Digits: int(row.Digits), Algorithm: row.Algorithm,
	}
}

// VerifyTOTP is POST /v1/auth/totp/verify: [assertion(tstr), code(tstr)] →
// [assertion(tstr)].
//
// ConsumeTOTPCounter, not the library, is the replay guard: pquerna/otp is
// stateless and accepts the same code at every offset inside the skew window
// for the whole of that window. The store's UPDATE fires only while the
// presented counter is strictly greater than the stored one, so a code accepted
// once writes zero rows the second time and the verify is refused even though
// the code is still "valid".
func (d Deps) VerifyTOTP(w http.ResponseWriter, r *http.Request) {
	d.verifySecondFactor(w, r, methodTOTP, func(userID id.ID, code string) error {
		ctx := r.Context()
		row, err := d.Repo.GetTOTP(ctx, userID)
		if err != nil {
			return err
		}
		if row.ConfirmedAt == nil {
			return store.ErrNotFound
		}
		counter, ok := auth.ValidateTOTP(code, string(row.Secret), rowParams(row, d.totpParams()), d.Clock.Now())
		if !ok {
			return store.ErrNotFound
		}
		return d.Repo.ConsumeTOTPCounter(ctx, userID, counter)
	})
}

// VerifyRecovery is POST /v1/auth/recovery/verify: [assertion, code] →
// [assertion]. ConsumeRecoveryCode's UPDATE — `used_at IS NULL` — is the
// single-use guard, exactly as the counter is TOTP's.
func (d Deps) VerifyRecovery(w http.ResponseWriter, r *http.Request) {
	d.verifySecondFactor(w, r, methodRecovery, func(userID id.ID, code string) error {
		return d.Repo.ConsumeRecoveryCode(r.Context(), userID,
			auth.RecoveryCodeHash(code), d.Clock.Now().Unix())
	})
}

// verifySecondFactor is the body both second-factor routes share: spend the
// assertion, run check, and on success hand back a fresh assertion that no
// longer needs a second factor.
//
// The assertion is spent BEFORE check runs, so a wrong code costs the client its
// assertion and a fresh password login. That is the point: without it the
// assertion is a bearer token an attacker may brute-force six digits against.
func (d Deps) verifySecondFactor(w http.ResponseWriter, r *http.Request, method uint8, check func(id.ID, string) error) {
	if d.Throttle == nil || d.Assertions == nil || d.Config == nil {
		d.logf(r, "api: a second-factor route is not wired")
		server.WriteError(w, server.Errorf(server.CodeInternal, "the second-factor routes are not wired"))
		return
	}
	var req assertionRequest
	if err := server.DecodeBody(w, r, maxCBORBody, &req); err != nil {
		server.WriteError(w, err)
		return
	}
	ip := server.RealIP(r, d.Config.Server.TrustedProxyCIDRs)
	addrKey := server.RateKey(ip)
	if ok, wait := d.Throttle.Allow(classLogin, secondFactorKey(addrKey)); !ok {
		server.WriteError(w, server.RateLimited(uint64(wait.Milliseconds())))
		return
	}
	userID, needsSecondFactor, ok := d.Assertions.Spend(req.Assertion)
	if !ok || !needsSecondFactor {
		// An unknown, expired, replayed or already-cleared assertion is one
		// answer: there is nothing here a client can act on but "log in again".
		server.WriteError(w, server.Errorf(server.CodeUnauthenticated, ""))
		return
	}
	if err := check(userID, req.Code); err != nil {
		if !errors.Is(err, store.ErrNotFound) && !errors.Is(err, store.ErrConflict) {
			server.WriteError(w, d.storeError(r, err))
			return
		}
		user := store.UserRow{ID: userID}
		d.recordAttempt(r, user, true, addrKey, method, false)
		server.WriteError(w, d.failure(user, true, ip))
		return
	}
	d.Throttle.Clear(userID)
	d.recordAttempt(r, store.UserRow{ID: userID}, true, addrKey, method, true)
	d.write(w, r, http.StatusOK, []any{d.Assertions.Upgrade(userID)})
}
