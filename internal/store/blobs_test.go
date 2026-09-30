package store_test

import (
	"bytes"
	"context"
	"errors"
	"testing"

	"github.com/jonasthim/dilla/internal/id"
	"github.com/jonasthim/dilla/internal/store"
)

// seedChannel creates one live text channel in a fresh community.
func seedChannel(ctx context.Context, t *testing.T, repo store.Repository) id.ID {
	t.Helper()
	ch := channelIn(seedCommunity(ctx, t, repo), 0, 0, 0, "files", 0)
	if err := repo.CreateChannel(ctx, ch); err != nil {
		t.Fatalf("CreateChannel: %v", err)
	}
	return ch.ID
}

// seedDevice creates one device for user.
func seedDevice(ctx context.Context, t *testing.T, repo store.Repository, user id.ID) id.ID {
	t.Helper()
	did := id.New()
	if err := repo.CreateDevice(ctx, store.DeviceRow{
		ID: did, UserID: user, DSKPub: make([]byte, 32), CredentialBlob: []byte{1},
		LastSeen: 1, Created: 1,
	}); err != nil {
		t.Fatalf("CreateDevice: %v", err)
	}
	return did
}

func digest(b byte) []byte { return bytes.Repeat([]byte{b}, 32) }

// Plan 2 task 10: 00010_blobs.sql's blobs, blob_refs and blob_tombstones, with
// P2-D16's ClearBlobUnreferenced and P2-D17's GetBlobRef, on both engines.
func TestBlobReferencesAndCollection(t *testing.T) {
	for engine, repo := range engines(t) {
		t.Run(engine, func(t *testing.T) {
			ctx := context.Background()
			chA, chB := seedChannel(ctx, t, repo), seedChannel(ctx, t, repo)
			alice := seedUser(ctx, t, repo).ID
			laptop, phone := seedDevice(ctx, t, repo, alice), seedDevice(ctx, t, repo, alice)
			x, y := digest(0xa1), digest(0xb2)

			if _, err := repo.GetBlob(ctx, x); !errors.Is(err, store.ErrNotFound) {
				t.Fatalf("GetBlob before any upload = %v, want ErrNotFound", err)
			}
			// A reference needs its blob: blob_refs.blob_id is a foreign key.
			if err := repo.PutBlobRef(ctx, x, chA, laptop, "", 10); err == nil {
				t.Fatal("PutBlobRef without a blobs row succeeded")
			}
			row := store.BlobRow{BlobID: x, Size: 1000, StorageRef: "fs:att/a1/a1/x", Created: 10}
			if err := repo.PutBlob(ctx, row); err != nil {
				t.Fatalf("PutBlob: %v", err)
			}
			// Content addressing: a second PutBlob of the same id is a no-op, not
			// a conflict, and does not overwrite the first row.
			if err := repo.PutBlob(ctx, store.BlobRow{BlobID: x, Size: 1, StorageRef: "other", Created: 99}); err != nil {
				t.Fatalf("PutBlob again: %v", err)
			}
			got, err := repo.GetBlob(ctx, x)
			if err != nil {
				t.Fatalf("GetBlob: %v", err)
			}
			if !bytes.Equal(got.BlobID, x) || got.Size != 1000 || got.StorageRef != "fs:att/a1/a1/x" ||
				got.Created != 10 || got.UnrefSince != nil {
				t.Fatalf("GetBlob = %+v", got)
			}

			if err := repo.PutBlobRef(ctx, x, chA, laptop, "image/png", 11); err != nil {
				t.Fatalf("PutBlobRef A: %v", err)
			}
			// The same (blob, channel) again is idempotent and keeps the first uploader.
			if err := repo.PutBlobRef(ctx, x, chA, phone, "", 12); err != nil {
				t.Fatalf("PutBlobRef A again: %v", err)
			}
			ref, err := repo.GetBlobRef(ctx, x, chA)
			if err != nil {
				t.Fatalf("GetBlobRef: %v", err)
			}
			if !bytes.Equal(ref.BlobID, x) || ref.ChannelID != chA || ref.UploaderDevice != laptop ||
				ref.Mime != "image/png" || ref.Created != 11 {
				t.Fatalf("GetBlobRef = %+v", ref)
			}
			if _, err := repo.GetBlobRef(ctx, x, chB); !errors.Is(err, store.ErrNotFound) {
				t.Fatalf("GetBlobRef in a channel with no reference = %v, want ErrNotFound", err)
			}
			if err := repo.PutBlobRef(ctx, x, chB, phone, "", 13); err != nil {
				t.Fatalf("PutBlobRef B: %v", err)
			}
			if n, err := repo.CountBlobRefs(ctx, x); err != nil || n != 2 {
				t.Fatalf("CountBlobRefs = %d, %v; want 2", n, err)
			}

			// Quota: each distinct blob a user uploaded counts once, from any of
			// their devices and however many channels it is in.
			if err := repo.PutBlob(ctx, store.BlobRow{BlobID: y, Size: 24, StorageRef: "fs:y", Created: 14}); err != nil {
				t.Fatalf("PutBlob y: %v", err)
			}
			if err := repo.PutBlobRef(ctx, y, chA, phone, "", 14); err != nil {
				t.Fatalf("PutBlobRef y: %v", err)
			}
			if used, err := repo.UserBlobBytes(ctx, alice); err != nil || used != 1024 {
				t.Fatalf("UserBlobBytes = %d, %v; want 1024", used, err)
			}
			if used, err := repo.UserBlobBytes(ctx, id.New()); err != nil || used != 0 {
				t.Fatalf("UserBlobBytes of a user with no upload = %d, %v; want 0", used, err)
			}

			// Marking is refused while any reference stands.
			if err := repo.DeleteBlobRef(ctx, x, chA); err != nil {
				t.Fatalf("DeleteBlobRef A: %v", err)
			}
			if err := repo.MarkBlobUnreferenced(ctx, x, 20); err != nil {
				t.Fatalf("MarkBlobUnreferenced: %v", err)
			}
			if got, _ := repo.GetBlob(ctx, x); got.UnrefSince != nil {
				t.Fatalf("unref_since = %d while channel B still references the blob", *got.UnrefSince)
			}
			// Deleting an absent reference is not an error.
			if err := repo.DeleteBlobRef(ctx, x, chA); err != nil {
				t.Fatalf("DeleteBlobRef of a gone reference = %v", err)
			}
			if err := repo.DeleteBlobRef(ctx, x, chB); err != nil {
				t.Fatalf("DeleteBlobRef B: %v", err)
			}
			if err := repo.MarkBlobUnreferenced(ctx, x, 30); err != nil {
				t.Fatalf("MarkBlobUnreferenced: %v", err)
			}
			// A second mark keeps the first time, so a repeated delete cannot
			// push collection back.
			if err := repo.MarkBlobUnreferenced(ctx, x, 40); err != nil {
				t.Fatalf("MarkBlobUnreferenced again: %v", err)
			}
			if got, _ := repo.GetBlob(ctx, x); got.UnrefSince == nil || *got.UnrefSince != 30 {
				t.Fatalf("unref_since = %v, want 30", got.UnrefSince)
			}

			// Collectable: unreferenced and marked strictly before the cutoff.
			if list, err := repo.ListCollectableBlobs(ctx, 30, 10); err != nil || len(list) != 0 {
				t.Fatalf("ListCollectableBlobs(30) = %v, %v; want none", list, err)
			}
			list, err := repo.ListCollectableBlobs(ctx, 31, 10)
			if err != nil || len(list) != 1 || !bytes.Equal(list[0].BlobID, x) {
				t.Fatalf("ListCollectableBlobs(31) = %+v, %v; want x", list, err)
			}

			// A new reference clears the mark (gap-47 §8.3, P2-D16).
			if err := repo.PutBlobRef(ctx, x, chB, laptop, "", 50); err != nil {
				t.Fatalf("PutBlobRef B again: %v", err)
			}
			if err := repo.ClearBlobUnreferenced(ctx, x); err != nil {
				t.Fatalf("ClearBlobUnreferenced: %v", err)
			}
			if got, _ := repo.GetBlob(ctx, x); got.UnrefSince != nil {
				t.Fatalf("unref_since = %d after a new reference", *got.UnrefSince)
			}
			if list, _ := repo.ListCollectableBlobs(ctx, 1<<40, 10); len(list) != 0 {
				t.Fatalf("a referenced blob is collectable: %+v", list)
			}

			// ON DELETE RESTRICT: the row cannot go while a reference stands.
			if err := repo.DeleteBlob(ctx, x); err == nil {
				t.Fatal("DeleteBlob succeeded while a reference stood")
			}
			if err := repo.DeleteBlobRef(ctx, x, chB); err != nil {
				t.Fatalf("DeleteBlobRef: %v", err)
			}
			if err := repo.DeleteBlob(ctx, x); err != nil {
				t.Fatalf("DeleteBlob: %v", err)
			}
			if err := repo.DeleteBlob(ctx, x); !errors.Is(err, store.ErrNotFound) {
				t.Fatalf("DeleteBlob of a gone row = %v, want ErrNotFound", err)
			}

			// Tombstones.
			if tomb, err := repo.GetBlobTombstone(ctx, x); err != nil || tomb {
				t.Fatalf("GetBlobTombstone before a purge = %v, %v", tomb, err)
			}
			if err := repo.PutBlobTombstone(ctx, x, "takedown", alice, 60); err != nil {
				t.Fatalf("PutBlobTombstone: %v", err)
			}
			if err := repo.PutBlobTombstone(ctx, x, "again", alice, 61); err != nil {
				t.Fatalf("PutBlobTombstone again: %v", err)
			}
			if tomb, err := repo.GetBlobTombstone(ctx, x); err != nil || !tomb {
				t.Fatalf("GetBlobTombstone after a purge = %v, %v", tomb, err)
			}
		})
	}
}

