package sqlite

import (
	"database/sql"
	"path/filepath"
	"runtime"
	"slices"
	"testing"
)

func openTestDB(t *testing.T) *sql.DB {
	t.Helper()
	db, err := Open(filepath.Join(t.TempDir(), "dilla-test.db"))
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	t.Cleanup(func() {
		if err := db.Close(); err != nil {
			t.Errorf("Close: %v", err)
		}
	})
	return db
}

func TestHasFTS5(t *testing.T) {
	db := openTestDB(t)
	ok, err := HasFTS5(db)
	if err != nil {
		t.Fatalf("HasFTS5: %v", err)
	}
	if !ok {
		opts, _ := CompileOptions(db)
		t.Fatalf("ENABLE_FTS5 is not in pragma_compile_options; modernc.org/sqlite was transpiled "+
			"without -DSQLITE_ENABLE_FTS5 for %s/%s. compile_options = %v",
			runtime.GOOS, runtime.GOARCH, opts)
	}
}

func TestCompileOptionsAreReadable(t *testing.T) {
	db := openTestDB(t)
	opts, err := CompileOptions(db)
	if err != nil {
		t.Fatalf("CompileOptions: %v", err)
	}
	if len(opts) == 0 {
		t.Fatal("pragma_compile_options returned no rows")
	}
	for _, want := range []string{"ENABLE_FTS5", "THREADSAFE=1"} {
		if !slices.Contains(opts, want) {
			t.Errorf("compile_options is missing %q: %v", want, opts)
		}
	}
}

// The real check: an fts5 virtual table, an insert, a MATCH and highlight().
func TestFTS5VirtualTableMatchesAndHighlights(t *testing.T) {
	db := openTestDB(t)

	if _, err := db.ExecContext(t.Context(),
		`CREATE VIRTUAL TABLE msgs USING fts5(body, channel_id UNINDEXED, tokenize='unicode61')`,
	); err != nil {
		t.Fatalf("CREATE VIRTUAL TABLE ... USING fts5: %v", err)
	}
	if _, err := db.ExecContext(t.Context(),
		`INSERT INTO msgs (body, channel_id) VALUES (?, ?), (?, ?)`,
		"hello encrypted world", "c1",
		"nothing to see here", "c2",
	); err != nil {
		t.Fatalf("INSERT: %v", err)
	}

	var body, highlighted, channel string
	row := db.QueryRowContext(t.Context(),
		`SELECT body, highlight(msgs, 0, '[', ']'), channel_id FROM msgs WHERE msgs MATCH ?`,
		"encrypted")
	if err := row.Scan(&body, &highlighted, &channel); err != nil {
		t.Fatalf("MATCH query: %v", err)
	}
	if body != "hello encrypted world" {
		t.Errorf("body = %q", body)
	}
	if highlighted != "hello [encrypted] world" {
		t.Errorf("highlight = %q, want %q", highlighted, "hello [encrypted] world")
	}
	if channel != "c1" {
		t.Errorf("channel_id = %q, want c1", channel)
	}

	var n int
	if err := db.QueryRowContext(t.Context(), `SELECT count(*) FROM msgs WHERE msgs MATCH ?`, "nothing").Scan(&n); err != nil {
		t.Fatalf("second MATCH: %v", err)
	}
	if n != 1 {
		t.Errorf("MATCH 'nothing' returned %d rows, want 1", n)
	}
}

// VACUUM INTO is the pre-migration backup the spec's "Upgrades" section wants.
func TestVacuumIntoWorks(t *testing.T) {
	db := openTestDB(t)
	if _, err := db.ExecContext(t.Context(), `CREATE TABLE t (a TEXT)`); err != nil {
		t.Fatalf("CREATE TABLE: %v", err)
	}
	backup := filepath.Join(t.TempDir(), "backup.db")
	if _, err := db.ExecContext(t.Context(), `VACUUM INTO ?`, backup); err != nil {
		t.Fatalf("VACUUM INTO: %v", err)
	}
}
