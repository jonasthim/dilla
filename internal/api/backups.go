// Package api serves the two header objects of protocol/06 ("Header") at /v1/backups (protocol/09 § Backups).
// The root object is written once (F3), the state object is replaced; both are stored
// content-addressed in the blob store and read back by the user's own enrolled and pending sessions.
package api

import (
	"bytes"
	"context"
	"crypto/sha256"
	"errors"
	"io"
	"net/http"

	"github.com/fxamacker/cbor/v2"

	"github.com/jonasthim/dilla/internal/blob"
	"github.com/jonasthim/dilla/internal/id"
	"github.com/jonasthim/dilla/internal/server"
	"github.com/jonasthim/dilla/internal/store"
)

const (
	rootObjectLen       = 103
	maxRootBody         = 256
	maxStateBody        = 1<<20 + 64
	minBackupCiphertext = 16
)

var errRootStored = errors.New("api: a different root object is stored")

func backupPath(r *http.Request) (kind int32, limit int64, err error) {
	if r.PathValue("chunk_seq") != "0" {
		return 0, 0, server.Errorf(server.CodeNotFound, "no such backup")
	}
	switch r.PathValue("kind") {
	case "0":
		return 0, maxRootBody, nil
	case "1":
		return 1, maxStateBody, nil
	default:
		return 0, 0, server.Errorf(server.CodeNotFound, "no such backup")
	}
}

func backupObject(raw cbor.RawMessage, kind int32) ([]byte, error) {
	items, err := decodeArray(raw)
	if err != nil || len(items) != 1 {
		return nil, server.Errorf(server.CodeInvalidRequest, "body is [object]")
	}
	object, err := decodeBytes(items[0])
	if err != nil {
		return nil, server.Errorf(server.CodeInvalidRequest, "body is [object]")
	}
	parts, err := decodeArray(object)
	if err != nil || len(parts) != 3 {
		return nil, server.Errorf(server.CodeInvalidRequest, "object is not a stored header object")
	}
	version, versionErr := decodeUint(parts[0])
	nonce, nonceErr := decodeBytes(parts[1])
	ciphertext, ciphertextErr := decodeBytes(parts[2])
	if versionErr != nil || version != 1 || nonceErr != nil || len(nonce) != 12 || ciphertextErr != nil || len(ciphertext) < minBackupCiphertext {
		return nil, server.Errorf(server.CodeInvalidRequest, "object is not a stored header object")
	}
	if kind == 0 && len(object) != rootObjectLen {
		return nil, server.Errorf(server.CodeInvalidRequest, "a root object is 103 bytes")
	}
	return object, nil
}

