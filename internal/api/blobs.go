package api

import (
	"context"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"log/slog"
	"mime"
	"net/http"
	"time"

	"github.com/jonasthim/dilla/internal/auth"
	"github.com/jonasthim/dilla/internal/blob"
	"github.com/jonasthim/dilla/internal/clock"
	"github.com/jonasthim/dilla/internal/config"
	"github.com/jonasthim/dilla/internal/server"
	"github.com/jonasthim/dilla/internal/store"
)

// Blobs serves the attachment routes of protocol/09 § Blobs: a channel-scoped,
// content-addressed PUT and a GET (which also answers HEAD) over the blob store.
// The reference table is the ACL (gap-47 §4.1): a caller reads a blob only
// through a channel it may read that holds a reference to it. Register mounts
// the handlers bare, as Readable does, and each requires an enrolled session
// itself.
type Blobs struct {
	repo  store.Repository
	store *blob.Store
	res   *Resolver
	cfg   config.Blobs
	clk   clock.Clock
	log   *slog.Logger
}

// NewBlobs wires the routes over one blob store and the [blobs] configuration.
func NewBlobs(repo store.Repository, bs *blob.Store, res *Resolver, cfg config.Blobs, clk clock.Clock, log *slog.Logger) *Blobs {
	return &Blobs{repo: repo, store: bs, res: res, cfg: cfg, clk: clk, log: log}
}

func (b *Blobs) Register(mux *server.Mux) {
	mux.HandleFunc("PUT /v1/channels/{id}/blobs/{blob_id}", b.put)
	// ServeMux routes HEAD to the GET handler, so one registration answers both;
	// http.ServeContent writes no body for a HEAD and keeps the headers.
	mux.HandleFunc("GET /v1/channels/{id}/blobs/{blob_id}", b.get)
	mux.HandleFunc("DELETE /v1/channels/{id}/blobs/{blob_id}", b.delete)
}

// octetStream is the one media type a blob travels as, both ways: the server
// cannot know better, and must not guess from ciphertext.
const octetStream = "application/octet-stream"

// errQuota aborts the reference transaction when the new reference takes the
// uploader over blobs.quota_bytes_per_user.
var errQuota = errors.New("api: blob quota exceeded")

// errTombstoned aborts the reference transaction when an administrator purged
// the bytes while the upload was streaming.
var errTombstoned = errors.New("api: the blob was purged during the upload")

// channel parses {id} and {blob_id} — both before the database or the
// filesystem is touched (protocol/09 § Identifiers) — and loads the channel for
// a caller holding every bit of want. A caller who may not view the channel gets
// 404, as for an unknown one; a category holds no attachments (NV9: it has no
// messages to carry one).
func (b *Blobs) channel(r *http.Request, want Bits) (auth.Session, store.ChannelRow, []byte, error) {
	s, err := enrolledSession(r)
	if err != nil {
		return s, store.ChannelRow{}, nil, err
	}
	chID, err := server.PathID(r, "id")
	if err != nil {
		return s, store.ChannelRow{}, nil, err
	}
	blobID, err := server.PathDigest(r, "blob_id")
	if err != nil {
		return s, store.ChannelRow{}, nil, err
	}
	ch, err := b.repo.GetChannel(r.Context(), chID)
	if err != nil {
		return s, store.ChannelRow{}, nil, notFound(err)
	}
	bits, err := b.res.Resolve(r.Context(), s.UserID, ch)
	if err != nil {
		return s, store.ChannelRow{}, nil, err
	}
	if !bits.Has(PermViewChannel) {
		return s, store.ChannelRow{}, nil, server.Errorf(server.CodeNotFound, "no such object")
	}
	if ch.Kind == ChannelCategory {
		return s, store.ChannelRow{}, nil, server.Errorf(server.CodeForbidden, "a category holds no attachments")
	}
	if !bits.Has(want) {
		return s, store.ChannelRow{}, nil, server.Errorf(server.CodeForbidden, "missing permission")
	}
	return s, ch, blobID, nil
}

