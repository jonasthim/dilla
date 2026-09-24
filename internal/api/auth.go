package api

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"errors"
	"net/http"
	"net/netip"
	"net/url"
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
// An unknown handle, a handle that fails normalisation, an account with no
// password credential and a wrong password are four different server-side facts
// and one client-visible answer. The Hasher burns a dummy Argon2id hash for the
// first three so they cost the same wall time as the fourth, and loginLedger
// gives the first three a failure ledger of their own so they accrue, and are
// refused by, the same lockout a real account does: a 429 that only real
// accounts can earn is an enumeration oracle on the status line.
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
	spelling := req.Username
	if herr == nil {
		spelling = handle
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

	// The standing lockout gate, before the credential is looked at. Reporting
	// a lockout on the way out of a failed verify does not enforce it: the
	// attacker whose sixth guess happens to be CORRECT while the account is
	// nominally locked would be logged in and handed an assertion. The ledger
	// key is the same shape whether the account exists or not, so this refusal
	// says nothing about which.
	ledger := loginLedger(user, found, spelling)
	if locked := d.Throttle.LockedFor(ledger); locked > 0 {
		server.WriteError(w, server.RateLimited(uint64(locked.Milliseconds())))
		return
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
		server.WriteError(w, d.failure(ledger, ip))
		return
	}

	// A success clears the account's ledger, both the in-memory one the lockout
	// curve reads and the durable one the admin CLI reports.
	d.Throttle.Clear(user.ID)
	if cerr := d.Repo.ClearLoginFailures(ctx, user.ID); cerr != nil {
		d.logf(r, "api: ClearLoginFailures", "err", cerr)
	}
	d.recordAttempt(r, user, true, addrKey, methodPassword, true)

	pending, terr := d.secondFactorPending(ctx, user.ID)
	if terr != nil {
		server.WriteError(w, d.storeError(r, terr))
		return
	}
	needsTOTP := uint64(0)
	if pending {
		needsTOTP = 1
	}
	d.write(w, r, http.StatusOK, []any{d.Assertions.Issue(user.ID, pending), needsTOTP})
}

// secondFactorPending reports whether the account owes a second factor before
// its assertion is complete: it has a TOTP enrolment and that enrolment is
// CONFIRMED. An unconfirmed row is a half-finished enrolment that no client can
// satisfy — /v1/auth/totp/verify refuses it — so it must not gate a login.
//
// It is one function because every route that ends a login has to make the same
// decision. PasswordLogin is not the only way into an account: a passkey ends a
// login too, and one that answered this question differently would be a way
// around the factor the other enforces.
func (d Deps) secondFactorPending(ctx context.Context, userID id.ID) (bool, error) {
	row, err := d.Repo.GetTOTP(ctx, userID)
	switch {
	case err == nil:
		return row.ConfirmedAt != nil, nil
	case errors.Is(err, store.ErrNotFound):
		return false, nil
	default:
		return false, err
	}
}

// loginLedger is the key a login attempt's failures are counted under. A found
// account uses its own id; a handle with no account behind it uses a
// deterministic pseudo-id derived from the spelling that was tried, so an
// unknown handle accrues — and is refused by — exactly the same lockout a real
// one does.
//
// That symmetry is the point. Keying only real accounts and answering plain
// E_UNAUTHENTICATED for the rest makes the fifth wrong password a 429 with a
// retry_after_ms for a handle that exists and a 401 with a null one for a handle
// that does not, on the status line and in the body, which hands an enumerator
// the whole user list four attempts in and wastes the dummy-hash equaliser.
//
// A pseudo-id colliding with a real user id is a 128-bit coincidence, and would
// cost a shared failure ledger rather than anything authenticating.
func loginLedger(user store.UserRow, found bool, spelling string) id.ID {
	if found {
		return user.ID
	}
	sum := sha256.Sum256([]byte("dilla/login-ledger\x00" + spelling))
	var v id.ID
	copy(v[:], sum[:])
	return v
}

