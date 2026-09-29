package store_test

import (
	"context"
	"testing"

	"github.com/jonasthim/dilla/internal/id"
	"github.com/jonasthim/dilla/internal/store"
)

// seedGroup creates one open text group created at `created`.
func seedGroup(ctx context.Context, t *testing.T, repo store.Repository, created int64) store.GroupRow {
	t.Helper()
	g := store.GroupRow{
		GroupID: id.New(), Binding: []byte{0x80}, Kind: 0, TargetID: id.New(), Ciphersuite: 1,
		ExternalSenderKeyID: id.New(), E2EEVersion: 1, MediaVersion: 1, PolicyVersion: 1,
		Created: created,
	}
	if err := repo.CreateGroup(ctx, g); err != nil {
		t.Fatalf("CreateGroup: %v", err)
	}
	return g
}

func appendHandshake(ctx context.Context, t *testing.T, repo store.Repository, g id.ID, seq uint64, created int64) {
	t.Helper()
	if err := repo.AppendHandshake(ctx, store.HandshakeRow{
		GroupID: g, Seq: seq, Epoch: 1, Kind: 1, Blob: []byte("commit"), Created: created,
	}); err != nil {
		t.Fatalf("AppendHandshake(%d): %v", seq, err)
	}
}

func putMessage(ctx context.Context, t *testing.T, repo store.Repository, g id.ID, seq uint64, created int64, expires *int64) {
	t.Helper()
	if err := repo.PutAppMessage(ctx, store.AppMessageRow{
		GroupID: g, Seq: seq, Epoch: 1, UploaderDevice: id.New(), Blob: []byte("ct"),
		FrankingTag: make([]byte, 32), Size: 2, Created: created, Expires: expires,
	}); err != nil {
		t.Fatalf("PutAppMessage(%d): %v", seq, err)
	}
}

func groupMarks(ctx context.Context, t *testing.T, repo store.Repository, g id.ID) (messages, handshakes uint64) {
	t.Helper()
	row, err := repo.GetGroup(ctx, g)
	if err != nil {
		t.Fatalf("GetGroup: %v", err)
	}
	return row.PrunedBelow, row.HandshakesPruned
}

// Invariant 10's two high-waters record EXACTLY what retention deleted, per group and per stream,
// on both engines: the catch-up's E_PRUNED is decided against them (deviation B20's exact floor).
// A prune that deletes nothing moves nothing, a later prune never walks a mark back, and each
// message trigger — the cursor floor, the delivery window and an archival expiry — records the
// highest seq it took.
func TestRetentionHighWatersRecordExactlyWhatWasDeleted(t *testing.T) {
	ctx := context.Background()
	for name, repo := range engines(t) {
		t.Run(name, func(t *testing.T) {
			const day = int64(24 * 60 * 60)
			old, young := seedGroup(ctx, t, repo, 1_000), seedGroup(ctx, t, repo, 1_000)

			// Handshakes: seqs 2 and 5 are old, 9 is young; the other group's are all young.
			appendHandshake(ctx, t, repo, old.GroupID, 2, 1_000)
			appendHandshake(ctx, t, repo, old.GroupID, 5, 1_000)
			appendHandshake(ctx, t, repo, old.GroupID, 9, 40*day)
			appendHandshake(ctx, t, repo, young.GroupID, 3, 40*day)

			n, err := repo.PruneHandshakes(ctx, 10*day)
			if err != nil || n != 2 {
				t.Fatalf("PruneHandshakes = %d, %v; want the two old rows", n, err)
			}
			if _, hs := groupMarks(ctx, t, repo, old.GroupID); hs != 5 {
				t.Errorf("handshakes_pruned_through = %d, want 5, the highest seq deleted", hs)
			}
			if _, hs := groupMarks(ctx, t, repo, young.GroupID); hs != 0 {
				t.Errorf("a group that lost nothing has handshakes_pruned_through = %d, want 0", hs)
			}
			// Nothing more to delete: the mark stays where the deletion put it.
			if n, err := repo.PruneHandshakes(ctx, 10*day); err != nil || n != 0 {
				t.Fatalf("second PruneHandshakes = %d, %v", n, err)
			}
			if _, hs := groupMarks(ctx, t, repo, old.GroupID); hs != 5 {
				t.Errorf("an empty prune moved the mark to %d", hs)
			}

			// Messages: the cursor floor takes seq 3, the delivery window takes seq 4, an archival
			// expiry takes seq 8; seq 6 stays.
			expired := int64(50 * day)
			putMessage(ctx, t, repo, young.GroupID, 3, 45*day, nil)
			putMessage(ctx, t, repo, young.GroupID, 4, 1_000, nil)
			putMessage(ctx, t, repo, young.GroupID, 6, 45*day, nil)
			putMessage(ctx, t, repo, young.GroupID, 8, 45*day, &expired)

			n, err = repo.PruneAppMessages(ctx, young.GroupID, 3, 10*day, 60*day)
			if err != nil || n != 3 {
				t.Fatalf("PruneAppMessages = %d, %v; want seqs 3, 4 and 8", n, err)
			}
			if msgs, _ := groupMarks(ctx, t, repo, young.GroupID); msgs != 8 {
				t.Errorf("pruned_below = %d, want 8, the highest seq deleted", msgs)
			}
			rows, err := repo.ListAppMessages(ctx, young.GroupID, 0, 10)
			if err != nil || len(rows) != 1 || rows[0].Seq != 6 {
				t.Fatalf("survivors = %v, %v; want seq 6 alone", rows, err)
			}
			// A later prune under a lower floor deletes nothing and does not walk the mark back.
			if n, err := repo.PruneAppMessages(ctx, young.GroupID, 1, 10*day, 60*day); err != nil || n != 0 {
				t.Fatalf("second PruneAppMessages = %d, %v", n, err)
			}
			if msgs, _ := groupMarks(ctx, t, repo, young.GroupID); msgs != 8 {
				t.Errorf("pruned_below walked back to %d", msgs)
			}
			if msgs, _ := groupMarks(ctx, t, repo, old.GroupID); msgs != 0 {
				t.Errorf("a group whose messages were never pruned has pruned_below = %d", msgs)
			}
		})
	}
}
