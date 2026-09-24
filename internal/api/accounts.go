package api

import (
	"context"
	"errors"
	"net/http"
	"strconv"

	"github.com/jonasthim/dilla/internal/auth"
	"github.com/jonasthim/dilla/internal/id"
	"github.com/jonasthim/dilla/internal/server"
	"github.com/jonasthim/dilla/internal/store"
)

// createAccountRequest is POST /v1/accounts' body, a fixed-position array
// (interfaces.md §5.1):
//
//	[code, username, display, umk_pub(32), ssk_pub(32), sig_umk_ssk(64),
//	 password|null, device]
type createAccountRequest struct {
	_         struct{} `cbor:",toarray"`
	Code      string
	Username  string
	Display   string
	UMKPub    []byte
	SSKPub    []byte
	SigUMKSSK []byte
	Password  *string
	Device    deviceRequest
}

// deviceRequest is the device sub-array of the registration body and the whole
// body of POST /v1/devices: [device_id, dsk_pub(32), tier, signer_tier,
// credential].
type deviceRequest struct {
	_          struct{} `cbor:",toarray"`
	DeviceID   id.ID
	DSKPub     []byte
	Tier       uint8
	SignerTier uint8
	Credential []byte
}

const (
	umkPubLen   = 32
	sskPubLen   = 32
	sigLen      = 64
	dskPubLen   = 32
	tierNative  = 0
	tierBrowser = 1
	kindHuman   = 0
	maxCredBlob = 8 << 10
)

func (r deviceRequest) validate() error {
	if r.DeviceID.IsZero() {
		return server.Errorf(server.CodeInvalidRequest, "device_id is the all-zero identifier")
	}
	if len(r.DSKPub) != dskPubLen {
		return server.Errorf(server.CodeInvalidRequest, "dsk_pub is %d bytes, want %d", len(r.DSKPub), dskPubLen)
	}
	if r.Tier != tierNative && r.Tier != tierBrowser {
		return server.Errorf(server.CodeInvalidRequest, "tier %d is not 0 (native) or 1 (browser)", r.Tier)
	}
	if r.SignerTier != tierNative && r.SignerTier != tierBrowser {
		return server.Errorf(server.CodeInvalidRequest, "signer_tier %d is not 0 or 1", r.SignerTier)
	}
	if len(r.Credential) == 0 || len(r.Credential) > maxCredBlob {
		return server.Errorf(server.CodeInvalidRequest, "credential is %d bytes, want 1 to %d", len(r.Credential), maxCredBlob)
	}
	return nil
}

