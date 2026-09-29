package sqlite

import (
	"context"
	"database/sql"
	"net/url"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// The DSN is a URI: everything after the first `?` is query parameters, to both
// modernc.org/sqlite (`strings.IndexRune(dsn, '?')` in conn.go's newConn) and
// SQLite itself, which is opened with SQLITE_OPEN_URI. A path carrying `?` or `&`
// concatenated raw into that string therefore does not name the file the caller
// asked for: the tail of the path is read as parameters, the connection either
// fails or silently opens some other file, and the three `_pragma` settings this
// package exists to apply are lost. dillad's database path comes from
// configuration, so this is reachable without anything exotic — a directory with
// a `?` in its name is enough.
func TestOpenHandlesAPathWithURIMetacharacters(t *testing.T) {
	dir := t.TempDir()
	// `&` alone is harmless in the path half of a URI; `?` is what splits it. Both
	// are in one name so a fix that only escapes one of them is caught.
	path := filepath.Join(dir, "dilla?a&b.db")

	db, err := Open(path)
	if err != nil {
		t.Fatalf("Open(%q): %v", path, err)
	}
	defer db.Close()

	if _, err := db.ExecContext(t.Context(), `CREATE TABLE t (x INTEGER)`); err != nil {
		t.Fatalf("Exec: %v", err)
	}

	// The file the caller named, at the path the caller named — not a neighbour
	// whose name is the path truncated at the `?`.
	if _, err := os.Stat(path); err != nil {
		t.Errorf("no database at the requested path: %v", err)
	}

	// The pragmas still arrive: they are the part of the DSN a mis-parsed path
	// eats first.
	var journal string
	if err := db.QueryRowContext(t.Context(), `PRAGMA journal_mode`).Scan(&journal); err != nil {
		t.Fatalf("PRAGMA journal_mode: %v", err)
	}
	if journal != "wal" {
		t.Errorf("journal_mode = %q, want %q", journal, "wal")
	}
	var foreignKeys int
	if err := db.QueryRowContext(t.Context(), `PRAGMA foreign_keys`).Scan(&foreignKeys); err != nil {
		t.Fatalf("PRAGMA foreign_keys: %v", err)
	}
	if foreignKeys != 1 {
		t.Errorf("foreign_keys = %d, want 1", foreignKeys)
	}
}

// An ordinary path must keep working, and must still land exactly where it was
// asked to: percent-encoding is only correct if SQLite decodes it back.
func TestOpenStillOpensAnOrdinaryPath(t *testing.T) {
	path := filepath.Join(t.TempDir(), "sub dir", "dilla.db")
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatalf("MkdirAll: %v", err)
	}

	db, err := Open(path)
	if err != nil {
		t.Fatalf("Open(%q): %v", path, err)
	}
	defer db.Close()

	if _, err := db.ExecContext(t.Context(), `CREATE TABLE t (x INTEGER)`); err != nil {
		t.Fatalf("Exec: %v", err)
	}
	if _, err := os.Stat(path); err != nil {
		t.Errorf("no database at the requested path: %v", err)
	}
}

// SQLite permits exactly one writer, so the write pool is one connection: a
// second would only queue inside the driver and turn a clean wait into
// SQLITE_BUSY.
func TestOpenWriteIsASingleConnection(t *testing.T) {
	path := filepath.Join(t.TempDir(), "pool.db")
	db, err := OpenWrite(path)
	if err != nil {
		t.Fatalf("OpenWrite: %v", err)
	}
	defer db.Close()
	if got := db.Stats().MaxOpenConnections; got != 1 {
		t.Fatalf("MaxOpenConnections = %d, want 1", got)
	}
}

func TestVerifyPragmasReadsTheValuesBack(t *testing.T) {
	path := filepath.Join(t.TempDir(), "pragma.db")
	db, err := OpenWrite(path)
	if err != nil {
		t.Fatalf("OpenWrite: %v", err)
	}
	defer db.Close()
	want := map[string]string{"journal_mode": "wal", "foreign_keys": "1", "busy_timeout": "5000", "synchronous": "1"}
	if err := VerifyPragmas(context.Background(), db, want); err != nil {
		t.Fatalf("VerifyPragmas: %v", err)
	}
	if err := VerifyPragmas(context.Background(), db, map[string]string{"journal_mode": "delete"}); err == nil {
		t.Fatal("VerifyPragmas accepted a value the database does not have")
	}
}

func TestMistypedDSNKeyIsCaught(t *testing.T) {
	path := filepath.Join(t.TempDir(), "typo.db")
	// modernc silently ignores an unknown _pragma name, so the only way a typo
	// surfaces is the read-back (facts-storage §2.3).
	db, err := sql.Open("sqlite", "file:"+url.PathEscape(path)+"?_pragma=journal_mod(WAL)")
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	defer db.Close()
	if err := db.PingContext(t.Context()); err != nil {
		t.Fatalf("ping: %v", err)
	}
	if err := VerifyPragmas(context.Background(), db, map[string]string{"journal_mode": "wal"}); err == nil {
		t.Fatal("a mistyped pragma key went unnoticed")
	}
}

func TestSecondWriterBlocksThenReturnsBusy(t *testing.T) {
	path := filepath.Join(t.TempDir(), "busy.db")
	a, err := OpenWrite(path)
	if err != nil {
		t.Fatalf("OpenWrite a: %v", err)
	}
	defer a.Close()
	if _, err := a.ExecContext(t.Context(), `CREATE TABLE t (v INTEGER NOT NULL) STRICT`); err != nil {
		t.Fatalf("create: %v", err)
	}
	b, err := OpenWrite(path)
	if err != nil {
		t.Fatalf("OpenWrite b: %v", err)
	}
	defer b.Close()
	tx, err := a.BeginTx(t.Context(), nil)
	if err != nil {
		t.Fatalf("begin: %v", err)
	}
	if _, err := tx.ExecContext(t.Context(), `INSERT INTO t (v) VALUES (1)`); err != nil {
		t.Fatalf("insert: %v", err)
	}
	start := time.Now()
	_, err = b.ExecContext(t.Context(), `INSERT INTO t (v) VALUES (2)`)
	elapsed := time.Since(start)
	if err == nil {
		t.Fatal("the second writer succeeded while the first transaction was open")
	}
	if elapsed < 4*time.Second {
		t.Fatalf("the second writer gave up after %s; busy_timeout(5000) means it waits ~5s", elapsed)
	}
	if err := tx.Rollback(); err != nil {
		t.Fatalf("rollback: %v", err)
	}
}