// PutBackup accepts one sealed object and stores its content address before recording its row.
func (d Deps) PutBackup(w http.ResponseWriter, r *http.Request) {
	sess, ok := session(r)
	if !ok {
		server.WriteError(w, server.Errorf(server.CodeUnauthenticated, ""))
		return
	}
	kind, limit, err := backupPath(r)
	if err != nil {
		server.WriteError(w, err)
		return
	}
	if d.Blobs == nil || d.Config == nil {
		d.logf(r, "api: backup store not wired")
		server.WriteError(w, server.Errorf(server.CodeInternal, "the backup store is not wired"))
		return
	}
	// The root (kind 0) spends the blob upload meter before a byte of the body is read, exactly as
	// the attachment PUT does (security review F3); the reservation is the body cap or the announced
	// length, and every byte read spends the day's budget whatever happens to the object. The state
	// object (kind 1) does not: it spends only the device session's write bucket the route mounts
	// (branch review BACKUPS-RECOVERY-01). On the user's shared meter a stolen session of the same
	// user kept the bucket empty at its own device rate, and the owner's state PUT, which revoking
	// another device starts with, answered 429 for as long as the thief kept at it. Instead it
	// spends the device's own daily byte budget (StateMeter, keyed by the session's device), which
	// with the immediate deletion of the replaced object below bounds what one device can make the
	// instance read and write through the route.
	meter, meterKey := d.UploadMeter, sess.UserID
	if kind == 1 {
		meter, meterKey = d.StateMeter, sess.DeviceID
	}
	reserve := limit
	if r.ContentLength >= 0 && r.ContentLength < reserve {
		reserve = r.ContentLength
	}
	held, err := meter.begin(meterKey, reserve)
	if err != nil {
		server.WriteError(w, err)
		return
	}
	counted := &countingReader{r: r.Body}
	r.Body = struct {
		io.Reader
		io.Closer
	}{counted, r.Body}
	var raw cbor.RawMessage
	err = server.DecodeBody(w, r, limit, &raw)
	meter.settle(meterKey, held, counted.n)
	if err != nil {
		server.WriteError(w, err)
		return
	}
	object, err := backupObject(raw, kind)
	if err != nil {
		server.WriteError(w, err)
		return
	}
	ctx := r.Context()
	sum := sha256.Sum256(object)
	blobID := sum[:]
	// The blob routes' tombstone gate: content addressing would otherwise let anyone holding the
	// ciphertext of an administrator-purged blob store it again as a backup object.
	if err := refuseTombstoned(ctx, d.Repo, blobID); err != nil {
		server.WriteError(w, d.storeError(r, err))
		return
	}
	if maxBytes := d.Config.Blobs.StoreMaxBytes; maxBytes > 0 {
		_, err := d.Repo.GetBlob(ctx, blobID)
		switch {
		case errors.Is(err, store.ErrNotFound):
			used, err := d.Repo.InstanceBlobBytes(ctx)
			if err != nil {
				server.WriteError(w, d.storeError(r, err))
				return
			}
			if used > maxBytes-int64(len(object)) {
				server.WriteError(w, server.Errorf(server.CodeStorageFull, "the instance's storage is full"))
				return
			}
		case err != nil:
			server.WriteError(w, d.storeError(r, err))
			return
		}
	}
	n, created, err := d.Blobs.Put(ctx, blobID, bytes.NewReader(object), int64(len(object)))
	if err != nil {
		d.logf(r, "api: store backup bytes", "err", err)
		server.WriteError(w, server.Errorf(server.CodeInternal, ""))
		return
	}
	now := d.Clock.Now().Unix()
	status := http.StatusCreated
	var replaced []byte // the replaced state object's bytes, deleted from the table, to unlink
	err = d.Repo.Tx(ctx, func(tx store.Repository) error {
		replaced = nil
		if err := tx.PutBlob(ctx, store.BlobRow{
			BlobID: blobID, Size: uint64(n), //nolint:gosec // G115: n is a byte count returned by blob.Store.Put, never negative
			StorageRef: blob.StorageRef(d.Config.Blobs.Backend, blobID), Created: now,
		}); err != nil {
			return err
		}
		// The tombstone again, inside the transaction that records the object: a purge that
		// committed after the first check must not be undone by this upload (blobs.go, fix wave I9).
		tomb, err := tx.GetBlobTombstone(ctx, blobID)
		if err != nil {
			return err
		}
		if tomb {
			return errTombstoned
		}
		if err := tx.ClearBlobUnreferenced(ctx, blobID); err != nil {
			return err
		}
		row := store.BackupRow{UserID: sess.UserID, Kind: uint64(kind), //nolint:gosec // G115: backupPath returns only 0 or 1
			DeviceID: id.ID{}, ChunkSeq: 0, BlobID: blobID, Created: now}
		if kind == 0 {
			if err := tx.InsertBackup(ctx, row); errors.Is(err, store.ErrConflict) {
				return errRootStored
			} else if err != nil {
				return err
			}
			return d.withinQuota(ctx, tx, sess.UserID)
		}
		prev, err := tx.GetBackup(ctx, sess.UserID, 1, id.ID{}, 0)
		// noLarger: the replacement is no larger than the state object it replaces.
		noLarger := false
		if errors.Is(err, store.ErrNotFound) {
			prev = store.BackupRow{}
		} else if err != nil {
			return err
		} else {
			status = http.StatusOK
			prevBlob, err := tx.GetBlob(ctx, prev.BlobID)
			if err != nil {
				return err
			}
			noLarger = uint64(n) <= prevBlob.Size //nolint:gosec // G115: n is a nonnegative byte count
		}
		if err := tx.PutBackup(ctx, row); err != nil {
			return err
		}
		// The quota check for a replacement is the delta over the object it replaces (branch review
		// BACKUPS-RECOVERY-01): one no larger never fails it, even for a user already at or past the
		// quota, so re-sealing the state object can never be refused for storage. A larger one is
		// checked after the upsert, so the replaced object has left the count.
		if !noLarger {
			if err := d.withinQuota(ctx, tx, sess.UserID); err != nil {
				return err
			}
		}
		if prev.BlobID != nil && !bytes.Equal(prev.BlobID, blobID) {
			refers, err := tx.BackupRefersToBlob(ctx, prev.BlobID)
			if err != nil || refers {
				return err
			}
			refs, err := tx.CountBlobRefs(ctx, prev.BlobID)
			if err != nil {
				return err
			}
			if refs > 0 {
				return tx.MarkBlobUnreferenced(ctx, prev.BlobID, now)
			}
			// Nothing else names the replaced bytes: their row goes in this transaction and their
			// file right after the commit, never through blobs.gc_grace (branch review
			// BACKUPS-RECOVERY-01 as amended). Kept for the grace, every distinct replacement at
			// the device's write rate stayed on disk a day, uncounted by any quota.
			if err := tx.DeleteBlob(ctx, prev.BlobID); err != nil && !errors.Is(err, store.ErrNotFound) {
				return err
			}
			replaced = prev.BlobID
		}
		return nil
	})
	if err != nil {
		if errors.Is(err, errTombstoned) {
			// The purge's own unlink may have run before this upload wrote the file; purged bytes
			// stay removed, so they go now, row or none.
			if derr := d.Blobs.Delete(blobID); derr != nil {
				d.logf(r, "api: remove purged bytes a backup rewrote", "err", derr)
			}
			server.WriteError(w, errPruned())
			return
		}
		if created {
			d.orphanBackup(ctx, blobID, n, now)
		}
		if errors.Is(err, errQuota) {
			server.WriteError(w, errStorageFull())
			return
		}
		if errors.Is(err, errRootStored) {
			existing, readErr := d.Repo.GetBackup(ctx, sess.UserID, 0, id.ID{}, 0)
			if readErr != nil {
				server.WriteError(w, d.storeError(r, readErr))
				return
			}
			if bytes.Equal(existing.BlobID, blobID) {
				d.write(w, r, http.StatusOK, []any{blobID, uint64(n)}) //nolint:gosec // G115: n is a nonnegative byte count
				return
			}
			server.WriteError(w, server.WithStatus(http.StatusConflict, server.Errorf(server.CodeInvalidRequest, "root object already stored")))
			return
		}
		server.WriteError(w, d.storeError(r, err))
		return
	}
	if replaced != nil {
		d.unlinkReplaced(ctx, replaced)
	}
	d.write(w, r, status, []any{blobID, uint64(n)}) //nolint:gosec // G115: n is a nonnegative byte count
}

