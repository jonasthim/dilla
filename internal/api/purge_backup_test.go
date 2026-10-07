package api_test

// purge_backup_test.go pins the branch review's BACKUPS-RECOVERY-05: backup objects and attachments
// never share bytes, and the admin purge of bytes a backups row names still removes every channel
// reference. Before the fix a sender, who chooses an attachment's key and nonce and so every
// ciphertext byte, shaped an attachment as a well-formed state object, stored the same bytes as
// their backup, and the purge (security review F10) then refused the bytes outright: the channel
// references stayed and every member kept downloading content the operator meant to remove. The
// purge still never tombstones or unlinks a backup object (the root is written once, so that would
// end the account's recovery); it drops the references, audits, and keeps the bytes.

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"log/slog"
	"net/http"
	"testing"

	"github.com/jonasthim/dilla/internal/api"
	"github.com/jonasthim/dilla/internal/config"
	"github.com/jonasthim/dilla/internal/id"
	"github.com/jonasthim/dilla/internal/store"
)

// mountBackupPut adds PUT /v1/backups to a blob env, over its repository, blob store and clock.
func mountBackupPut(e *env) {
	d := api.Deps{Repo: e.Repo, Blobs: e.Blobs, Config: config.Default(), Clock: e.Clk, Log: slog.New(slog.DiscardHandler)}
	e.Mux.Handle("PUT /v1/backups/{kind}/{chunk_seq}", http.HandlerFunc(d.PutBackup))
}

// stateShaped is a well-formed state object, [1, nonce(12), ciphertext]: what a sender can make an
// attachment's ciphertext look like.
func stateShaped(t *testing.T, fill byte) []byte {
	t.Helper()
	return mustCBOR(t, []any{uint64(1), bytes.Repeat([]byte{fill}, 12), bytes.Repeat([]byte{fill ^ 0xff}, 64)})
}

func putAttachment(e *env, ch id.ID, tok string, payload []byte) (int, []byte) {
	sum := sha256.Sum256(payload)
	return e.DoRaw(http.MethodPut, blobURL(ch, sum[:]), tok, "application/octet-stream", payload)
}

func putStateObject(e *env, tok string, object []byte) (int, []byte) {
	return e.Do(http.MethodPut, "/v1/backups/1/0", tok, []any{object})
}

// A backup PUT of bytes a channel already references is refused (409) inside the recording
// transaction, and records no backups row.
func TestABackupPutOfAttachmentBytesIsRefused(t *testing.T) {
	e, ch, tok := blobEnv(t)
	mountBackupPut(e)
	object := stateShaped(t, 0x21)
	if status, body := putAttachment(e, ch, tok, object); status != http.StatusCreated {
		t.Fatalf("the attachment PUT = %d %x, want 201", status, body)
	}
	status, body := putStateObject(e, tok, object)
	if status != http.StatusConflict || e.ErrCode(body) != "E_INVALID_REQUEST" {
		t.Fatalf("a backup PUT of an attachment's bytes = %d %x, want 409 E_INVALID_REQUEST", status, body)
	}
	if rows, err := e.Repo.ListBackups(t.Context(), userOf(t, e, tok), 1); err != nil || len(rows) != 0 {
		t.Fatalf("state rows after the refusal = %+v, %v; want none", rows, err)
	}
	sum := sha256.Sum256(object)
	if n, err := e.Repo.CountBlobRefs(t.Context(), sum[:]); err != nil || n != 1 {
		t.Fatalf("references after the refusal = %d, %v; want the attachment's one", n, err)
	}
}

// An attachment upload or reference of bytes a backups row names is refused (409) inside the
// recording transaction, in any channel; once the state object is replaced the bytes are no backup's
// and upload as an attachment again.
func TestAnAttachmentOfBackupBytesIsRefused(t *testing.T) {
	e, ch, tok := blobEnv(t)
	mountBackupPut(e)
	other := secondChannel(t, e, ch, tok)
	object := stateShaped(t, 0x31)
	if status, body := putStateObject(e, tok, object); status != http.StatusCreated {
		t.Fatalf("the state PUT = %d %x, want 201", status, body)
	}
	sum := sha256.Sum256(object)
	for _, c := range []id.ID{ch, other} {
		status, body := putAttachment(e, c, tok, object)
		if status != http.StatusConflict || e.ErrCode(body) != "E_INVALID_REQUEST" {
			t.Fatalf("an attachment of a backup object's bytes = %d %x, want 409 E_INVALID_REQUEST", status, body)
		}
	}
	if n, err := e.Repo.CountBlobRefs(t.Context(), sum[:]); err != nil || n != 0 {
		t.Fatalf("references after the refusals = %d, %v; want none", n, err)
	}
	if _, err := e.Blobs.Stat(sum[:]); err != nil {
		t.Fatalf("the backup object's file after the refusals: %v", err)
	}

	if status, body := putStateObject(e, tok, stateShaped(t, 0x32)); status != http.StatusOK {
		t.Fatalf("the replacing state PUT = %d %x, want 200", status, body)
	}
	if status, body := putAttachment(e, ch, tok, object); status != http.StatusCreated {
		t.Fatalf("an attachment of bytes no backup names any more = %d %x, want 201", status, body)
	}
}

