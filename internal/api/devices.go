package api

import (
	"context"
	"errors"
	"net/http"

	"github.com/jonasthim/dilla/internal/server"
	"github.com/jonasthim/dilla/internal/store"
)

// CreateDevice is POST /v1/devices: [device_id, dsk_pub, tier, signer_tier,
// credential] → [device_id]. The device is always the session's own user's; a
// body cannot name another user, so there is nothing to authorise beyond the
// session itself.
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
	if err := d.Repo.CreateDevice(r.Context(), row); err != nil {
		if errors.Is(err, store.ErrConflict) {
			server.WriteError(w, server.WithStatus(http.StatusConflict,
				server.Errorf(server.CodeInvalidRequest, "device_id already exists")))
			return
		}
		server.WriteError(w, d.storeError(r, err))
		return
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

// PutDeviceList publishes a signed device list. The instance stores the blob
// and its signature and never interprets either: the list is signed by the
// user's SSK and verified by the recipients, so a server that could not forge
// one must not be trusted to validate one.
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
	row := store.DeviceListRow{
		UserID: userID, Version: req.Version, Blob: req.Blob,
		SSKSignature: req.SSKSignature, PrevHash: req.PrevHash, Created: d.Clock.Now().Unix(),
	}
	if err := d.Repo.PutDeviceList(r.Context(), row); err != nil {
		if errors.Is(err, store.ErrConflict) {
			// (user_id, version) is the primary key, so a repeat of a version
			// is a client that did not read its own latest list first.
			server.WriteError(w, server.WithStatus(http.StatusConflict,
				server.Errorf(server.CodeInvalidRequest, "device-list version %d already published", req.Version)))
			return
		}
		server.WriteError(w, d.storeError(r, err))
		return
	}
	d.noContent(w, r)
	if d.AfterDeviceList != nil {
		_ = http.NewResponseController(w).Flush()
		d.AfterDeviceList(context.WithoutCancel(r.Context()), userID)
	}
}

// GetDeviceList answers the newest list of any user: every member of a group
// needs to read every other member's list, so this route is not self-scoped.
func (d Deps) GetDeviceList(w http.ResponseWriter, r *http.Request) {
	if _, ok := session(r); !ok {
		server.WriteError(w, server.Errorf(server.CodeUnauthenticated, ""))
		return
	}
	userID, err := server.PathID(r, "user_id")
	if err != nil {
		server.WriteError(w, err)
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