// unlinkReplaced removes the file of a replaced state object whose row the committed transaction
// deleted. A concurrent PUT of the same bytes may have recorded them again since; their row is
// then back and the file stays.
func (d Deps) unlinkReplaced(ctx context.Context, blobID []byte) {
	ctx = context.WithoutCancel(ctx)
	if _, err := d.Repo.GetBlob(ctx, blobID); !errors.Is(err, store.ErrNotFound) {
		return
	}
	if err := d.Blobs.Delete(blobID); err != nil && !errors.Is(err, blob.ErrNotFound) {
		d.Log.ErrorContext(ctx, "unlink a replaced state object", "err", err)
	}
}

// withinQuota is the blob route's exact quota check, run inside the transaction that records the
// object: backup objects count toward blobs.quota_bytes_per_user with the user's attachments, each
// distinct blob once (store.UserBlobBytes).
func (d Deps) withinQuota(ctx context.Context, tx store.Repository, userID id.ID) error {
	quota := d.Config.Blobs.QuotaBytesPerUser
	if quota <= 0 {
		return nil
	}
	used, err := tx.UserBlobBytes(ctx, userID)
	if err != nil {
		return err
	}
	if used > quota {
		return errQuota
	}
	return nil
}

func (d Deps) orphanBackup(ctx context.Context, blobID []byte, n, now int64) {
	ctx = context.WithoutCancel(ctx)
	err := d.Repo.Tx(ctx, func(tx store.Repository) error {
		if err := tx.PutBlob(ctx, store.BlobRow{
			BlobID: blobID, Size: uint64(n), //nolint:gosec // G115: n is a nonnegative byte count
			StorageRef: blob.StorageRef(d.Config.Blobs.Backend, blobID), Created: now,
		}); err != nil {
			return err
		}
		return tx.MarkBlobUnreferenced(ctx, blobID, now)
	})
	if err != nil {
		d.Log.ErrorContext(ctx, "record an unreferenced backup", "err", err)
	}
}

