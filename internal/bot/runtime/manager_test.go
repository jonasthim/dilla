package runtime

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/jonasthim/dilla/internal/id"
	"github.com/jonasthim/dilla/internal/store"
	"github.com/jonasthim/dilla/internal/store/sqlite"
	"github.com/jonasthim/dilla/internal/store/sqlite/migrations"
	"github.com/pressly/goose/v3"
)

func testRepository(t *testing.T) store.Repository {
	t.Helper()
	path := t.TempDir() + "/runtime.db"
	write, err := sqlite.OpenWrite(path)
	if err != nil {
		t.Fatal(err)
	}
	p, err := goose.NewProvider(goose.DialectSQLite3, write, migrations.FS)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := p.Up(t.Context()); err != nil {
		t.Fatal(err)
	}
	read, err := sqlite.OpenRead(path)
	if err != nil {
		t.Fatal(err)
	}
	repo := sqlite.New(write, read)
	t.Cleanup(func() { _ = repo.Close() })
	return repo
}

func TestManagerCreatesRotatesAndRevokesOpaqueRuntimeCredential(t *testing.T) {
	repo := testRepository(t)
	clock := func() time.Time { return time.Unix(1_800_000_000, 0) }
	m := New(repo, clock)
	ctx := context.Background()
	var created string
	runtimeID, err := m.Create(ctx, func(_ id.ID, token string) error { created = token; return nil })
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	if !strings.HasPrefix(created, "dbr_") || strings.Contains(created, "=") {
		t.Fatalf("credential shape is not opaque unpadded dbr_: %q", created)
	}
	if got, err := m.Authenticate(ctx, created); err != nil || got != runtimeID {
		t.Fatalf("Authenticate: %s, %v", got, err)
	}
	if err := m.Rotate(ctx, runtimeID, func(_ id.ID, token string) error { return errors.New("write failed") }); err == nil {
		t.Fatal("failed protected write accepted")
	}
	if got, err := m.Authenticate(ctx, created); err != nil || got != runtimeID {
		t.Fatalf("old credential after failed write: %s, %v", got, err)
	}
	var rotated string
	if err := m.Rotate(ctx, runtimeID, func(_ id.ID, token string) error { rotated = token; return nil }); err != nil {
		t.Fatalf("Rotate: %v", err)
	}
	if _, err := m.Authenticate(ctx, created); !errors.Is(err, ErrUnauthorized) {
		t.Fatalf("old credential after rotation = %v", err)
	}
	if got, err := m.Authenticate(ctx, rotated); err != nil || got != runtimeID {
		t.Fatalf("Authenticate rotated: %s, %v", got, err)
	}
	if err := m.Revoke(ctx, runtimeID); err != nil {
		t.Fatalf("Revoke: %v", err)
	}
	if _, err := m.Authenticate(ctx, rotated); !errors.Is(err, ErrUnauthorized) {
		t.Fatalf("credential after revocation = %v", err)
	}
	if err := m.Rotate(ctx, runtimeID, func(_ id.ID, _ string) error { return nil }); !errors.Is(err, store.ErrConflict) {
		t.Fatalf("rotate revoked runtime = %v", err)
	}
}

func TestManagerCreateRollsBackWhenSecretWriterFails(t *testing.T) {
	repo := testRepository(t)
	m := New(repo, func() time.Time { return time.Unix(1_800_000_000, 0) })
	if _, err := m.Create(context.Background(), func(id.ID, string) error { return errors.New("disk full") }); err == nil {
		t.Fatal("Create with failed secret writer succeeded")
	}
	if rows, err := repo.ListBotRuntimes(context.Background(), id.ID{}, 100); err != nil || len(rows) != 0 {
		t.Fatalf("runtime rows after failed writer: %d, %v", len(rows), err)
	}
}

func TestManagerCreateRollsBackWhenTransactionCannotCommit(t *testing.T) {
	repo := testRepository(t)
	m := New(repo, func() time.Time { return time.Unix(1_800_000_000, 0) })
	ctx, cancel := context.WithCancel(context.Background())
	_, err := m.Create(ctx, func(id.ID, string) error { cancel(); return nil })
	if err == nil {
		t.Fatal("Create committed after its transaction context was canceled")
	}
	if rows, err := repo.ListBotRuntimes(context.Background(), id.ID{}, 100); err != nil || len(rows) != 0 {
		t.Fatalf("runtime rows after failed commit: %d, %v", len(rows), err)
	}
}
