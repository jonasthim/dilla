package ops_test

import (
	"bytes"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/pressly/goose/v3"

	"github.com/jonasthim/dilla/internal/clock"
	"github.com/jonasthim/dilla/internal/config"
	"github.com/jonasthim/dilla/internal/id"
	"github.com/jonasthim/dilla/internal/ops"
	"github.com/jonasthim/dilla/internal/store"
	"github.com/jonasthim/dilla/internal/store/postgres"
	pgmigrations "github.com/jonasthim/dilla/internal/store/postgres/migrations"
)

// The Postgres leg: db/dilla.dump is store.DumpPostgres's DILLADMP container,
// taken inside its one repeatable-read transaction, and the archive verifies.
func TestPostgresBackupArchivesTheDumpAndVerifies(t *testing.T) {
	dsn := os.Getenv("DILLA_TEST_PG")
	if dsn == "" {
		t.Skip("DILLA_TEST_PG is unset: Postgres tests run in CI's service container")
	}
	ctx := t.Context()
	db, err := postgres.Open(dsn, 8, time.Hour)
	if err != nil {
		t.Fatalf("postgres Open: %v", err)
	}
	p, err := goose.NewProvider(goose.DialectPostgres, db, pgmigrations.FS)
	if err != nil {
		t.Fatalf("postgres provider: %v", err)
	}
	if _, err := p.Up(ctx); err != nil {
		t.Fatalf("postgres up: %v", err)
	}
	repo := postgres.New(db)
	t.Cleanup(func() { _ = repo.Close() })
	// The CI database is shared by every package's Postgres leg: create the
	// instance row only when no earlier test did.
	if _, err := repo.GetInstance(ctx); errors.Is(err, store.ErrNotFound) {
		if err := repo.CreateInstance(ctx, store.InstanceRow{
			InstanceID: id.New(), ExternalSenderKeyID: id.New(), KeyHistory: []byte{0x82, 0x01, 0x80},
			FrankingKeyID: id.New(), Generation: 1, PolicyVersion: 1, Created: 1,
		}); err != nil {
			t.Fatalf("CreateInstance: %v", err)
		}
	} else if err != nil {
		t.Fatalf("GetInstance: %v", err)
	}

	dir := t.TempDir()
	c := config.Default()
	c.Instance.Domain = "dilla.test"
	c.Instance.DataDir = dir
	c.DB.Driver, c.DB.Path, c.DB.DSN = "postgres", "", dsn
	c.Blobs.Dir = filepath.Join(dir, "blobs")
	c.Derive()

	var buf bytes.Buffer
	man, err := ops.Backup(ctx, c, repo, ops.BackupOptions{Out: &buf, Clock: clock.NewFake(time.Unix(1_790_000_000, 0))})
	if err != nil {
		t.Fatalf("Backup: %v", err)
	}
	if man.Engine != "postgres" {
		t.Fatalf("engine = %q", man.Engine)
	}
	if names := tarNames(t, buf.Bytes()); names[1] != "dilla-backup/db/dilla.dump" {
		t.Fatalf("member 1 = %q, want the dump", names[1])
	}
	if dump := tarMember(t, buf.Bytes(), "dilla-backup/db/dilla.dump"); !strings.HasPrefix(string(dump), store.DumpMagic) {
		t.Fatalf("db/dilla.dump does not start with %q", store.DumpMagic)
	}
	if _, err := ops.Verify(ctx, bytes.NewReader(buf.Bytes())); err != nil {
		t.Fatalf("Verify: %v", err)
	}
}
