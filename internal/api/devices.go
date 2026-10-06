package api

import (
	"bytes"
	"context"
	"crypto/sha256"
	"errors"
	"math"
	"net/http"
	"strconv"

	"github.com/jonasthim/dilla/internal/auth"
	"github.com/jonasthim/dilla/internal/id"
	"github.com/jonasthim/dilla/internal/mlswasi"
	"github.com/jonasthim/dilla/internal/server"
	"github.com/jonasthim/dilla/internal/store"
)

// CreateDevice is POST /v1/devices: [device_id, dsk_pub, tier, signer_tier,
// credential] → [device_id]. The device is always the session's own user's; a
// body cannot name another user. Admission uses the same live-row cap, expiry,
// oldest-unlisted eviction and live-row hourly rate as assertion registration.
func (d Deps) CreateDevice(w http.ResponseWriter, r *http.Request) {
	sess, ok := session(r)
	if !ok {
		server.WriteError(w, server.Errorf(server.CodeUnauthenticated, ""))
		return
	}
	var req deviceRequest
	if err := server.DecodeBody(w, r, maxCBORBody, &req); err != nil {
		server.WriteError(w, err)
		return
	}
	if err := req.validate(); err != nil {
		server.WriteError(w, err)
		return
	}
	now := d.Clock.Now().Unix()
	row := store.DeviceRow{
		ID: req.DeviceID, UserID: sess.UserID, DSKPub: req.DSKPub, Tier: req.Tier,
		SignerTier: req.SignerTier, CredentialBlob: req.Credential, LastSeen: now, Created: now,
	}
	if d.Sessions.DeviceLists == nil {
		server.WriteError(w, server.Errorf(server.CodeUnauthenticated, ""))
		return
	}
	keys, listErr := d.Sessions.DeviceLists.ListedKeys(r.Context(), sess.UserID)
	noList := errors.Is(listErr, auth.ErrNoDeviceList)
	if noList {
		keys = nil
	} else if listErr != nil {
		server.WriteError(w, auth.ListError(listErr))
		return
	}
	var evicted id.ID
	err := d.Repo.Tx(r.Context(), func(tx store.Repository) error {
		var err error
		evicted, err = d.Sessions.AdmitDevice(r.Context(), tx, sess.UserID, keys, noList, now)
		if err != nil {
			return err
		}
		return tx.CreateDevice(r.Context(), row)
	})
	if err != nil {
		if errors.Is(err, store.ErrConflict) {
			server.WriteError(w, server.WithStatus(http.StatusConflict,
				server.Errorf(server.CodeInvalidRequest, "device_id already exists")))
			return
		}
		server.WriteError(w, d.storeError(r, err))
		return
	}
	if !evicted.IsZero() && d.Sessions.OnRevoke != nil {
		d.Sessions.OnRevoke(evicted)
	}
	d.write(w, r, http.StatusOK, []any{row.ID})
}

// ListDevices is GET /v1/devices →
// [[device_id, tier, signer_tier, verified_at|null, revoked_at|null, last_seen]].
func (d Deps) ListDevices(w http.ResponseWriter, r *http.Request) {
	sess, ok := session(r)
	if !ok {
		server.WriteError(w, server.Errorf(server.CodeUnauthenticated, ""))
		return
	}
	rows, err := d.Repo.ListDevicesByUser(r.Context(), sess.UserID)
	if err != nil {
		server.WriteError(w, d.storeError(r, err))
		return
	}
	out := make([]any, 0, len(rows))
	for _, row := range rows {
		out = append(out, []any{
			row.ID, uint64(row.Tier), uint64(row.SignerTier),
			nullableTime(row.VerifiedAt), nullableTime(row.RevokedAt), uint64(row.LastSeen), //nolint:gosec // G115: a unix second or row id this server wrote, never negative
		})
	}
	d.write(w, r, http.StatusOK, out)
}

