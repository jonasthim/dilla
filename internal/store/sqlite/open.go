// Package sqlite opens dillad's local SQLite database through
// modernc.org/sqlite, the pure-Go driver, so the release binary stays
// cgo-free.
//
// The driver name is "sqlite", not "sqlite3". FTS5 is compiled in: upstream
// passes -DSQLITE_ENABLE_FTS5 in the transpile command for every target,
// including linux/arm64, and the compile-time assertion below fails the build
// on any target where a future re-vendor drops it.
package sqlite

import (
	"context"
	"database/sql"
	"fmt"
	"net/url"
	"runtime"
	"sort"
	"strings"

	_ "modernc.org/sqlite"
	sqlite3 "modernc.org/sqlite/lib"
)

// Fails to compile on any GOOS/GOARCH where modernc's SQLite was transpiled
// without -DSQLITE_ENABLE_FTS5, i.e. at cross-build time rather than only in a
// test job.
var _ = [1]struct{}{}[1-sqlite3.SQLITE_ENABLE_FTS5]

// The path is percent-encoded into both DSNs. The DSN is a URI — modernc's
// newConn splits it at the first '?' and SQLite is opened with SQLITE_OPEN_URI —
// so a path containing '?' silently truncates the filename and turns the rest of
// the path into query parameters, losing the pragmas below and opening a
// different file from the one asked for. url.PathEscape also escapes '/', which
// is correct here: SQLite decodes %HH in the path component before using it as a
// filename, so the separators come back.
//
// AMENDED (task 3, fix round 2 — interfaces.md §4.7): the read DSN no longer
// carries `_pragma=journal_mode(WAL)`. `journal_mode` is a property of the file,
// not of the connection (facts-storage §2.3 claim 1), so on a `mode=ro`
// connection that pragma is a write: SQLite refuses it with `attempt to write a
// readonly database (8)` and OpenRead fails outright for every file no writer
// has yet put into WAL — a `VACUUM INTO` copy (§4.6's pre-migration backup) and
// a restored backup are both in the default rollback-journal mode, and `dillad
// doctor` and `dillad restore` open exactly those. The writer still sets WAL,
// which is where the setting belongs, and the pool that reads it back is the
// write pool (WantPragmas); the read pool checks WantReadPragmas.
const (
	writeDSNSuffix = "?_pragma=journal_mode(WAL)&_pragma=busy_timeout(5000)&_pragma=foreign_keys(ON)&_pragma=synchronous(NORMAL)&_txlock=immediate"
	readDSNSuffix  = "?mode=ro&_pragma=busy_timeout(5000)&_pragma=foreign_keys(ON)&_pragma=synchronous(NORMAL)"
)

// WantPragmas is what VerifyPragmas is called with after OpenWrite. The values
// are the strings SQLite reports, not the strings the DSN sets:
// synchronous(NORMAL) reads back as 1.
var WantPragmas = map[string]string{
	"journal_mode": "wal",
	"busy_timeout": "5000",
	"foreign_keys": "1",
	"synchronous":  "1",
}

// WantReadPragmas is what VerifyPragmas is called with after OpenRead. It is
// WantPragmas without journal_mode: the journal mode is a property of the FILE,
// not of the connection (facts-storage §2.3 claim 1), the writer owns it, and a
// mode=ro connection can neither set it nor be held to it — a `VACUUM INTO`
// copy and a freshly restored backup are both in the default rollback-journal
// mode until a writer opens them.
var WantReadPragmas = map[string]string{
	"busy_timeout": "5000",
	"foreign_keys": "1",
	"synchronous":  "1",
}

// OpenWrite opens the single-writer pool. SQLite permits one writer, so the pool
// is one connection: two would only queue inside the driver and turn a clean
// wait into SQLITE_BUSY. _txlock=immediate takes the write lock at BEGIN rather
// than at the first write, which is what makes busy_timeout actually apply.
func OpenWrite(path string) (*sql.DB, error) {
	db, err := sql.Open("sqlite", "file:"+url.PathEscape(path)+writeDSNSuffix)
	if err != nil {
		return nil, fmt.Errorf("sqlite: open write %s: %w", path, err)
	}
	db.SetMaxOpenConns(1)
	db.SetMaxIdleConns(1)
	db.SetConnMaxLifetime(0)
	if err := db.Ping(); err != nil {
		db.Close()
		return nil, fmt.Errorf("sqlite: ping write %s: %w", path, err)
	}
	return db, nil
}

// OpenRead opens the read pool: WAL readers do not block the writer, so the pool
// is as wide as the machine. It does not set the journal mode — see the DSN
// amendment above — so it opens a file in any journal mode, and the mode it
// reads back is whatever the writer left. Verify it with WantReadPragmas.
func OpenRead(path string) (*sql.DB, error) {
	db, err := sql.Open("sqlite", "file:"+url.PathEscape(path)+readDSNSuffix)
	if err != nil {
		return nil, fmt.Errorf("sqlite: open read %s: %w", path, err)
	}
	db.SetMaxOpenConns(runtime.NumCPU())
	db.SetMaxIdleConns(runtime.NumCPU())
	if err := db.Ping(); err != nil {
		db.Close()
		return nil, fmt.Errorf("sqlite: ping read %s: %w", path, err)
	}
	return db, nil
}

// VerifyPragmas reads every wanted pragma back. modernc silently ignores an
// unknown DSN key and an unknown pragma name (facts-storage §2.3), so a typo in
// the DSN is invisible without this call.
func VerifyPragmas(ctx context.Context, db *sql.DB, want map[string]string) error {
	names := make([]string, 0, len(want))
	for name := range want {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		var got string
		if err := db.QueryRowContext(ctx, "PRAGMA "+name).Scan(&got); err != nil {
			return fmt.Errorf("sqlite: read pragma %s: %w", name, err)
		}
		if !strings.EqualFold(got, want[name]) {
			return fmt.Errorf("sqlite: pragma %s is %q, want %q", name, got, want[name])
		}
	}
	return nil
}

// Open opens (and creates, if absent) the database at path.
//
// Deprecated: Open is the week-1 single-pool entry point, kept so the FTS5
// assertions keep compiling. dillad opens OpenWrite and OpenRead instead and
// hands both to sqlite.New.
func Open(path string) (*sql.DB, error) {
	return OpenWrite(path)
}

// CompileOptions returns the library's compile-time options.
func CompileOptions(db *sql.DB) ([]string, error) {
	rows, err := db.Query(`SELECT compile_options FROM pragma_compile_options`)
	if err != nil {
		return nil, fmt.Errorf("sqlite: pragma_compile_options: %w", err)
	}
	defer rows.Close()

	var opts []string
	for rows.Next() {
		var opt string
		if err := rows.Scan(&opt); err != nil {
			return nil, fmt.Errorf("sqlite: scan compile option: %w", err)
		}
		opts = append(opts, opt)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("sqlite: compile options: %w", err)
	}
	return opts, nil
}

// HasFTS5 reports whether the library was built with FTS5.
//
// The match is exact. SQLite's ctime.c prints boolean compile options bare and
// only options that carry a value as `NAME=value`; `SQLITE_ENABLE_FTS5` is in the
// boolean list, and the transpiled library this package links holds the string
// "ENABLE_FTS5" once and "ENABLE_FTS5=" not at all. A prefix arm for the `=`
// spelling matched nothing and only made the rule look conditional.
func HasFTS5(db *sql.DB) (bool, error) {
	opts, err := CompileOptions(db)
	if err != nil {
		return false, err
	}
	for _, opt := range opts {
		if opt == "ENABLE_FTS5" {
			return true, nil
		}
	}
	return false, nil
}