// CreateAccount registers an account, its first device and that device's first
// session. It runs in two phases, and the split is deliberate.
//
// BEFORE the transaction: the handle and display name are canonicalised, the
// invite code is turned into its candidate hashes, and a supplied password is
// hashed. Argon2id at the configured 19 456 KiB / t=2 takes tens of
// milliseconds and allocates ~19 MiB, and SQLite's write pool is ONE connection
// with _txlock=immediate — hashing inside the transaction would hold the
// instance's only write lock for the whole of it, and an unauthenticated route
// could pin that lock at will.
//
// INSIDE one Repo.Tx: RedeemInvite (whose WHERE clause IS the concurrency
// control, so 64 racing registrations on a one-use invite produce exactly one
// account), CreateUser, CreateDevice, the password credential, and the first
// device session. Nothing outside the transaction writes.
func (d Deps) CreateAccount(w http.ResponseWriter, r *http.Request) {
	var req createAccountRequest
	if err := server.DecodeBody(w, r, maxCBORBody, &req); err != nil {
		server.WriteError(w, err)
		return
	}
	ctx := r.Context()

	handle, err := auth.NormalizeHandle(req.Username)
	if err != nil {
		server.WriteError(w, server.Errorf(server.CodeInvalidRequest, "username: %v", err))
		return
	}
	display, err := auth.NormalizeDisplay(req.Display)
	if err != nil {
		server.WriteError(w, server.Errorf(server.CodeInvalidRequest, "display: %v", err))
		return
	}
	if len(req.UMKPub) != umkPubLen || len(req.SSKPub) != sskPubLen || len(req.SigUMKSSK) != sigLen {
		server.WriteError(w, server.Errorf(server.CodeInvalidRequest,
			"umk_pub, ssk_pub and sig_umk_ssk are 32, 32 and 64 bytes"))
		return
	}
	if err := req.Device.validate(); err != nil {
		server.WriteError(w, err)
		return
	}

	// Registration mode. `closed` refuses outright; `open` makes the invite
	// optional; `invite`, the default, requires one.
	mode := d.Registration.Mode
	if mode == "closed" {
		server.WriteError(w, server.Errorf(server.CodeForbidden, "this instance is not accepting registrations"))
		return
	}
	var candidates []string
	if req.Code != "" {
		candidates, err = auth.CanonicalizeInviteCode(req.Code)
		if err != nil {
			server.WriteError(w, server.Errorf(server.CodeInviteInvalid, "invite code: %v", err))
			return
		}
	} else if mode != "open" {
		server.WriteError(w, server.Errorf(server.CodeInviteInvalid, "this instance is invite-only"))
		return
	}

	// The password hash, outside the transaction. See the doc comment.
	phc := ""
	if req.Password != nil && *req.Password != "" {
		if d.Hasher == nil {
			server.WriteError(w, server.Errorf(server.CodeInvalidRequest,
				"this instance does not accept a password at registration"))
			return
		}
		phc, err = d.Hasher.Hash(ctx, *req.Password)
		if err != nil {
			server.WriteError(w, err)
			return
		}
	}

	now := d.Clock.Now().Unix()
	user := store.UserRow{
		ID: id.New(), Username: handle, Display: display, Kind: kindHuman,
		UMKPub: req.UMKPub, SSKPub: req.SSKPub, SigUMKSSK: req.SigUMKSSK, Created: now,
	}
	device := store.DeviceRow{
		ID: req.Device.DeviceID, UserID: user.ID, DSKPub: req.Device.DSKPub,
		Tier: req.Device.Tier, SignerTier: req.Device.SignerTier,
		CredentialBlob: req.Device.Credential, LastSeen: now, Created: now,
	}
	var token auth.Token
	err = d.Repo.Tx(ctx, func(tx store.Repository) error {
		if len(candidates) > 0 {
			invite, rerr := redeem(ctx, tx, candidates, now)
			if rerr != nil {
				return rerr
			}
			// users.flags bit 0 is the instance admin, and it is set from the
			// redeemed invite's grants_admin and nowhere else. Without this the
			// bootstrap invite `dillad init` mints grants nothing and no
			// instance admin ever exists.
			if invite.GrantsAdmin == 1 {
				user.Flags |= store.UserFlagInstanceAdmin
			}
		}
		if err := tx.CreateUser(ctx, user); err != nil {
			return err
		}
		if err := tx.CreateDevice(ctx, device); err != nil {
			return err
		}
		if phc != "" {
			if err := tx.PutPasswordCredential(ctx, user.ID, phc, now); err != nil {
				return err
			}
		}
		var serr error
		token, serr = d.Sessions.NewDeviceSession(ctx, tx, user.ID, device.ID, device.Tier)
		return serr
	})
	if err != nil {
		server.WriteError(w, d.registrationError(r, err))
		return
	}
	d.write(w, r, http.StatusOK, []any{user.ID, device.ID, token.Token, uint64(token.Expires)})
}