// DeleteDevice is DELETE /v1/devices/{device_id} → 204. protocol/02 § Device
// sessions item 6: revoking a device MUST delete its session rows and close its
// gateway connections in the same operation, which is what
// auth.Sessions.RevokeDevice does — the rows in one transaction, the sockets
// through the OnRevoke hook the composition root wires to Deps.CloseGateway.
func (d Deps) DeleteDevice(w http.ResponseWriter, r *http.Request) {
	sess, ok := session(r)
	if !ok {
		server.WriteError(w, server.Errorf(server.CodeUnauthenticated, ""))
		return
	}
	deviceID, err := server.PathID(r, "device_id")
	if err != nil {
		server.WriteError(w, err)
		return
	}
	row, err := d.Repo.GetDevice(r.Context(), deviceID)
	if err != nil {
		server.WriteError(w, d.storeError(r, err))
		return
	}
	// A device of another user answers 404, not 403: whether an identifier
	// exists is not something one account tells another.
	if row.UserID != sess.UserID {
		server.WriteError(w, server.Errorf(server.CodeNotFound, "not found"))
		return
	}
	if d.Sessions.DeviceLists == nil {
		server.WriteError(w, server.Errorf(server.CodeInternal, "device-list lookup is not wired"))
		return
	}
	keys, listErr := d.Sessions.DeviceLists.ListedKeys(r.Context(), sess.UserID)
	if listErr != nil && !errors.Is(listErr, auth.ErrNoDeviceList) {
		server.WriteError(w, auth.ListError(listErr))
		return
	}
	for _, key := range keys {
		if bytes.Equal(key, row.DSKPub) {
			server.WriteError(w, server.WithStatus(http.StatusConflict,
				server.Errorf(server.CodeInvalidRequest, "a listed device is revoked by a signed device list")))
			return
		}
	}
	if err := d.Sessions.RevokeDevice(r.Context(), deviceID); err != nil {
		server.WriteError(w, d.storeError(r, err))
		return
	}
	d.noContent(w, r)
}

// deviceListRequest is PUT /v1/users/{user_id}/device-list's body:
// [version, blob, ssk_signature(64), prev_hash(32)].
type deviceListRequest struct {
	_            struct{} `cbor:",toarray"`
	Version      uint64
	Blob         []byte
	SSKSignature []byte
	PrevHash     []byte
}

// PutDeviceList publishes a signed device list. The instance verifies the outer elements against
// the blob in Go, the signature and user in the guest, and the version and hash chain against the
// stored newest. It revokes named devices and deletes their sessions in the storing transaction;
// after commit it closes their sockets and asks the delivery service to remove their leaves.
func (d Deps) PutDeviceList(w http.ResponseWriter, r *http.Request) {
	sess, ok := session(r)
	if !ok {
		server.WriteError(w, server.Errorf(server.CodeUnauthenticated, ""))
		return
	}
	userID, err := server.PathID(r, "user_id")
	if err != nil {
		server.WriteError(w, err)
		return
	}
	if userID != sess.UserID {
		server.WriteError(w, server.Errorf(server.CodeForbidden, "a device list is published by its own user"))
		return
	}
	var req deviceListRequest
	if err := server.DecodeBody(w, r, maxCBORBody, &req); err != nil {
		server.WriteError(w, err)
		return
	}
	if len(req.SSKSignature) != sigLen || len(req.PrevHash) != 32 || len(req.Blob) == 0 {
		server.WriteError(w, server.Errorf(server.CodeInvalidRequest,
			"ssk_signature is 64 bytes, prev_hash is 32 and blob is not empty"))
		return
	}
	version, prevHash, sig, ok := listOuter(req.Blob)
	if !ok || version != req.Version || !bytes.Equal(prevHash, req.PrevHash) || !bytes.Equal(sig, req.SSKSignature) {
		server.WriteError(w, server.Errorf(server.CodeInvalidRequest, "device list elements disagree"))
		return
	}
	if d.DeviceLists == nil {
		err := server.Errorf(server.CodeInternal, "device-list verifier is not wired")
		d.logf(r, "api: device list", "err", err)
		server.WriteError(w, err)
		return
	}
	user, err := d.Repo.GetUser(r.Context(), userID)
	if err != nil {
		server.WriteError(w, d.storeError(r, err))
		return
	}
	entries, err := d.DeviceLists.Verify(r.Context(), req.Blob, user.SSKPub, userID)
	if err != nil {
		var abiErr *mlswasi.ABIError
		if errors.As(err, &abiErr) && abiErr.Code == "E_CREDENTIAL" {
			server.WriteError(w, server.Errorf(server.CodeInvalidRequest, "device list does not verify"))
			return
		}
		d.logf(r, "api: device list verification", "err", err)
		server.WriteError(w, server.Errorf(server.CodeInternal, ""))
		return
	}
	ctx := r.Context()
	row := store.DeviceListRow{
		UserID: userID, Version: req.Version, Blob: req.Blob,
		SSKSignature: req.SSKSignature, PrevHash: req.PrevHash, Created: d.Clock.Now().Unix(),
	}
	versionConflict := func() error {
		return server.WithStatus(http.StatusConflict,
			server.Errorf(server.CodeInvalidRequest, "device-list version %d is not the next version", req.Version))
	}
	var revoked []id.ID
	err = d.Repo.Tx(ctx, func(tx store.Repository) error {
		newest, err := tx.GetDeviceList(ctx, userID)
		switch {
		case errors.Is(err, store.ErrNotFound):
			if req.Version != 1 || !bytes.Equal(req.PrevHash, make([]byte, 32)) {
				return versionConflict()
			}
		case err != nil:
			return err
		default:
			sum := sha256.Sum256(newest.Blob)
			if req.Version != newest.Version+1 || !bytes.Equal(req.PrevHash, sum[:]) {
				return versionConflict()
			}
		}
		if err := tx.PutDeviceList(ctx, row); err != nil {
			if errors.Is(err, store.ErrConflict) {
				return versionConflict()
			}
			return err
		}
		for _, entry := range entries {
			if !entry.Revoked || len(entry.DeviceID) != 16 {
				continue
			}
			var dev id.ID
			copy(dev[:], entry.DeviceID)
			device, err := tx.GetDevice(ctx, dev)
			if errors.Is(err, store.ErrNotFound) {
				continue
			}
			if err != nil {
				return err
			}
			if device.UserID != userID || device.RevokedAt != nil {
				continue
			}
			if err := tx.RevokeDevice(ctx, dev, row.Created); err != nil {
				return err
			}
			if _, err := tx.DeleteSessionsByDevice(ctx, dev); err != nil {
				return err
			}
			revoked = append(revoked, dev)
		}
		return nil
	})
	if err != nil {
		if errors.Is(err, store.ErrConflict) {
			server.WriteError(w, versionConflict())
			return
		}
		server.WriteError(w, d.storeError(r, err))
		return
	}
	if d.Sessions != nil && d.Sessions.OnRevoke != nil {
		for _, dev := range revoked {
			d.Sessions.OnRevoke(dev)
		}
	}
	d.noContent(w, r)
	if d.AfterDeviceList != nil {
		_ = http.NewResponseController(w).Flush()
		d.AfterDeviceList(context.WithoutCancel(r.Context()), userID, revoked)
	}
}

