package store_test

// withdrawn_test.go: migration 00024 (UP6b, R-UP12): the withdrawal of an absence Remove, on both
// engines. protocol/02 invariant 6, "Withdrawal".

import (
	"context"
	"database/sql"
	"math"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/pressly/goose/v3"

	"github.com/jonasthim/dilla/internal/id"
	"github.com/jonasthim/dilla/internal/store"
	"github.com/jonasthim/dilla/internal/store/postgres"
	pgmigrations "github.com/jonasthim/dilla/internal/store/postgres/migrations"
	"github.com/jonasthim/dilla/internal/store/sqlite"
	sqlitemigrations "github.com/jonasthim/dilla/internal/store/sqlite/migrations"
)

func absenceRemove(g id.ID, ref string, withdrawable bool) store.ProposalRow {
	leaf := uint32(2)
	dev := id.New()
	return store.ProposalRow{
		GroupID: g, Ref: []byte(ref), Epoch: 0, Kind: 3, TargetLeaf: &leaf, TargetDevice: &dev,
		Origin: 0, ActionID: id.New(), IssuedAt: 10, TTL: 30, Withdrawable: withdrawable,
	}
}

// A withdrawn proposal is in no listing (correction C2), IsWithdrawn names it, the mark is set once,
// and a kind-3 handshake row is stored and left out of the catch-up of a client without bit 0.
func TestWithdrawnProposalsAndRowsOnBothEngines(t *testing.T) {
	ctx := context.Background()
	for name, repo := range engines(t) {
		t.Run(name, func(t *testing.T) {
			g := seedGroup(ctx, t, repo, 1)
			if err := repo.PutProposal(ctx, absenceRemove(g.GroupID, "ref-a", true)); err != nil {
				t.Fatal(err)
			}
			if err := repo.PutProposal(ctx, absenceRemove(g.GroupID, "ref-b", false)); err != nil {
				t.Fatal(err)
			}
			if live, err := repo.ListProposals(ctx, g.GroupID, 0, false); err != nil || len(live) != 2 || !live[0].Withdrawable || live[1].Withdrawable {
				t.Fatalf("before: %+v, %v", live, err)
			}
			marked, err := repo.WithdrawProposal(ctx, g.GroupID, []byte("ref-a"), 77, 9)
			if err != nil || !marked {
				t.Fatalf("WithdrawProposal = %v, %v", marked, err)
			}
			if again, err := repo.WithdrawProposal(ctx, g.GroupID, []byte("ref-a"), 78, 10); err != nil || again {
				t.Fatalf("a second withdrawal = %v, %v; want false", again, err)
			}
			for _, includeVoid := range []bool{false, true} {
				rows, err := repo.ListProposals(ctx, g.GroupID, 0, includeVoid)
				if err != nil || len(rows) != 1 || string(rows[0].Ref) != "ref-b" {
					t.Fatalf("ListProposals(includeVoid=%v) = %+v, %v; want ref-b alone", includeVoid, rows, err)
				}
			}
			w, err := repo.ListWithdrawnProposals(ctx, g.GroupID, 0)
			if err != nil || len(w) != 1 || string(w[0].Ref) != "ref-a" || w[0].WithdrawnAt == nil || *w[0].WithdrawnAt != 77 ||
				w[0].WithdrawnSeq == nil || *w[0].WithdrawnSeq != 9 || !w[0].Withdrawable {
				t.Fatalf("ListWithdrawnProposals = %+v, %v", w, err)
			}
			for ref, want := range map[string]bool{"ref-a": true, "ref-b": false, "ref-x": false} {
				if got, err := repo.IsWithdrawn(ctx, g.GroupID, 0, []byte(ref)); err != nil || got != want {
					t.Fatalf("IsWithdrawn(%s) = %v, %v; want %v", ref, got, err, want)
				}
			}
			if got, err := repo.IsWithdrawn(ctx, g.GroupID, 1, []byte("ref-a")); err != nil || got {
				t.Fatalf("IsWithdrawn at another epoch = %v, %v", got, err)
			}

			for seq, kind := range map[uint64]uint8{1: 0, 2: 3, 3: 1, 4: 3, 5: 0} {
				if err := repo.AppendHandshake(ctx, store.HandshakeRow{
					GroupID: g.GroupID, Seq: seq, Epoch: 0, Kind: kind, Blob: []byte{0x81, 0x41, 0x01}, Created: 1,
				}); err != nil {
					t.Fatalf("AppendHandshake(kind %d): %v", kind, err)
				}
			}
			all, err := repo.ListHandshakes(ctx, g.GroupID, 1, 10)
			if err != nil || len(all) != 5 {
				t.Fatalf("ListHandshakes = %d rows, %v", len(all), err)
			}
			without, err := repo.ListHandshakesWithoutWithdrawn(ctx, g.GroupID, 1, 2)
			if err != nil || len(without) != 2 || without[0].Seq != 1 || without[1].Seq != 3 {
				t.Fatalf("ListHandshakesWithoutWithdrawn(limit 2) = %+v, %v; want seqs 1 and 3", without, err)
			}
			// A from-seq above MaxInt64 matches no row: it must not wrap to a negative int64 and list them all.
			for _, from := range []uint64{math.MaxInt64 + 1, math.MaxUint64} {
				if got, err := repo.ListHandshakes(ctx, g.GroupID, from, 10); err != nil || got == nil || len(got) != 0 {
					t.Fatalf("ListHandshakes(from %d) = %d rows (nil: %t), %v; want a non-nil empty slice", from, len(got), got == nil, err)
				}
				if got, err := repo.ListHandshakesWithoutWithdrawn(ctx, g.GroupID, from, 10); err != nil || got == nil || len(got) != 0 {
					t.Fatalf("ListHandshakesWithoutWithdrawn(from %d) = %d rows (nil: %t), %v; want a non-nil empty slice", from, len(got), got == nil, err)
				}
			}
		})
	}
}