// put is PUT /v1/channels/{id}/blobs/{blob_id}: raw ciphertext in, and
// `201 [blob_id, size]` when the bytes were new or `200 [blob_id, size]` when
// they were already stored. Either way the caller's channel gains a reference.
func (b *Blobs) put(w http.ResponseWriter, r *http.Request) {
	// SetReadDeadline must be the FIRST statement: "Setting the read deadline
	// after it has been exceeded will not extend it" (go doc
	// http.ResponseController.SetReadDeadline, Go 1.27), and a 100 MiB upload on
	// a homelab uplink outruns any whole-request ReadTimeout. The deadline is a
	// socket deadline, so it is wall-clock time, never the instance clock.
	if d := b.cfg.UploadTimeout.Value(); d > 0 {
		if err := http.NewResponseController(w).SetReadDeadline(time.Now().Add(d)); err != nil {
			b.log.Warn("set read deadline", "err", err)
		}
	}
	s, ch, blobID, err := b.channel(r, PermAttachFiles)
	if err != nil {
		server.WriteError(w, err)
		return
	}
	if mt, _, err := mime.ParseMediaType(r.Header.Get("Content-Type")); err != nil || mt != octetStream {
		server.WriteError(w, server.WithStatus(http.StatusUnsupportedMediaType,
			server.Errorf(server.CodeInvalidRequest, "Content-Type must be %s", octetStream)))
		return
	}
	if err := b.refuseTombstoned(r.Context(), blobID); err != nil {
		// Without this, content addressing undoes an admin purge: anyone holding
		// the ciphertext re-PUTs it and gets the same name back.
		server.WriteError(w, err)
		return
	}
	quota := b.cfg.QuotaBytesPerUser
	if quota > 0 {
		// The cheap refusal, before a byte of the body is read. The exact check
		// runs in the reference transaction below.
		used, err := b.repo.UserBlobBytes(r.Context(), s.UserID)
		if err != nil {
			server.WriteError(w, err)
			return
		}
		if used >= quota {
			server.WriteError(w, errStorageFull())
			return
		}
	}
	body := http.MaxBytesReader(w, r.Body, b.cfg.MaxBlobBytes)
	n, created, err := b.store.Put(r.Context(), blobID, body, b.cfg.MaxBlobBytes)
	var mbe *http.MaxBytesError
	switch {
	case errors.Is(err, blob.ErrTooLarge), errors.As(err, &mbe):
		server.WriteError(w, server.Errorf(server.CodeTooLarge, "at most %d bytes", b.cfg.MaxBlobBytes))
		return
	case errors.Is(err, blob.ErrHashMismatch):
		server.WriteError(w, server.WithStatus(http.StatusUnprocessableEntity,
			server.Errorf(server.CodeInvalidRequest, "the body does not hash to the requested blob_id")))
		return
	case err != nil:
		b.log.ErrorContext(r.Context(), "store blob", "err", err)
		server.WriteError(w, err)
		return
	}
	now := b.clk.Now().Unix()
	err = b.repo.Tx(r.Context(), func(tx store.Repository) error {
		// PutBlob is a no-op when the row exists, so a concurrent upload of the
		// same bytes lands on the same row whichever transaction commits first.
		if err := tx.PutBlob(r.Context(), store.BlobRow{
			BlobID: blobID, Size: uint64(n), //nolint:gosec // G115: n is a byte count io.Copy returned, never negative
			StorageRef: blob.StorageRef(b.cfg.Backend, blobID), Created: now,
		}); err != nil {
			return err
		}
		// The tombstone again, now inside the transaction that would write the
		// reference: a purge that committed while the body was streaming must not
		// be undone by it (fix wave I9).
		tomb, err := tx.GetBlobTombstone(r.Context(), blobID)
		if err != nil {
			return err
		}
		if tomb {
			return errTombstoned
		}
		// P2-D16, gap-47 §8.3: a reference created inside the grace window saves
		// the blob from the sweeper.
		if err := tx.ClearBlobUnreferenced(r.Context(), blobID); err != nil {
			return err
		}
		if err := tx.PutBlobRef(r.Context(), blobID, ch.ID, s.DeviceID, "", now); err != nil {
			return err
		}
		if quota <= 0 {
			return nil
		}
		// Exact, and inside the transaction: each distinct blob the user
		// references counts once, so re-publishing their own attachment into a
		// second channel costs nothing.
		used, err := tx.UserBlobBytes(r.Context(), s.UserID)
		if err != nil {
			return err
		}
		if used > quota {
			return errQuota
		}
		return nil
	})
	if err != nil {
		if errors.Is(err, errTombstoned) {
			// The purge's own unlink may have run before this upload wrote the
			// file; purged bytes stay removed, so they go now, row or none.
			if derr := b.store.Delete(blobID); derr != nil {
				b.log.ErrorContext(r.Context(), "remove purged bytes an upload rewrote",
					"blob_id", hex.EncodeToString(blobID), "err", derr)
			}
			server.WriteError(w, server.Errorf(server.CodePruned, "these bytes were removed by the server operator"))
			return
		}
		if created {
			b.orphan(r.Context(), blobID, n, now)
		}
		if errors.Is(err, errQuota) {
			server.WriteError(w, errStorageFull())
			return
		}
		b.log.ErrorContext(r.Context(), "record blob reference", "err", err)
		server.WriteError(w, err)
		return
	}
	status := http.StatusOK
	if created {
		status = http.StatusCreated
	}
	if err := server.EncodeBody(w, status, []any{blobID, uint64(n)}); err != nil { //nolint:gosec // G115: n is a byte count io.Copy returned, never negative
		b.log.Error("encode blob put", "err", err)
	}
}