// redeem spends the first candidate the instance knows. CanonicalizeInviteCode
// returns at most 16 of them — a typed `1` is either an I or an L — and each is
// one indexed UPDATE, so the cross product is bounded before it reaches SQL.
func redeem(ctx context.Context, tx store.Repository, candidates []string, now int64) (store.InviteRow, error) {
	for _, c := range candidates {
		invite, err := tx.RedeemInvite(ctx, auth.HashInviteCode(c), now)
		if err == nil {
			return invite, nil
		}
		if !errors.Is(err, store.ErrExhausted) && !errors.Is(err, store.ErrNotFound) {
			return store.InviteRow{}, err
		}
	}
	return store.InviteRow{}, store.ErrExhausted
}

// registrationError maps a store failure to the one error vocabulary. The two
// mappings that matter are exact: an exhausted, expired, revoked or unknown
// invite is 410 E_INVITE_INVALID, and a taken username is E_INVALID_REQUEST at
// 409 — not at that code's default 400, and never E_GROUP_EXISTS, which is the
// delivery service's group-registration code and has no business on an account
// route.
func (d Deps) registrationError(r *http.Request, err error) error {
	switch {
	case errors.Is(err, store.ErrExhausted), errors.Is(err, store.ErrNotFound):
		return server.Errorf(server.CodeInviteInvalid, "the invite is spent, expired, revoked or unknown")
	case errors.Is(err, store.ErrConflict):
		return server.WithStatus(http.StatusConflict,
			server.Errorf(server.CodeInvalidRequest, "username taken"))
	}
	var e *server.Error
	if errors.As(err, &e) {
		return e
	}
	d.logf(r, "api: registration failed", "err", err)
	return server.Errorf(server.CodeInternal, "")
}

// GetMe answers [user_id, username, display, kind, flags, created].
func (d Deps) GetMe(w http.ResponseWriter, r *http.Request) {
	sess, ok := session(r)
	if !ok {
		server.WriteError(w, server.Errorf(server.CodeUnauthenticated, ""))
		return
	}
	u, err := d.Repo.GetUser(r.Context(), sess.UserID)
	if err != nil {
		server.WriteError(w, d.storeError(r, err))
		return
	}
	d.write(w, r, http.StatusOK, []any{
		u.ID, u.Username, u.Display, uint64(u.Kind), u.Flags, uint64(u.Created),
	})
}

// PatchMe is [display|null, status_msg|null] → 204.
//
// It answers 501 and writes nothing. The body is validated, so a client learns
// immediately that its display name is too long or carries a bidi control, but
// there is nowhere to put the result: interfaces.md §4.1 declares no profile
// update on store.Accounts (CreateUser, GetUser, GetUserByUsername, ListUsers,
// SetUserDisabled, TombstoneUser — and internal/store/contract_test.go asserts
// exactly that list), and `users` has no status column at all. Inventing a
// store method here would rename a contract another task owns; answering 204
// and discarding the change would be worse than refusing. The route lands when
// the store gains the method.
func (d Deps) PatchMe(w http.ResponseWriter, r *http.Request) {
	var req struct {
		_         struct{} `cbor:",toarray"`
		Display   *string
		StatusMsg *string
	}
	if err := server.DecodeBody(w, r, maxCBORBody, &req); err != nil {
		server.WriteError(w, err)
		return
	}
	if req.Display != nil {
		if _, err := auth.NormalizeDisplay(*req.Display); err != nil {
			server.WriteError(w, server.Errorf(server.CodeInvalidRequest, "display: %v", err))
			return
		}
	}
	server.WriteError(w, notImplemented("profile updates need a store method interfaces.md §4.1 does not declare"))
}

