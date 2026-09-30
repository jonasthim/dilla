package postgres

import (
	"context"
	"database/sql"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/pressly/goose/v3"

	"github.com/jonasthim/dilla/internal/id"
	"github.com/jonasthim/dilla/internal/store"
	"github.com/jonasthim/dilla/internal/store/postgres/migrations"
)

// newPostgresRepo opens and migrates the CI database, or skips.
func newPostgresRepo(t *testing.T) (store.Repository, *sql.DB) {
	t.Helper()
	dsn := os.Getenv("DILLA_TEST_PG")
	if dsn == "" {
		t.Skip("DILLA_TEST_PG is unset: no local Postgres server on this box; CI's postgres service container runs this test")
	}
	db, err := Open(dsn, 4, time.Hour)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	p, err := goose.NewProvider(goose.DialectPostgres, db, migrations.FS)
	if err != nil {
		t.Fatalf("goose provider: %v", err)
	}
	if _, err := p.Up(context.Background()); err != nil {
		t.Fatalf("goose up: %v", err)
	}
	repo := New(db)
	t.Cleanup(func() { _ = repo.Close() })
	return repo, db
}

// seedSearchCorpus writes a handful of messages into one readable channel. The
// plan assertion needs rows to exist, not a particular corpus; the shared
// cross-engine corpus lives in internal/store's search_test.go.
func seedSearchCorpus(t *testing.T, repo store.Repository) []id.ID {
	t.Helper()
	ctx := context.Background()
	owner := id.New()
	if err := repo.CreateUser(ctx, store.UserRow{
		ID: owner, Username: "plan" + owner.String()[:8], Display: "Plan", UMKPub: make([]byte, 32),
		SSKPub: make([]byte, 32), SigUMKSSK: make([]byte, 64), Created: 1,
	}); err != nil {
		t.Fatalf("CreateUser: %v", err)
	}
	cid := id.New()
	if err := repo.CreateCommunity(ctx, store.CommunityRow{
		ID: cid, Owner: owner, Name: "c", PolicyJSON: []byte(`{}`), PolicyVersion: 1, Created: 1,
	}); err != nil {
		t.Fatalf("CreateCommunity: %v", err)
	}
	ch := store.ChannelRow{
		ID: id.New(), CommunityID: &cid, Kind: 0, Mode: 1, Visibility: 2, Name: "readable",
		SettingsJSON: []byte(`{}`), HostPolicyVersion: 1, Created: 1,
	}
	if err := repo.CreateChannel(ctx, ch); err != nil {
		t.Fatalf("CreateChannel: %v", err)
	}
	for _, body := range []string{"hej vad händer med krypteringen", "kryptering", "the server never sees plaintext"} {
		seq, err := repo.NextChannelSeq(ctx, ch.ID)
		if err != nil {
			t.Fatalf("NextChannelSeq: %v", err)
		}
		if _, err := repo.PutReadableMessage(ctx, store.ReadableMessageRow{
			ChannelID: ch.ID, ChannelHex: ch.ID.String(), Seq: seq, Sender: owner, Envelope: []byte{0x80},
			Body: body, FrankingTag: make([]byte, 32), FrankingKeyID: id.New(), Created: 1,
		}); err != nil {
			t.Fatalf("PutReadableMessage: %v", err)
		}
	}
	return []id.ID{ch.ID}
}

// The statement the repository runs must reach the composite GIN index, and the
// bound configuration must keep the tsquery a scan constant rather than a
// row-derived Function Scan (gap-69 §3.5). A handful of rows would plan as a
// sequential scan whatever the indexes, so this session turns sequential scans
// off: the assertion is that the index is USABLE by this exact statement.
func TestSearchUsesTheCompositeGINIndex(t *testing.T) {
	repo, db := newPostgresRepo(t)
	chans := seedSearchCorpus(t, repo)
	q, err := store.ParseQuery("kryptering")
	if err != nil {
		t.Fatalf("ParseQuery: %v", err)
	}
	ctx := t.Context()
	conn, err := db.Conn(ctx)
	if err != nil {
		t.Fatalf("Conn: %v", err)
	}
	defer conn.Close()
	if _, err := conn.ExecContext(ctx, `SET enable_seqscan = off`); err != nil {
		t.Fatalf("SET enable_seqscan: %v", err)
	}
	rows, err := conn.QueryContext(ctx, `EXPLAIN (FORMAT TEXT) `+searchSQL, searchConfig, q.TSQuery(),
		byteaArray(store.ReadableSearchQuery{ChannelIDs: chans}), int64(0), int64(20))
	if err != nil {
		t.Fatalf("EXPLAIN: %v", err)
	}
	defer func() { _ = rows.Close() }()
	var lines []string
	for rows.Next() {
		var line string
		if err := rows.Scan(&line); err != nil {
			t.Fatalf("scan: %v", err)
		}
		lines = append(lines, line)
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("rows: %v", err)
	}
	plan := strings.Join(lines, "\n")
	if !strings.Contains(plan, "readable_messages_fts") {
		t.Fatalf("the plan does not use the composite GIN index:\n%s", plan)
	}
	if strings.Contains(plan, "Function Scan") {
		t.Fatalf("the tsquery became a row-derived Function Scan:\n%s", plan)
	}

	// And the statement itself answers, through the repository.
	hits, err := repo.SearchReadable(ctx, store.ReadableSearchQuery{ChannelIDs: chans, Query: q, Limit: 20})
	if err != nil || len(hits) != 1 {
		t.Fatalf("SearchReadable = %d hits, %v; want the one exact kryptering", len(hits), err)
	}
}
