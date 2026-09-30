package blob_test

import (
	"bytes"
	"crypto/sha256"
	"errors"
	"testing"

	"github.com/jonasthim/dilla/internal/blob"
	"github.com/jonasthim/dilla/internal/id"
	"github.com/jonasthim/dilla/internal/store"
)

// Purge is the one implementation behind DELETE /v1/admin/blobs/{blob_id} and
// `dillad admin blob purge`. The CLI acts as the operator, who is not a users
// row, so its audit row names no actor and its tombstone carries the all-zero id.
func TestPurgeWithNoActorRemovesTheBlobAndAuditsAnOperatorAct(t *testing.T) {
	h := newGCHarness(t)
	ctx := t.Context()
	body := []byte("ciphertext of an attachment")
	sum := sha256.Sum256(body)
	blobID := sum[:]
	if _, _, err := h.Store.Put(ctx, blobID, bytes.NewReader(body), 1<<20); err != nil {
		t.Fatalf("Put: %v", err)
	}
	if err := h.Repo.PutBlob(ctx, store.BlobRow{BlobID: blobID, Size: uint64(len(body)),
		StorageRef: "fs:x", Created: h.Clock.Now().Unix()}); err != nil {
		t.Fatalf("PutBlob: %v", err)
	}

	res, err := blob.Purge(ctx, h.Repo, h.Store, blob.PurgeRequest{
		BlobID: blobID, Reason: "court order 42", At: h.Clock.Now().Unix(),
	})
	if err != nil {
		t.Fatalf("Purge: %v", err)
	}
	if res.UnlinkErr != nil {
		t.Fatalf("the file was not unlinked: %v", res.UnlinkErr)
	}
	if _, err := h.Store.Stat(blobID); !errors.Is(err, blob.ErrNotFound) {
		t.Fatalf("the file survived the purge: %v", err)
	}
	if _, err := h.Repo.GetBlob(ctx, blobID); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("the blobs row survived: %v", err)
	}
	if ok, err := h.Repo.GetBlobTombstone(ctx, blobID); err != nil || !ok {
		t.Fatalf("no tombstone: ok=%v err=%v", ok, err)
	}
	rows, err := h.Repo.ListAudit(ctx, 0, 10)
	if err != nil {
		t.Fatalf("ListAudit: %v", err)
	}
	if len(rows) != 1 || rows[0].Action != "blob.purge" || rows[0].Detail != "court order 42" || rows[0].Actor != nil {
		t.Fatalf("audit = %+v, want one blob.purge row with no actor", rows)
	}

	// A second purge of the same bytes is harmless and audits again.
	if _, err := blob.Purge(ctx, h.Repo, h.Store, blob.PurgeRequest{
		BlobID: blobID, Reason: "again", By: id.New(), At: h.Clock.Now().Unix(),
	}); err != nil {
		t.Fatalf("a second Purge: %v", err)
	}
}
