package sqlite

import (
	"context"
	"database/sql"
	"net/url"
	"path/filepath"
	"testing"
)

// A database file that no writer has ever put into WAL — a `VACUUM INTO` copy,
// a restored backup, a file handed over by an operator — must still open
// read-only. `journal_mode` is a property of the FILE, not of the connection
// (facts-storage §2.3 claim 1), so a read DSN carrying
// `_pragma=journal_mode(WAL)` asks a `mode=ro` connection to rewrite the file;
// SQLite answers `attempt to write a readonly database (8)`, the open fails,
// and every later reader of that file is locked out.
func TestOpenReadOpensAFileNoWriterPutIntoWAL(t *testing.T) {
	path := filepath.Join(t.TempDir(), "rollback-journal.db")

	// A bare DSN — no pragmas — so the file keeps SQLite's default rollback
	// journal, exactly as `VACUUM INTO` leaves its copy.
	seed, err := sql.Open("sqlite", "file:"+url.PathEscape(path))
	if err != nil {
		t.Fatalf("open the seed connection: %v", err)
	}
	if _, err := seed.ExecContext(t.Context(), `CREATE TABLE t (v INTEGER NOT NULL) STRICT`); err != nil {
		t.Fatalf("create: %v", err)
	}
	if _, err := seed.ExecContext(t.Context(), `INSERT INTO t (v) VALUES (7)`); err != nil {
		t.Fatalf("insert: %v", err)
	}
	if err := seed.Close(); err != nil {
		t.Fatalf("close the seed connection: %v", err)
	}

	db, err := OpenRead(path)
	if err != nil {
		t.Fatalf("OpenRead on a file that is not in WAL: %v", err)
	}
	defer db.Close()

	var v int
	if err := db.QueryRowContext(t.Context(), `SELECT v FROM t`).Scan(&v); err != nil {
		t.Fatalf("read through the read pool: %v", err)
	}
	if v != 7 {
		t.Fatalf("v = %d, want 7", v)
	}

	// The read pool's wanted set must not name journal_mode: the value it reads
	// back here is the file's own ("delete"), and a read-only pool has no
	// business asserting the writer's choice.
	if _, ok := WantReadPragmas["journal_mode"]; ok {
		t.Fatal("WantReadPragmas names journal_mode; a read-only pool can neither set nor require it")
	}
	if err := VerifyPragmas(context.Background(), db, WantReadPragmas); err != nil {
		t.Fatalf("VerifyPragmas on the read pool: %v", err)
	}
}

// The write pool is the one that owns the file's journal mode, so its wanted
// set keeps journal_mode and OpenWrite still leaves the file in WAL.
func TestOpenWriteStillPutsTheFileIntoWAL(t *testing.T) {
	path := filepath.Join(t.TempDir(), "wal.db")
	db, err := OpenWrite(path)
	if err != nil {
		t.Fatalf("OpenWrite: %v", err)
	}
	defer db.Close()
	if want := WantPragmas["journal_mode"]; want != "wal" {
		t.Fatalf("WantPragmas[journal_mode] = %q, want %q", want, "wal")
	}
	if err := VerifyPragmas(context.Background(), db, WantPragmas); err != nil {
		t.Fatalf("VerifyPragmas on the write pool: %v", err)
	}
}
