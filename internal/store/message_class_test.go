package store_test

import (
	"context"
	"errors"
	"testing"

	"github.com/jonasthim/dilla/internal/id"
	"github.com/jonasthim/dilla/internal/store"
)

func classPtr(v uint8) *uint8 { return &v }

// LastClassZeroUploadAt is slow mode's read for end-to-end encrypted posts (web3.7 SB1): the newest
// class-0 upload by any device of the user into any text group of the channel. Folds (class 1),
// legacy rows (NULL), other users and call groups never count; a tombstoned post still does, or
// delete-and-repost would bypass slow mode.
func TestLastClassZeroUploadAt(t *testing.T) {
	for engine, repo := range engines(t) {
		t.Run(engine, func(t *testing.T) {
			ctx := context.Background()
			channel := id.New()
			mkGroup := func(kind uint8, target id.ID) id.ID {
				g := store.GroupRow{
					GroupID: id.New(), Binding: []byte{0x80}, Kind: kind, TargetID: target, Ciphersuite: 1,
					ExternalSenderKeyID: id.New(), E2EEVersion: 1, MediaVersion: 1, PolicyVersion: 1,
					Created: 1,
				}
				if err := repo.CreateGroup(ctx, g); err != nil {
					t.Fatalf("CreateGroup: %v", err)
				}
				return g.GroupID
			}
			text := mkGroup(0, channel)
			text2 := mkGroup(0, channel)
			call := mkGroup(1, channel)
			user := seedUser(ctx, t, repo).ID
			other := seedUser(ctx, t, repo).ID
			phone := seedDevice(ctx, t, repo, user)
			laptop := seedDevice(ctx, t, repo, user)
			stranger := seedDevice(ctx, t, repo, other)

			seqs := map[id.ID]uint64{}
			put := func(g, device id.ID, created int64, class *uint8) uint64 {
				t.Helper()
				seqs[g]++
				if err := repo.PutAppMessage(ctx, store.AppMessageRow{
					GroupID: g, Seq: seqs[g], Epoch: 1, UploaderDevice: device, Blob: []byte("ct"),
					FrankingTag: make([]byte, 32), Size: 2, Created: created, Class: class,
				}); err != nil {
					t.Fatalf("PutAppMessage: %v", err)
				}
				return seqs[g]
			}
			want := func(label string, at int64) {
				t.Helper()
				got, err := repo.LastClassZeroUploadAt(ctx, channel, user)
				if err != nil || got != at {
					t.Fatalf("%s: LastClassZeroUploadAt = %d, %v; want %d", label, got, err, at)
				}
			}

			if _, err := repo.LastClassZeroUploadAt(ctx, channel, user); !errors.Is(err, store.ErrNotFound) {
				t.Fatalf("no upload yet: err = %v, want ErrNotFound", err)
			}
			put(text, phone, 100, classPtr(0))
			last := put(text2, laptop, 140, classPtr(0))
			want("posts by two devices into two text groups", 140)
			put(text, phone, 200, classPtr(1))
			want("a class-1 row is ignored", 140)
			put(text, phone, 210, nil)
			want("a NULL-class row is ignored", 140)
			put(text, stranger, 220, classPtr(0))
			want("another user's post is ignored", 140)
			put(call, phone, 230, classPtr(0))
			want("a call group with the same target is ignored", 140)
			if err := repo.TombstoneAppMessage(ctx, text2, last, 300); err != nil {
				t.Fatalf("TombstoneAppMessage: %v", err)
			}
			want("a tombstoned post still counts", 140)

			if _, err := repo.LastClassZeroUploadAt(ctx, channel, other); err != nil {
				t.Fatalf("the other user's own post: %v", err)
			}
			if _, err := repo.LastClassZeroUploadAt(ctx, id.New(), user); !errors.Is(err, store.ErrNotFound) {
				t.Fatalf("another channel: err = %v, want ErrNotFound", err)
			}
		})
	}
}

// The class column round-trips through PutAppMessage and both reads: 0, 1 and NULL.
func TestAppMessageClassRoundTrips(t *testing.T) {
	for engine, repo := range engines(t) {
		t.Run(engine, func(t *testing.T) {
			ctx := context.Background()
			g := seedGroup(ctx, t, repo, 1)
			for i, c := range []*uint8{classPtr(0), classPtr(1), nil} {
				if err := repo.PutAppMessage(ctx, store.AppMessageRow{
					GroupID: g.GroupID, Seq: uint64(i + 1), Epoch: 1, UploaderDevice: id.New(), Blob: []byte("ct"),
					FrankingTag: make([]byte, 32), Size: 2, Created: 1, Class: c,
				}); err != nil {
					t.Fatalf("PutAppMessage: %v", err)
				}
			}
			rows, err := repo.ListAppMessages(ctx, g.GroupID, 1, 10)
			if err != nil || len(rows) != 3 {
				t.Fatalf("ListAppMessages = %d rows, %v", len(rows), err)
			}
			if rows[0].Class == nil || *rows[0].Class != 0 || rows[1].Class == nil || *rows[1].Class != 1 || rows[2].Class != nil {
				t.Fatalf("classes = %v %v %v, want 0 1 nil", rows[0].Class, rows[1].Class, rows[2].Class)
			}
			one, err := repo.GetAppMessage(ctx, g.GroupID, 2)
			if err != nil || one.Class == nil || *one.Class != 1 {
				t.Fatalf("GetAppMessage = %v, %v; want class 1", one.Class, err)
			}
		})
	}
}