// Correction C1: a re-issue carries the replaced row's withdrawable flag, whatever the caller sets,
// and a re-arm of a withdrawn row (the same ref) clears the mark and keeps the flag (I1).
func TestReissueCarriesWithdrawableAndRearmClearsTheMark(t *testing.T) {
	ctx := context.Background()
	for name, repo := range engines(t) {
		t.Run(name, func(t *testing.T) {
			g := seedGroup(ctx, t, repo, 1)
			old := absenceRemove(g.GroupID, "ref-old", true)
			if err := repo.PutProposal(ctx, old); err != nil {
				t.Fatal(err)
			}
			fresh := absenceRemove(g.GroupID, "ref-new", false)
			if err := repo.ReissueProposal(ctx, []byte("ref-old"), fresh); err != nil {
				t.Fatal(err)
			}
			rows, err := repo.ListProposals(ctx, g.GroupID, 0, true)
			if err != nil || len(rows) != 1 || string(rows[0].Ref) != "ref-new" || !rows[0].Withdrawable || rows[0].ActionID != old.ActionID {
				t.Fatalf("after the re-issue: %+v, %v; want ref-new, withdrawable, the old action", rows, err)
			}
			if _, err := repo.WithdrawProposal(ctx, g.GroupID, []byte("ref-new"), 50, 4); err != nil {
				t.Fatal(err)
			}
			rearm := absenceRemove(g.GroupID, "ref-new", false)
			rearm.IssuedAt = 90
			if err := repo.ReissueProposal(ctx, []byte("ref-new"), rearm); err != nil {
				t.Fatal(err)
			}
			rows, err = repo.ListProposals(ctx, g.GroupID, 0, false)
			if err != nil || len(rows) != 1 || !rows[0].Withdrawable || rows[0].WithdrawnAt != nil || rows[0].WithdrawnSeq != nil || rows[0].IssuedAt != 90 {
				t.Fatalf("after the re-arm: %+v, %v; want live, withdrawable, unmarked, issued at 90", rows, err)
			}
			// A row that never was withdrawable stays so through a re-issue, whatever the caller
			// sets (security fix: a deliberate Remove never becomes withdrawable).
			plain := absenceRemove(g.GroupID, "ref-plain", false)
			if err := repo.PutProposal(ctx, plain); err != nil {
				t.Fatal(err)
			}
			if err := repo.ReissueProposal(ctx, []byte("ref-plain"), absenceRemove(g.GroupID, "ref-plain2", true)); err != nil {
				t.Fatal(err)
			}
			rows, _ = repo.ListProposals(ctx, g.GroupID, 0, false)
			for _, r := range rows {
				if string(r.Ref) == "ref-plain2" && r.Withdrawable {
					t.Fatal("a re-issue made a plain Remove withdrawable")
				}
			}
		})
	}
}

