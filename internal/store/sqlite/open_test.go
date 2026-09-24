package sqlite

import (
	"os"
	"path/filepath"
	"testing"
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

	if _, err := db.Exec(`CREATE TABLE t (x INTEGER)`); err != nil {
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
	if err := db.QueryRow(`PRAGMA journal_mode`).Scan(&journal); err != nil {
		t.Fatalf("PRAGMA journal_mode: %v", err)
	}
	if journal != "wal" {
		t.Errorf("journal_mode = %q, want %q", journal, "wal")
	}
	var foreignKeys int
	if err := db.QueryRow(`PRAGMA foreign_keys`).Scan(&foreignKeys); err != nil {
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

	if _, err := db.Exec(`CREATE TABLE t (x INTEGER)`); err != nil {
		t.Fatalf("Exec: %v", err)
	}
	if _, err := os.Stat(path); err != nil {
		t.Errorf("no database at the requested path: %v", err)
	}
}