// failure is the one refusal every wrong credential gets. When the ledger has
// crossed free_attempts the refusal carries the lockout as retry_after_ms —
// which tells a legitimate user how long to wait and tells an attacker only
// what the growing delay already told them. The ADDRESS half of the same call
// is what counts an attacker guessing a thousand handles from one address; it
// is the one writer of the login_failed bucket PasswordLogin peeks at.
func (d Deps) failure(ledger id.ID, ip netip.Addr) error {
	if locked := d.Throttle.RecordFailure(ledger, ip); locked > 0 {
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
// protocol/09-http-api.md marks this route "E (step-up)", and it has two kinds
// of account to step up. Where the account HAS a credential the old password is
// the step-up, and it is required: a stolen session token must not be enough to
// lock the owner out of their own account. Where it has none — registered
// through a passkey or OIDC — there is no credential to re-present, so the
// step-up falls back to the session's own freshness, exactly as DELETE
// /v1/accounts/me does. An enrolled session alone must NOT be enough there
// either: planting a password on a passkey-only account creates a second,
// persistent login path that survives revoking the passkey.
func (d Deps) ChangePassword(w http.ResponseWriter, r *http.Request) {
	sess, ok := session(r)
	if !ok {
		server.WriteError(w, server.Errorf(server.CodeUnauthenticated, ""))
		return
	}
	// Config carries the step-up window, so a nil one fails CLOSED for the same
	// reason DeleteMe's does: skipping the only gate a branch has because the
	// dependency that holds it is missing is fail-open, and a handler test built
	// without a Config would exercise no gate at all.
	if d.Hasher == nil || d.Throttle == nil || d.Config == nil {
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
			d.Throttle.RecordFailure(sess.UserID, server.RealIP(r, d.Config.Server.TrustedProxyCIDRs))
			server.WriteError(w, server.Errorf(server.CodeForbidden, "the old password is wrong"))
			return
		}
	} else {
		now := d.Clock.Now().Unix()
		row, serr := d.Repo.GetSessionByHash(ctx, sess.TokenHash, now)
		if serr != nil {
			server.WriteError(w, server.Errorf(server.CodeUnauthenticated, ""))
			return
		}
		if window := int64(d.Config.Auth.Session.ReauthWindow.Value().Seconds()); now-row.Created > window {
			server.WriteError(w, server.Errorf(server.CodeForbidden,
				"setting a first password needs a session established in the last %d seconds", window))
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
		d.recordAttempt(r, store.UserRow{ID: userID}, true, addrKey, method, false)
		server.WriteError(w, d.failure(userID, ip))
		return
	}
	d.Throttle.Clear(userID)
	d.recordAttempt(r, store.UserRow{ID: userID}, true, addrKey, method, true)
	d.write(w, r, http.StatusOK, []any{d.Assertions.Upgrade(userID)})
}

// Passkeys (protocol/09-http-api.md § Auth ceremonies).
//
// internal/auth owns the ceremonies; the four handlers below are the CBOR skin
// over them. `options` and `response` cross the wire as opaque `tstr`: they are
// the WebAuthn JSON navigator.credentials produces and consumes, and dillad
// neither re-encodes nor inspects them.

// ceremonyRequest is the body both finish routes share:
// [ceremony_id(bstr16), response(tstr)].
type ceremonyRequest struct {
	_          struct{} `cbor:",toarray"`
	CeremonyID id.ID
	Response   string
}

// methodPasskey is the login_attempts.method value of a passkey assertion. It
// follows recovery because this file is the only writer of that column and the
// three values above it are already spent; it is NOT the instance document's
// `auth_methods` numbering, which is a different enumeration in a different
// message and where 2, not 3, is the passkey.
const methodPasskey uint8 = 3

// passkeyFailureLedger is the account ledger a failed discoverable login is
// charged to. A discoverable ceremony never names an account, so there is no
// per-account lockout to earn and no handle to enumerate; the entry exists only
// because RecordFailure is also what charges the ADDRESS, which is the budget
// every unauthenticated ceremony in this file peeks at and the one an attacker
// spraying assertions empties. Nothing gates on this key.
var passkeyFailureLedger = loginLedger(store.UserRow{}, false, "\x00passkey")

// passkeys returns the ceremony runner, or the refusal a route answers when the
// instance has none. A nil Passkeys is not a composition bug: `passkey` may
// simply be absent from auth.methods, and go-webauthn refuses to build at all
// without an RPOrigins, so an instance that configured no relying party
// legitimately has nothing here.
func (d Deps) passkeys() (*auth.Passkeys, error) {
	if d.Passkeys == nil {
		return nil, notImplemented("passkeys are not enabled on this instance")
	}
	return d.Passkeys, nil
}

// BeginPasskeyRegistration is POST /v1/auth/passkey/register/begin:
// [] → [ceremony_id(bstr16), options(tstr)].
func (d Deps) BeginPasskeyRegistration(w http.ResponseWriter, r *http.Request) {
	sess, ok := session(r)
	if !ok {
		server.WriteError(w, server.Errorf(server.CodeUnauthenticated, ""))
		return
	}
	p, err := d.passkeys()
	if err != nil {
		server.WriteError(w, err)
		return
	}
	ceremonyID, options, err := p.BeginRegistration(r.Context(), sess.UserID)
	if err != nil {
		server.WriteError(w, d.storeError(r, err))
		return
	}
	d.write(w, r, http.StatusOK, []any{ceremonyID, string(options)})
}

// FinishPasskeyRegistration is POST /v1/auth/passkey/register/finish:
// [ceremony_id(bstr16), response(tstr)] → [cred_id(bstr)].
//
// The ceremony row carries the user id the registration began for and
// auth.Passkeys files the credential against THAT id, never against this
// request's session: a ceremony begun by one account and finished from another
// account's session still stores the credential where it was begun, and the
// library's own challenge check refuses the response long before that.
func (d Deps) FinishPasskeyRegistration(w http.ResponseWriter, r *http.Request) {
	if _, ok := session(r); !ok {
		server.WriteError(w, server.Errorf(server.CodeUnauthenticated, ""))
		return
	}
	p, err := d.passkeys()
	if err != nil {
		server.WriteError(w, err)
		return
	}
	var req ceremonyRequest
	if err := server.DecodeBody(w, r, maxCBORBody, &req); err != nil {
		server.WriteError(w, err)
		return
	}
	credID, err := p.FinishRegistration(r.Context(), req.CeremonyID, []byte(req.Response))
	if err != nil {
		// One answer for an unknown ceremony, an expired one, a replayed one and
		// a response the authenticator got wrong: none of them is something a
		// client can act on but "start the ceremony again".
		d.logf(r, "api: finish passkey registration", "err", err)
		server.WriteError(w, server.Errorf(server.CodeInvalidRequest,
			"the registration response was not accepted"))
		return
	}
	d.write(w, r, http.StatusOK, []any{credID})
}

// BeginPasskeyLogin is POST /v1/auth/passkey/login/begin:
// [] → [ceremony_id(bstr16), options(tstr)].
//
// It is unauthenticated and discoverable — no username is presented and none is
// revealed — so it meters itself on the `login` bucket by address, exactly as
// the password and second-factor ceremonies above do.
func (d Deps) BeginPasskeyLogin(w http.ResponseWriter, r *http.Request) {
	if d.Throttle == nil || d.Config == nil {
		d.logf(r, "api: the passkey login route is not wired")
		server.WriteError(w, server.Errorf(server.CodeInternal, "the passkey login route is not wired"))
		return
	}
	p, err := d.passkeys()
	if err != nil {
		server.WriteError(w, err)
		return
	}
	addrKey := server.RateKey(server.RealIP(r, d.Config.Server.TrustedProxyCIDRs))
	if ok, wait := d.Throttle.Allow(classLogin, addrKey); !ok {
		server.WriteError(w, server.RateLimited(uint64(wait.Milliseconds())))
		return
	}
	ceremonyID, options, err := p.BeginLogin(r.Context())
	if err != nil {
		server.WriteError(w, d.storeError(r, err))
		return
	}
	d.write(w, r, http.StatusOK, []any{ceremonyID, string(options)})
}

// FinishPasskeyLogin is POST /v1/auth/passkey/login/finish:
// [ceremony_id(bstr16), response(tstr)] → [assertion(tstr)].
//
// The response shape is protocol/09's: one element, no `needs_totp`. What the
// assertion is WORTH is decided here, by the same secondFactorPending the
// password path uses, and for the reason facts-auth.md §3.6 gives: a passkey is
// two factors only when user verification actually happened, and
// auth.webauthn.user_verification defaults to "preferred", so `validateLogin`'s
// shouldVerifyUser is false and a ceremony that proves possession alone is
// accepted. Issuing a complete assertion from one would let a passkey walk past
// the confirmed TOTP the password path is forced through, which is a downgrade
// of the account's own second factor, not a property of the credential.
//
// So an account with a confirmed TOTP gets an assertion that still owes it, and
// the client spends that on /v1/auth/totp/verify exactly as it does after a
// password — a route that already takes [assertion, code] and answers
// [assertion], so nothing on the wire changes shape. An account with no second
// factor gets a complete assertion, because the passkey IS the whole login.
//
// The ceremony row is single-use in the store, so a replayed body finds no row
// and is refused before a signature is looked at.
func (d Deps) FinishPasskeyLogin(w http.ResponseWriter, r *http.Request) {
	if d.Throttle == nil || d.Assertions == nil || d.Config == nil {
		d.logf(r, "api: the passkey login route is not wired")
		server.WriteError(w, server.Errorf(server.CodeInternal, "the passkey login route is not wired"))
		return
	}
	p, err := d.passkeys()
	if err != nil {
		server.WriteError(w, err)
		return
	}
	var req ceremonyRequest
	if err := server.DecodeBody(w, r, maxCBORBody, &req); err != nil {
		server.WriteError(w, err)
		return
	}
	ctx := r.Context()
	ip := server.RealIP(r, d.Config.Server.TrustedProxyCIDRs)
	addrKey := server.RateKey(ip)
	if ok, wait := d.Throttle.Allow(classLogin, addrKey); !ok {
		server.WriteError(w, server.RateLimited(uint64(wait.Milliseconds())))
		return
	}
	// The address's FAILURE budget, peeked rather than spent, for the same
	// reason PasswordLogin peeks it: taking a token here would meter every
	// successful login on the failure bucket.
	if ok, wait := d.Throttle.Peek(classLoginFailed, addrKey); !ok {
		server.WriteError(w, server.RateLimited(uint64(wait.Milliseconds())))
		return
	}
	userID, err := p.FinishLogin(ctx, req.CeremonyID, []byte(req.Response))
	if err != nil {
		d.logf(r, "api: finish passkey login", "err", err)
		d.recordAttempt(r, store.UserRow{}, false, addrKey, methodPasskey, false)
		d.Throttle.RecordFailure(passkeyFailureLedger, ip)
		server.WriteError(w, server.Errorf(server.CodeUnauthenticated, ""))
		return
	}
	d.Throttle.Clear(userID)
	if cerr := d.Repo.ClearLoginFailures(ctx, userID); cerr != nil {
		d.logf(r, "api: ClearLoginFailures", "err", cerr)
	}
	d.recordAttempt(r, store.UserRow{ID: userID}, true, addrKey, methodPasskey, true)
	pending, terr := d.secondFactorPending(ctx, userID)
	if terr != nil {
		server.WriteError(w, d.storeError(r, terr))
		return
	}
	d.write(w, r, http.StatusOK, []any{d.Assertions.Issue(userID, pending)})
}

// OIDC (protocol/09-http-api.md § Auth ceremonies).
//
// These two routes are the only ones in this package a BROWSER drives rather
// than a CBOR client: they are top-level navigations, so they answer 302 and
// carry their state in a cookie. internal/auth owns discovery, PKCE, the
// id_token verification and the pending-login table; the pair below is the
// HTTP skin over it.

// oidcStateCookie is the cookie protocol/09 names. Deviation ID10 explains why
// the prefix is __Secure- and not __Host-; auth.StateCookie sets the flags.
const oidcStateCookie = "__Secure-dilla-oidc"

// oidcStateTTL is how long a started login may take to come back. It matches
// AssertionTTL for the same reason: a login leg nobody finished promptly is a
// login nobody is waiting on.
const oidcStateTTL = 5 * time.Minute

// methodOIDC is the login_attempts.method value of an OIDC assertion. It
// follows methodPasskey because this file is the only writer of that column; it
// is NOT the instance document's `auth_methods` numbering, where oidc is 3.
const methodOIDC uint8 = 4

// oidcFailureLedger is the account ledger a failed callback is charged to. The
// callback never names an account before the exchange succeeds, so there is no
// per-account lockout to earn; the entry exists only because RecordFailure is
// also what charges the ADDRESS. Nothing gates on this key.
var oidcFailureLedger = loginLedger(store.UserRow{}, false, "\x00oidc")

// oidc returns the login runner, or the refusal both routes answer when the
// instance has none. A nil OIDC is not a composition bug: auth.oidc.enabled
// defaults to false and most instances never configure an identity provider.
func (d Deps) oidc() (*auth.OIDC, error) {
	if d.OIDC == nil {
		return nil, notImplemented("oidc is not enabled on this instance")
	}
	return d.OIDC, nil
}

// oidcReturnURL is where a finished callback sends the browser. The assertion
// travels in the FRAGMENT, never the query: a fragment is never sent to a
// server, never reaches a Referer header and never lands in an access log, and
// this one-time token is the whole login.
func (d Deps) oidcReturnURL(assertion string) string {
	return (&url.URL{Scheme: "https", Host: d.Domain, Path: "/",
		Fragment: "assertion=" + assertion}).String()
}

// StartOIDC is GET /v1/auth/oidc/start: 302 to the identity provider, PKCE
// S256, state cookie.
//
// The state, the nonce and the verifier are minted here and the last two are
// kept server-side under the first, so the browser holds nothing but an opaque
// value it cannot use anywhere else. Discovery happens on this path — lazily,
// on first use — so an IdP that is down costs a refusal on this one route
// rather than a server that will not start.
func (d Deps) StartOIDC(w http.ResponseWriter, r *http.Request) {
	if d.Throttle == nil || d.Config == nil {
		d.logf(r, "api: the oidc start route is not wired")
		server.WriteError(w, server.Errorf(server.CodeInternal, "the oidc start route is not wired"))
		return
	}
	o, err := d.oidc()
	if err != nil {
		server.WriteError(w, err)
		return
	}
	addrKey := server.RateKey(server.RealIP(r, d.Config.Server.TrustedProxyCIDRs))
	if ok, wait := d.Throttle.Allow(classLogin, addrKey); !ok {
		server.WriteError(w, server.RateLimited(uint64(wait.Milliseconds())))
		return
	}
	state, nonce, verifier := auth.NewVerifierAndState()
	target, err := o.AuthURL(r.Context(), state, nonce, verifier)
	if err != nil {
		d.logf(r, "api: oidc authorization url", "err", err)
		server.WriteError(w, server.Errorf(server.CodeInternal, "oidc discovery failed"))
		return
	}
	o.Stash(state, auth.Pending{Nonce: nonce, Verifier: verifier}, oidcStateTTL)
	http.SetCookie(w, auth.StateCookie(oidcStateCookie, state, int(oidcStateTTL/time.Second)))
	http.Redirect(w, r, target, http.StatusFound)
}

// CallbackOIDC is GET /v1/auth/oidc/callback: 302 back to the client with a
// one-time assertion.
//
// The order is the security property. The cookie is cleared first, whatever
// happens next, so a failed callback leaves nothing a browser will replay. The
// state parameter is compared against the cookie in constant time, and the
// pending row is DELETED BEFORE the authorization code is spent, so a replayed
// callback finds no verifier and never reaches the token endpoint at all.
//
// The account is looked up by (issuer, subject), never by email: an address is
// something an identity provider lets a user change, and mapping on it would
// hand somebody else's account to whoever claimed a freed address.
func (d Deps) CallbackOIDC(w http.ResponseWriter, r *http.Request) {
	if d.Throttle == nil || d.Assertions == nil || d.Config == nil {
		d.logf(r, "api: the oidc callback route is not wired")
		server.WriteError(w, server.Errorf(server.CodeInternal, "the oidc callback route is not wired"))
		return
	}
	o, err := d.oidc()
	if err != nil {
		server.WriteError(w, err)
		return
	}
	ctx := r.Context()
	ip := server.RealIP(r, d.Config.Server.TrustedProxyCIDRs)
	addrKey := server.RateKey(ip)
	if ok, wait := d.Throttle.Allow(classLogin, addrKey); !ok {
		server.WriteError(w, server.RateLimited(uint64(wait.Milliseconds())))
		return
	}
	// Peeked rather than spent, for the same reason every other ceremony in
	// this file peeks it: taking a token here would meter every successful
	// login on the failure bucket.
	if ok, wait := d.Throttle.Peek(classLoginFailed, addrKey); !ok {
		server.WriteError(w, server.RateLimited(uint64(wait.Milliseconds())))
		return
	}
	http.SetCookie(w, auth.StateCookie(oidcStateCookie, "", -1))

	// One answer for a cancelled consent, a forged state, a replayed callback
	// and an id_token that did not verify: none of them is something a client
	// can act on but "start the login again".
	refuse := func(msg string, args ...any) {
		d.logf(r, msg, args...)
		d.recordAttempt(r, store.UserRow{}, false, addrKey, methodOIDC, false)
		d.Throttle.RecordFailure(oidcFailureLedger, ip)
		server.WriteError(w, server.Errorf(server.CodeUnauthenticated, ""))
	}
	q := r.URL.Query()
	if e := q.Get("error"); e != "" {
		refuse("api: oidc callback carried an error", "error", e)
		return
	}
	cookie, cerr := r.Cookie(oidcStateCookie)
	state := q.Get("state")
	if cerr != nil || state == "" ||
		subtle.ConstantTimeCompare([]byte(cookie.Value), []byte(state)) != 1 {
		refuse("api: oidc callback state does not match the cookie")
		return
	}
	pend, ok := o.Spend(state)
	if !ok {
		refuse("api: oidc callback has no pending login")
		return
	}
	issuer, subject, email, err := o.Exchange(ctx, q.Get("code"), pend.Verifier, pend.Nonce)
	if err != nil {
		refuse("api: oidc exchange", "err", err)
		return
	}
	userID, err := d.Repo.GetOIDCIdentity(ctx, issuer, subject)
	switch {
	case errors.Is(err, store.ErrNotFound):
		// No account is mapped to this subject. Creating one here is not
		// something this route can do on its own: users.umk_pub, ssk_pub and
		// sig_umk_ssk are NOT NULL and are the account's own key material,
		// which only the client holds — a server that invented them would be
		// inventing the identity the whole protocol is keyed on. So the
		// refusal is E_FORBIDDEN either way, and auto_create changes only the
		// detail and what is logged: turning it on says the operator wants
		// these logins to become accounts, and the client-completed
		// registration leg that spends one does not exist yet. The key is
		// therefore reserved: deviation ID19 and ruling 40 record that, and
		// config.OIDC.AutoCreate says so where an operator reads it.
		if !d.Config.Auth.OIDC.AutoCreate {
			server.WriteError(w, server.Errorf(server.CodeForbidden,
				"this instance does not create accounts from the identity provider"))
			return
		}
		d.logf(r, "api: oidc login has no account and auto_create needs a client-completed registration",
			"issuer", issuer, "subject", subject, "email", email)
		server.WriteError(w, server.Errorf(server.CodeForbidden,
			"register first: an account carries key material only the client can generate"))
		return
	case err != nil:
		server.WriteError(w, d.storeError(r, err))
		return
	}
	d.Throttle.Clear(userID)
	if clearErr := d.Repo.ClearLoginFailures(ctx, userID); clearErr != nil {
		d.logf(r, "api: ClearLoginFailures", "err", clearErr)
	}
	d.recordAttempt(r, store.UserRow{ID: userID}, true, addrKey, methodOIDC, true)
	// An OIDC login is exactly as strong as the identity provider made it, and
	// dillad cannot tell from an id_token whether a second factor was involved.
	// So an account with a confirmed TOTP still owes it, for the same reason a
	// passkey login does: a login path that walked past the account's own
	// second factor would be a downgrade of that factor, not a property of the
	// provider.
	pending2FA, terr := d.secondFactorPending(ctx, userID)
	if terr != nil {
		server.WriteError(w, d.storeError(r, terr))
		return
	}
	http.Redirect(w, r, d.oidcReturnURL(d.Assertions.Issue(userID, pending2FA)), http.StatusFound)
}
