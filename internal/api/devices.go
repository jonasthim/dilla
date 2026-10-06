package api

import (
	"bytes"
	"context"
	"errors"
	"net/http"
	"slices"

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
		var abi *mlswasi.ABIError
		if errors.As(listErr, &abi) && abi.Code == "E_CREDENTIAL" {
			server.WriteError(w, server.Errorf(server.CodeUnauthenticated, ""))
		} else {
			server.WriteError(w, server.Unavailable(1000, "device list unavailable"))
		}
		return
	}
	var evicted id.ID
	err := d.Repo.Tx(r.Context(), func(tx store.Repository) error {
		if err := tx.LockUserForDeviceRegistration(r.Context(), sess.UserID); err != nil {
			return err
		}
		rows, err := tx.ListDevicesByUser(r.Context(), sess.UserID)
		if err != nil {
			return err
		}
		listed := make([]id.ID, 0, len(rows))
		for _, device := range rows {
			if noList {
				listed = append(listed, device.ID)
				continue
			}
			for _, key := range keys {
				if bytes.Equal(key, device.DSKPub) {
					listed = append(listed, device.ID)
					break
				}
			}
		}
		cutoff := now - 86399
		for _, device := range rows {
			if device.RevokedAt == nil && device.Created < cutoff && !slices.Contains(listed, device.ID) {
				if err := tx.RevokeDevice(r.Context(), device.ID, now); err != nil {
					return err
				}
				if _, err := tx.DeleteSessionsByDevice(r.Context(), device.ID); err != nil {
					return err
				}
			}
		}
		live, err := tx.CountLiveDevicesByUser(r.Context(), sess.UserID)
		if err != nil {
			return err
		}
		if live >= int64(d.Config.Auth.Session.MaxDevicesPerUser) {
			for _, device := range rows {
				if device.RevokedAt == nil && device.Created >= cutoff && !slices.Contains(listed, device.ID) && evicted.IsZero() {
					evicted = device.ID
				}
			}
			if evicted.IsZero() {
				return server.Errorf(server.CodeForbidden, "device cap reached")
			}
			if err := tx.RevokeDevice(r.Context(), evicted, now); err != nil {
				return err
			}
			if _, err := tx.DeleteSessionsByDevice(r.Context(), evicted); err != nil {
				return err
			}
		}
		creations, err := tx.ListLiveDeviceCreationsSince(r.Context(), sess.UserID, listed, now-3599, cutoff)
		if err != nil {
			return err
		}
		if len(creations) >= d.Config.Auth.Session.EnrolmentsPerHour {
			wait := creations[len(creations)-d.Config.Auth.Session.EnrolmentsPerHour] + 3600 - now
			return server.RateLimited(uint64(wait) * 1000) //nolint:gosec // bounded by the hourly window
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