// orphan records a file the refused transaction left without a row, marked
// unreferenced, so the sweeper (task 11) collects it after the grace window
// instead of it lingering on disk forever. The file is not unlinked here: an
// identical upload may be referencing the same bytes at this very moment, and
// MarkBlobUnreferenced leaves a referenced blob alone.
func (b *Blobs) orphan(ctx context.Context, blobID []byte, n, now int64) {
	// The request may be what failed (a client that went away mid-transaction),
	// so this bookkeeping must not die with it.
	ctx = context.WithoutCancel(ctx)
	err := b.repo.Tx(ctx, func(tx store.Repository) error {
		if err := tx.PutBlob(ctx, store.BlobRow{
			BlobID: blobID, Size: uint64(n), //nolint:gosec // G115: n is a byte count io.Copy returned, never negative
			StorageRef: blob.StorageRef(b.cfg.Backend, blobID), Created: now,
		}); err != nil {
			return err
		}
		return tx.MarkBlobUnreferenced(ctx, blobID, now)
	})
	if err != nil {
		b.log.ErrorContext(ctx, "record an unreferenced upload", "blob_id", hex.EncodeToString(blobID), "err", err)
	}
}

// refuseTombstoned is 410 E_PRUNED for bytes an instance admin purged, on PUT
// and on GET alike: the purge removed every reference, and the answer says why
// rather than a bare 404.
func (b *Blobs) refuseTombstoned(ctx context.Context, blobID []byte) error {
	tomb, err := b.repo.GetBlobTombstone(ctx, blobID)
	if err != nil {
		return err
	}
	if tomb {
		return server.Errorf(server.CodePruned, "these bytes were removed by the server operator")
	}
	return nil
}

func errStorageFull() *server.Error {
	return server.Errorf(server.CodeStorageFull, "your attachment quota is exhausted")
}