// The purge of bytes a backups row names (what a database written before the disjointness rule can
// hold) deletes every channel reference and writes its audit row, and skips only the tombstone and
// the unlink: the backup object stays readable. Changed by BACKUPS-RECOVERY-05: it was a 409 that
// wrote nothing and left every reference in place.
func TestThePurgeOfBackupBytesDropsEveryReferenceAndKeepsTheBytes(t *testing.T) {
	e, ch, tok := blobEnv(t)
	other := secondChannel(t, e, ch, tok)
	adminTok := e.NewInstanceAdmin("root")
	ctx := t.Context()
	user := userOf(t, e, tok)
	device := e.sess[tok].DeviceID
	now := e.Clk.Now().Unix()
	stored := func(kind uint64, fill byte, channels ...id.ID) []byte {
		t.Helper()
		object := bytes.Repeat([]byte{fill}, 103)
		sum := sha256.Sum256(object)
		if _, _, err := e.Blobs.Put(ctx, sum[:], bytes.NewReader(object), int64(len(object))); err != nil {
			t.Fatalf("Put: %v", err)
		}
		if err := e.Repo.PutBlob(ctx, store.BlobRow{BlobID: sum[:], Size: uint64(len(object)), StorageRef: "fs:x", Created: now}); err != nil {
			t.Fatalf("PutBlob: %v", err)
		}
		if err := e.Repo.PutBackup(ctx, store.BackupRow{UserID: user, Kind: kind, DeviceID: id.ID{}, BlobID: sum[:], Created: now}); err != nil {
			t.Fatalf("PutBackup: %v", err)
		}
		for _, c := range channels {
			if err := e.Repo.PutBlobRef(ctx, sum[:], c, device, "", now); err != nil {
				t.Fatalf("PutBlobRef: %v", err)
			}
		}
		return sum[:]
	}
	purge := func(blobID []byte) (int, []byte) {
		return e.Do(http.MethodDelete, "/v1/admin/blobs/"+hex.EncodeToString(blobID), adminTok, []any{"takedown"})
	}
	kept := func(what string, blobID []byte) {
		t.Helper()
		if tomb, err := e.Repo.GetBlobTombstone(ctx, blobID); err != nil || tomb {
			t.Fatalf("%s: tombstone %v (err %v), want none", what, tomb, err)
		}
		if _, err := e.Repo.GetBlob(ctx, blobID); err != nil {
			t.Fatalf("%s: the blobs row is gone: %v", what, err)
		}
		if _, err := e.Blobs.Stat(blobID); err != nil {
			t.Fatalf("%s: the file is gone: %v", what, err)
		}
		if n, err := e.Repo.CountBlobRefs(ctx, blobID); err != nil || n != 0 {
			t.Fatalf("%s: %d references (err %v), want none", what, n, err)
		}
	}
	audits := func(want int) {
		t.Helper()
		rows, err := e.Repo.ListAudit(ctx, 0, 10)
		if err != nil {
			t.Fatalf("ListAudit: %v", err)
		}
		n := 0
		for _, row := range rows {
			if row.Action == "blob.purge" {
				n++
			}
		}
		if n != want {
			t.Fatalf("blob.purge audit rows = %d (%+v), want %d", n, rows, want)
		}
	}

	shared := stored(1, 0x6b, ch, other)
	if status, body := purge(shared); status != http.StatusNoContent {
		t.Fatalf("purge of a state object's bytes two channels reference = %d %x, want 204", status, body)
	}
	kept("the state object after the purge", shared)
	audits(1)

	root := stored(0, 0x5a)
	if status, body := purge(root); status != http.StatusNoContent {
		t.Fatalf("purge of a root object's bytes = %d %x, want 204", status, body)
	}
	kept("the root object after the purge", root)
	audits(2)

	// Once the state object is replaced no backups row names the old bytes, and the purge
	// tombstones them as for any blob.
	stored(1, 0x7c)
	if status, body := purge(shared); status != http.StatusNoContent {
		t.Fatalf("purge of a replaced state object's bytes = %d %x, want 204", status, body)
	}
	if tomb, err := e.Repo.GetBlobTombstone(ctx, shared); err != nil || !tomb {
		t.Fatalf("the purged bytes have no tombstone: %v (err %v)", tomb, err)
	}
	audits(3)
}