// DeleteMe tombstones the account: the row keeps its username so it can never
// be re-registered (R36), every key column is zeroed by the store's own
// TombstoneUser, the account is disabled and every session of every device is
// deleted with the gateway told to close their sockets.
//
// It is a step-up route (interfaces.md §5.1), and the step-up this part of the
// plan can enforce is the session's own freshness: the session must have been
// established within auth.session.reauth_window. Re-verifying a credential —
// the password, a passkey or a TOTP code — needs task 9's machinery and
// replaces this check when it lands.
//
// Two halves of "delete" are NOT here, because part 1a has no table for either:
// removing the user from every MLS group (task 19 onward) and purging the
// credential rows (store.Auth declares no delete for a password, a TOTP secret,
// a recovery code or a passkey). The tombstone disables the account, so every
// one of those credentials stops authenticating immediately.
func (d Deps) DeleteMe(w http.ResponseWriter, r *http.Request) {
	sess, ok := session(r)
	if !ok {
		server.WriteError(w, server.Errorf(server.CodeUnauthenticated, ""))
		return
	}
	ctx := r.Context()
	now := d.Clock.Now().Unix()
	row, err := d.Repo.GetSessionByHash(ctx, sess.TokenHash, now)
	if err != nil {
		server.WriteError(w, server.Errorf(server.CodeUnauthenticated, ""))
		return
	}
	// Fail CLOSED on a missing Config. Skipping the freshness check because the
	// dependency that carries the window is nil would let any live enrolled
	// session, however old, tombstone the account and revoke every device —
	// and a handler test that built Deps without a Config would pass while
	// exercising no gate at all.
	if d.Config == nil {
		d.logf(r, "api: DELETE /v1/accounts/me has no config, so no step-up window")
		server.WriteError(w, server.Errorf(server.CodeInternal, "the step-up window is not wired"))
		return
	}
	if window := int64(d.Config.Auth.Session.ReauthWindow.Value().Seconds()); now-row.Created > window {
		server.WriteError(w, server.Errorf(server.CodeForbidden,
			"deleting an account needs a session established in the last %d seconds", window))
		return
	}
	if err := d.Repo.Tx(ctx, func(tx store.Repository) error {
		return tx.TombstoneUser(ctx, sess.UserID, now)
	}); err != nil {
		server.WriteError(w, d.storeError(r, err))
		return
	}
	// RevokeUser disables the account, deletes every session and closes every
	// socket; it runs after the tombstone so a failure leaves the account
	// unusable rather than deleted-but-live.
	if err := d.Sessions.RevokeUser(ctx, sess.UserID); err != nil {
		server.WriteError(w, d.storeError(r, err))
		return
	}
	d.noContent(w, r)
}

// storeError maps a bare store failure. A not-found is 404; anything else is an
// E_INTERNAL whose cause is logged and never sent.
func (d Deps) storeError(r *http.Request, err error) error {
	switch {
	case errors.Is(err, store.ErrNotFound):
		return server.Errorf(server.CodeNotFound, "not found")
	case errors.Is(err, store.ErrConflict):
		return server.Errorf(server.CodeInvalidRequest, "conflict")
	}
	var e *server.Error
	if errors.As(err, &e) {
		return e
	}
	d.logf(r, "api: store", "err", err)
	return server.Errorf(server.CodeInternal, "")
}

// write encodes v and logs a write failure rather than swallowing it: the
// status is already on the wire, so there is nothing left to tell the client.
func (d Deps) write(w http.ResponseWriter, r *http.Request, status int, v any) {
	d.generation(w)
	if err := server.WriteCBOR(w, status, v); err != nil {
		d.logf(r, "api: write body", "err", err)
	}
}

func (d Deps) noContent(w http.ResponseWriter, _ *http.Request) {
	d.generation(w)
	w.WriteHeader(http.StatusNoContent)
}

// generation stamps X-Dilla-Generation so an HTTP-only client notices a restore
// without reconnecting the gateway (R29). The composition root will stamp it on
// every response, refusals included, once it wraps the mux; doing it here too
// costs nothing and keeps a handler tested in isolation honest.
func (d Deps) generation(w http.ResponseWriter) {
	if w.Header().Get("X-Dilla-Generation") == "" {
		w.Header().Set("X-Dilla-Generation", strconv.FormatUint(d.Instance.Generation, 10))
	}
}