// GetDeviceList permits enrolled sessions to read any user and pending sessions only their own.
func (d Deps) GetDeviceList(w http.ResponseWriter, r *http.Request) {
	sess, ok := session(r)
	if !ok {
		server.WriteError(w, server.Errorf(server.CodeUnauthenticated, ""))
		return
	}
	userID, err := server.PathID(r, "user_id")
	if err != nil {
		server.WriteError(w, err)
		return
	}
	if sess.Scope == auth.ScopePending && sess.UserID != userID {
		server.WriteError(w, server.Errorf(server.CodeForbidden, "a pending session reads only its own device list"))
		return
	}
	if r.URL.Query().Has("after") {
		after, err := strconv.ParseUint(r.URL.Query().Get("after"), 10, 64)
		if err != nil || after > math.MaxInt64 {
			server.WriteError(w, server.Errorf(server.CodeInvalidRequest, "after must be a decimal uint"))
			return
		}
		rows, err := d.Repo.ListDeviceListsAfter(r.Context(), userID, after, deviceListHistoryPage)
		if err != nil {
			server.WriteError(w, d.storeError(r, err))
			return
		}
		out := make([]any, 0, len(rows))
		for _, row := range rows {
			out = append(out, []any{row.Version, row.Blob, row.SSKSignature, row.PrevHash})
		}
		d.write(w, r, http.StatusOK, out)
		return
	}
	row, err := d.Repo.GetDeviceList(r.Context(), userID)
	if err != nil {
		server.WriteError(w, d.storeError(r, err))
		return
	}
	d.write(w, r, http.StatusOK, []any{row.Version, row.Blob, row.SSKSignature, row.PrevHash})
}

// nullableTime renders a nullable unix second as a CBOR uint or null.
func nullableTime(v *int64) any {
	if v == nil {
		return nil
	}
	return uint64(*v) //nolint:gosec // G115: a unix second or row id this server wrote, never negative
}