// Plan 2 task 10 lands the backups table and OpsBackups (P2-D5) with the
// all-zero device sentinel of P2-D32.
func TestBackupsRoundTrip(t *testing.T) {
	for engine, repo := range engines(t) {
		t.Run(engine, func(t *testing.T) {
			ctx := context.Background()
			user := seedUser(ctx, t, repo).ID
			dev := seedDevice(ctx, t, repo, user)
			var none id.ID

			root := store.BackupRow{UserID: user, Kind: 0, DeviceID: none, ChunkSeq: 0, BlobID: digest(1), ManifestSig: bytes.Repeat([]byte{9}, 64), Created: 1}
			if err := repo.PutBackup(ctx, root); err != nil {
				t.Fatalf("PutBackup root: %v", err)
			}
			// One root per user: a second PutBackup of the same key replaces it,
			// where a nullable device_id in the key would have let SQLite keep both.
			root2 := root
			root2.BlobID, root2.Created = digest(2), 2
			if err := repo.PutBackup(ctx, root2); err != nil {
				t.Fatalf("PutBackup root again: %v", err)
			}
			// A root or state backup is not device scoped.
			if err := repo.PutBackup(ctx, store.BackupRow{UserID: user, Kind: 1, DeviceID: dev, BlobID: digest(3), Created: 3}); err == nil {
				t.Fatal("a kind 1 backup with a device id was accepted")
			}
			for seq := range uint64(2) {
				if err := repo.PutBackup(ctx, store.BackupRow{UserID: user, Kind: 2, DeviceID: dev, ChunkSeq: seq, BlobID: digest(byte(10 + seq)), Created: 4}); err != nil {
					t.Fatalf("PutBackup chunk %d: %v", seq, err)
				}
			}

			roots, err := repo.ListBackups(ctx, user, 0)
			if err != nil {
				t.Fatalf("ListBackups root: %v", err)
			}
			if len(roots) != 1 || !bytes.Equal(roots[0].BlobID, digest(2)) || roots[0].DeviceID != none ||
				roots[0].Created != 2 || len(roots[0].ManifestSig) != 64 {
				t.Fatalf("ListBackups root = %+v", roots)
			}
			chunks, err := repo.ListBackups(ctx, user, 2)
			if err != nil {
				t.Fatalf("ListBackups chunks: %v", err)
			}
			if len(chunks) != 2 || chunks[0].ChunkSeq != 0 || chunks[1].ChunkSeq != 1 ||
				chunks[0].DeviceID != dev || chunks[0].Kind != 2 || chunks[0].ManifestSig != nil {
				t.Fatalf("ListBackups chunks = %+v", chunks)
			}
		})
	}
}