// ListBackups returns the two served kinds in root-then-state order.
func (d Deps) ListBackups(w http.ResponseWriter, r *http.Request) {
	sess, ok := session(r)
	if !ok {
		server.WriteError(w, server.Errorf(server.CodeUnauthenticated, ""))
		return
	}
	out := make([]any, 0)
	for _, kind := range []int32{0, 1} {
		rows, err := d.Repo.ListBackups(r.Context(), sess.UserID, kind)
		if err != nil {
			server.WriteError(w, d.storeError(r, err))
			return
		}
		for _, row := range rows {
			blobRow, err := d.Repo.GetBlob(r.Context(), row.BlobID)
			if err != nil {
				d.logf(r, "api: backup blob row missing", "err", err)
				server.WriteError(w, server.Errorf(server.CodeInternal, ""))
				return
			}
			out = append(out, []any{row.Kind, row.ChunkSeq, blobRow.Size, uint64(row.Created)}) //nolint:gosec // G115: a unix second this server wrote, never negative
		}
	}
	d.write(w, r, http.StatusOK, out)
}

// GetBackup returns stored bytes; an unreadable referenced object is a server fault.
func (d Deps) GetBackup(w http.ResponseWriter, r *http.Request) {
	sess, ok := session(r)
	if !ok {
		server.WriteError(w, server.Errorf(server.CodeUnauthenticated, ""))
		return
	}
	kind, _, err := backupPath(r)
	if err != nil {
		server.WriteError(w, err)
		return
	}
	if d.Blobs == nil {
		d.logf(r, "api: backup store not wired")
		server.WriteError(w, server.Errorf(server.CodeInternal, "the backup store is not wired"))
		return
	}
	row, err := d.Repo.GetBackup(r.Context(), sess.UserID, kind, id.ID{}, 0)
	if errors.Is(err, store.ErrNotFound) {
		server.WriteError(w, server.Errorf(server.CodeNotFound, "no backup of this kind"))
		return
	}
	if err != nil {
		server.WriteError(w, d.storeError(r, err))
		return
	}
	f, size, err := d.Blobs.Get(row.BlobID)
	if err != nil {
		d.logf(r, "api: read backup bytes", "err", err)
		server.WriteError(w, server.Errorf(server.CodeInternal, ""))
		return
	}
	defer func() { _ = f.Close() }()
	if size < 0 || size > maxStateBody {
		d.logf(r, "api: backup size outside bound", "size", size)
		server.WriteError(w, server.Errorf(server.CodeInternal, ""))
		return
	}
	object, err := io.ReadAll(io.LimitReader(f, size))
	if err != nil || int64(len(object)) != size {
		d.logf(r, "api: short backup read", "err", err)
		server.WriteError(w, server.Errorf(server.CodeInternal, ""))
		return
	}
	d.write(w, r, http.StatusOK, []any{object, uint64(row.Created)}) //nolint:gosec // G115: a unix second this server wrote, never negative
}

// DeleteBackup is reserved at wire 1.
func (d Deps) DeleteBackup(w http.ResponseWriter, _ *http.Request) {
	server.WriteError(w, notImplemented("DELETE /v1/backups is not served at wire 1"))
}