// Migration 00024 goes down to 23 and up again on both engines (I5): the down step deletes every
// kind-3 row and every withdrawn proposal (never revived), drops the columns, and the table refuses
// kind 3 again; other rows survive.
func TestMigration00024GoesDownAndUpAgain(t *testing.T) {
	ctx := context.Background()
	t.Run("sqlite", func(t *testing.T) {
		path := filepath.Join(t.TempDir(), "m24.db")
		write, err := sqlite.OpenWrite(path)
		if err != nil {
			t.Fatal(err)
		}
		read, err := sqlite.OpenRead(path)
		if err != nil {
			t.Fatal(err)
		}
		p, err := goose.NewProvider(goose.DialectSQLite3, write, sqlitemigrations.FS)
		if err != nil {
			t.Fatal(err)
		}
		repo := sqlite.New(write, read)
		t.Cleanup(func() { repo.Close() })
		downAndUp00024(ctx, t, p, repo, write, false)
	})
	t.Run("postgres", func(t *testing.T) {
		dsn := os.Getenv("DILLA_TEST_PG")
		if dsn == "" {
			t.Skip("DILLA_TEST_PG is not set")
		}
		db, err := postgres.Open(freshPostgresDSN(t, dsn), 4, time.Hour)
		if err != nil {
			t.Fatal(err)
		}
		p, err := goose.NewProvider(goose.DialectPostgres, db, pgmigrations.FS)
		if err != nil {
			t.Fatal(err)
		}
		repo := postgres.New(db)
		t.Cleanup(func() { repo.Close() })
		downAndUp00024(ctx, t, p, repo, db, true)
	})
}