// get is GET (and HEAD) /v1/channels/{id}/blobs/{blob_id}. The answer is 404
// whenever this channel holds no reference, even if the bytes exist: the
// response must not tell a caller that a blob they cannot reach exists
// (gap-47 §4.2).
func (b *Blobs) get(w http.ResponseWriter, r *http.Request) {
	_, ch, blobID, err := b.channel(r, PermReadHistory)
	if err != nil {
		server.WriteError(w, err)
		return
	}
	if err := b.refuseTombstoned(r.Context(), blobID); err != nil {
		server.WriteError(w, err)
		return
	}
	if _, err := b.repo.GetBlobRef(r.Context(), blobID, ch.ID); err != nil {
		server.WriteError(w, notFound(err))
		return
	}
	f, _, err := b.store.Get(blobID)
	if errors.Is(err, blob.ErrNotFound) {
		// A reference with no file is a storage fault (an operator rm, a restore
		// that skipped the blob directory). The client holds the key and can
		// re-PUT the identical bytes (gap-47 §8.5), so 404 is the useful answer.
		b.log.WarnContext(r.Context(), "blob referenced but missing on disk", "blob_id", hex.EncodeToString(blobID))
		server.WriteError(w, server.Errorf(server.CodeNotFound, "no such object"))
		return
	}
	if err != nil {
		server.WriteError(w, err)
		return
	}
	defer func() { _ = f.Close() }() // read-only: a close error loses nothing
	h := w.Header()
	// Content-Type BEFORE ServeContent, so it never sniffs ciphertext.
	h.Set("Content-Type", octetStream)
	h.Set("Content-Disposition", "attachment")
	h.Set("X-Content-Type-Options", "nosniff")
	h.Set("Content-Security-Policy", "default-src 'none'; sandbox")
	h.Set("Cross-Origin-Resource-Policy", "same-origin")
	h.Set("Cache-Control", "private, max-age=31536000, immutable")
	// The content hash IS the strong validator, and ServeContent uses it for
	// If-Match, If-None-Match and If-Range.
	h.Set("ETag", `"`+hex.EncodeToString(blobID)+`"`)
	// Repr-Digest (RFC 9530), not Content-Digest: it describes the selected
	// representation, which is still the blob on a 416 whose body is an error
	// string (gap-47 §19.3).
	h.Set("Repr-Digest", "sha-256=:"+base64.StdEncoding.EncodeToString(blobID)+":")
	// name "" infers nothing from an extension; the zero modtime sends no
	// Last-Modified, which is meaningless after a restore. This one call answers
	// 206, 416, If-Range and 304.
	http.ServeContent(w, r, "", time.Time{}, f)
}

// delete is DELETE /v1/channels/{id}/blobs/{blob_id}: it removes this channel's
// REFERENCE, never the bytes (gap-47 INV-B3). When it was the last reference
// anywhere the blob is marked unreferenced in the same transaction, and the
// sweeper unlinks the file once blobs.gc_grace has passed. Deleting a reference
// that is already gone is a success, so a retry is harmless.
func (b *Blobs) delete(w http.ResponseWriter, r *http.Request) {
	s, ch, blobID, err := b.channel(r, PermViewChannel)
	if err != nil {
		server.WriteError(w, err)
		return
	}
	ref, err := b.repo.GetBlobRef(r.Context(), blobID, ch.ID)
	if errors.Is(err, store.ErrNotFound) {
		// Idempotent: deleting something that is already gone is a success.
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if err != nil {
		server.WriteError(w, err)
		return
	}
	// R29 and R34: at v1 only the uploading user may delete, from any of their
	// devices. There is NO moderator fallback — a channel's manage-messages holder
	// is refused here like anyone else. Moderator deletion of an attachment needs a
	// signed moderation event, which is follow-up card 2; letting PermManageMessages
	// drop another user's reference would ship exactly the capability R29 defers,
	// with no signed event and no audit row.
	dev, err := b.repo.GetDevice(r.Context(), ref.UploaderDevice)
	if err != nil && !errors.Is(err, store.ErrNotFound) {
		server.WriteError(w, err)
		return
	}
	// A reference whose device row is gone has no provable uploader, so nobody
	// may delete it through this route; the admin purge still can.
	if err != nil || dev.UserID != s.UserID {
		server.WriteError(w, server.Errorf(server.CodeNotUploader,
			"only the uploading user may delete this object"))
		return
	}
	now := b.clk.Now().Unix()
	if err := b.repo.Tx(r.Context(), func(tx store.Repository) error {
		if err := tx.DeleteBlobRef(r.Context(), blobID, ch.ID); err != nil {
			return err
		}
		// Sets unref_since only when no reference is left; the statement's own
		// NOT EXISTS makes it safe to call unconditionally.
		return tx.MarkBlobUnreferenced(r.Context(), blobID, now)
	}); err != nil {
		server.WriteError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
