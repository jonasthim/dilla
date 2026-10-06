package api_test

// purge_backup_test.go pins the security review's F10 operator hazard: the admin purge refuses a
// blob a backups row names. The root object is written once (protocol/09 § Backups): purging its
// bytes tombstones them, so the user's root GET becomes a server fault and its re-PUT 410, and the
// account's recovery is gone for good. The operator asked to remove attachment bytes; a backup
// object is the user's sealed key material and is not theirs to remove this way.

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"testing"

	"github.com/jonasthim/dilla/internal/id"
	"github.com/jonasthim/dilla/internal/store"
)

func TestThePurgeRefusesABlobABackupNames(t *testing.T) {
	e, _, tok := blobEnv(t)
	adminTok := e.NewInstanceAdmin("root")
	ctx := t.Context()
	user := userOf(t, e, tok)
	now := e.Clk.Now().Unix()
	stored := func(kind uint64, fill byte) []byte {
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
		return sum[:]
	}
	purge := func(blobID []byte) (int, []byte) {
		return e.Do(http.MethodDelete, "/v1/admin/blobs/"+hex.EncodeToString(blobID), adminTok, []any{"a mistaken purge"})
	}
	intact := func(what string, blobID []byte) {
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
	}

	root := stored(0, 0x5a)
	status, body := purge(root)
	if status != http.StatusConflict || e.ErrCode(body) != "E_INVALID_REQUEST" {
		t.Fatalf("purge of a root object's bytes = %d %x, want 409 E_INVALID_REQUEST", status, body)
	}
	intact("the root object after a refused purge", root)

	state := stored(1, 0x6b)
	if status, body := purge(state); status != http.StatusConflict || e.ErrCode(body) != "E_INVALID_REQUEST" {
		t.Fatalf("purge of the state object's bytes = %d %x, want 409 E_INVALID_REQUEST", status, body)
	}
	intact("the state object after a refused purge", state)

	// Once the state object is replaced no backups row names the old bytes, and the purge proceeds.
	stored(1, 0x7c)
	if status, body := purge(state); status != http.StatusNoContent {
		t.Fatalf("purge of a replaced state object's bytes = %d %x, want 204", status, body)
	}
	if tomb, err := e.Repo.GetBlobTombstone(ctx, state); err != nil || !tomb {
		t.Fatalf("the purged bytes have no tombstone: %v (err %v)", tomb, err)
	}
	rows, err := e.Repo.ListAudit(ctx, 0, 10)
	if err != nil {
		t.Fatalf("ListAudit: %v", err)
	}
	purges := 0
	for _, row := range rows {
		if row.Action == "blob.purge" {
			purges++
		}
	}
	if purges != 1 {
		t.Fatalf("audit rows = %+v, want one blob.purge row: a refused purge audits nothing", rows)
	}
}