func downAndUp00024(ctx context.Context, t *testing.T, p *goose.Provider, repo store.Repository, db *sql.DB, pg bool) {
	t.Helper()
	if _, err := p.Up(ctx); err != nil {
		t.Fatalf("up: %v", err)
	}
	g := seedGroup(ctx, t, repo, 1)
	for seq, kind := range map[uint64]uint8{1: 0, 2: 3, 3: 1} {
		if err := repo.AppendHandshake(ctx, store.HandshakeRow{
			GroupID: g.GroupID, Seq: seq, Epoch: 0, Kind: kind, Blob: []byte("b"), Created: 1,
		}); err != nil {
			t.Fatal(err)
		}
	}
	for _, ref := range []string{"withdrawn", "standing"} {
		if err := repo.PutProposal(ctx, absenceRemove(g.GroupID, ref, true)); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := repo.WithdrawProposal(ctx, g.GroupID, []byte("withdrawn"), 5, 2); err != nil {
		t.Fatal(err)
	}

	if _, err := p.DownTo(ctx, 23); err != nil {
		t.Fatalf("down to 23: %v", err)
	}
	var n int
	if err := db.QueryRowContext(ctx, "SELECT COUNT(*) FROM mls_handshakes WHERE kind = 3").Scan(&n); err != nil || n != 0 {
		t.Fatalf("after down: %d kind-3 rows, %v; want none", n, err)
	}
	if err := db.QueryRowContext(ctx, "SELECT COUNT(*) FROM mls_handshakes").Scan(&n); err != nil || n != 2 {
		t.Fatalf("after down: %d handshakes, %v; want the other 2", n, err)
	}
	refs := proposalRefs(ctx, t, db)
	if len(refs) != 1 || refs[0] != "standing" {
		t.Fatalf("after down: proposals %v; want the standing one alone (a withdrawn one is deleted, not revived)", refs)
	}
	for _, col := range []string{"withdrawable", "withdrawn_at", "withdrawn_seq"} {
		if _, err := db.ExecContext(ctx, "SELECT "+col+" FROM mls_pending_proposals"); err == nil {
			t.Fatalf("after down: mls_pending_proposals.%s still exists", col)
		}
	}
	if _, err := db.ExecContext(ctx, insertKind3(pg), g.GroupID[:], []byte("b")); err == nil {
		t.Fatal("after down: mls_handshakes accepts kind 3")
	}

	if _, err := p.Up(ctx); err != nil {
		t.Fatalf("up again: %v", err)
	}
	if err := repo.AppendHandshake(ctx, store.HandshakeRow{
		GroupID: g.GroupID, Seq: 9, Epoch: 0, Kind: 3, Blob: []byte("b"), Created: 1,
	}); err != nil {
		t.Fatalf("after up again: kind 3 refused: %v", err)
	}
	live, err := repo.ListProposals(ctx, g.GroupID, 0, false)
	if err != nil || len(live) != 1 || live[0].Withdrawable {
		t.Fatalf("after up again: %+v, %v; want the standing row, its flag back at the default", live, err)
	}
}

// insertKind3 is a raw kind-3 insert in the engine's own placeholder dialect.
func insertKind3(pg bool) string {
	if pg {
		return "INSERT INTO mls_handshakes (group_id, seq, epoch, kind, sender_leaf, sender_device, blob, created) VALUES ($1, 99, 0, 3, NULL, NULL, $2, 1)"
	}
	return "INSERT INTO mls_handshakes (group_id, seq, epoch, kind, sender_leaf, sender_device, blob, created) VALUES (?, 99, 0, 3, NULL, NULL, ?, 1)"
}

// proposalRefs is every ref in mls_pending_proposals, read raw (the down step has dropped columns the
// repository's model names).
func proposalRefs(ctx context.Context, t *testing.T, db *sql.DB) []string {
	t.Helper()
	rows, err := db.QueryContext(ctx, "SELECT ref FROM mls_pending_proposals")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = rows.Close() }()
	var refs []string
	for rows.Next() {
		var ref []byte
		if err := rows.Scan(&ref); err != nil {
			t.Fatal(err)
		}
		refs = append(refs, string(ref))
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	return refs
}

// ClearWithdrawable takes the flag off for good: a re-issue of the tainted row carries false.
func TestClearWithdrawableIsATaintForGood(t *testing.T) {
	ctx := context.Background()
	for name, repo := range engines(t) {
		t.Run(name, func(t *testing.T) {
			g := seedGroup(ctx, t, repo, 1)
			if err := repo.PutProposal(ctx, absenceRemove(g.GroupID, "ref-t", true)); err != nil {
				t.Fatal(err)
			}
			if err := repo.ClearWithdrawable(ctx, g.GroupID, []byte("ref-t")); err != nil {
				t.Fatal(err)
			}
			if err := repo.ReissueProposal(ctx, []byte("ref-t"), absenceRemove(g.GroupID, "ref-t2", true)); err != nil {
				t.Fatal(err)
			}
			rows, err := repo.ListProposals(ctx, g.GroupID, 0, false)
			if err != nil || len(rows) != 1 || rows[0].Withdrawable {
				t.Fatalf("after the taint and a re-issue: %+v, %v; want one row, not withdrawable", rows, err)
			}
		})
	}
}
