package store_test

import (
	"bytes"
	"context"
	"database/sql"
	"os"
	"testing"
	"time"

	"github.com/pressly/goose/v3"

	"github.com/jonasthim/dilla/internal/store"
	"github.com/jonasthim/dilla/internal/store/postgres"
	pgmigrations "github.com/jonasthim/dilla/internal/store/postgres/migrations"
)

// Migration 00024 (UP6b) survives a dump and a restore: the withdrawable flag, the withdrawal mark
// and a kind-3 handshake row land as they were (a binary COPY carries no column names).
func TestADumpRoundTripsAWithdrawal(t *testing.T) {
	dsn := os.Getenv("DILLA_TEST_PG")
	if dsn == "" {
		t.Skip("DILLA_TEST_PG is unset: Postgres tests run in CI's service container")
	}
	ctx := context.Background()
	open := func() (*sql.DB, string) {
		d := freshPostgresDSN(t, dsn)
		db, err := postgres.Open(d, 8, time.Hour)
		if err != nil {
			t.Fatalf("postgres Open: %v", err)
		}
		t.Cleanup(func() { db.Close() })
		p, err := goose.NewProvider(goose.DialectPostgres, db, pgmigrations.FS)
		if err != nil {
			t.Fatalf("postgres provider: %v", err)
		}
		if _, err := p.Up(ctx); err != nil {
			t.Fatalf("postgres up: %v", err)
		}
		return db, d
	}
	srcDB, srcDSN := open()
	src := postgres.New(srcDB)
	g := seedGroup(ctx, t, src, 1)
	for _, ref := range []string{"withdrawn", "standing"} {
		if err := src.PutProposal(ctx, absenceRemove(g.GroupID, ref, true)); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := src.WithdrawProposal(ctx, g.GroupID, []byte("withdrawn"), 42, 7); err != nil {
		t.Fatal(err)
	}
	if err := src.AppendHandshake(ctx, store.HandshakeRow{
		GroupID: g.GroupID, Seq: 7, Epoch: 0, Kind: 3, Blob: []byte{0x81, 0x41, 0x01}, Created: 1,
	}); err != nil {
		t.Fatal(err)
	}
	var buf bytes.Buffer
	if err := store.DumpPostgres(ctx, srcDSN, &buf); err != nil {
		t.Fatalf("DumpPostgres: %v", err)
	}
	dstDB, _ := open()
	if err := store.LoadPostgres(ctx, dstDB, &buf, nil); err != nil {
		t.Fatalf("LoadPostgres: %v", err)
	}
	dst := postgres.New(dstDB)
	w, err := dst.ListWithdrawnProposals(ctx, g.GroupID, 0)
	if err != nil || len(w) != 1 || !w[0].Withdrawable || w[0].WithdrawnAt == nil || *w[0].WithdrawnAt != 42 ||
		w[0].WithdrawnSeq == nil || *w[0].WithdrawnSeq != 7 {
		t.Fatalf("restored withdrawal: %+v, %v", w, err)
	}
	live, err := dst.ListProposals(ctx, g.GroupID, 0, false)
	if err != nil || len(live) != 1 || !live[0].Withdrawable || live[0].WithdrawnAt != nil {
		t.Fatalf("restored standing row: %+v, %v", live, err)
	}
	rows, err := dst.ListHandshakes(ctx, g.GroupID, 0, 10)
	if err != nil || len(rows) != 1 || rows[0].Kind != 3 {
		t.Fatalf("restored kind-3 row: %+v, %v", rows, err)
	}
}
