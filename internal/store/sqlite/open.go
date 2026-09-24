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
	"database/sql"
	"fmt"
	"strings"

	_ "modernc.org/sqlite"
	sqlite3 "modernc.org/sqlite/lib"
)

// Fails to compile on any GOOS/GOARCH where modernc's SQLite was transpiled
// without -DSQLITE_ENABLE_FTS5, i.e. at cross-build time rather than only in a
// test job.
var _ = [1]struct{}{}[1-sqlite3.SQLITE_ENABLE_FTS5]

// Open opens (and creates, if absent) the database at path in WAL mode with
// foreign keys on, and verifies the connection before returning. The caller owns
// the returned pool and closes it.
func Open(path string) (*sql.DB, error) {
	dsn := "file:" + path + "?_pragma=journal_mode(wal)&_pragma=foreign_keys(1)&_pragma=busy_timeout(5000)"
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, fmt.Errorf("sqlite: open %s: %w", path, err)
	}
	if err := db.Ping(); err != nil {
		db.Close()
		return nil, fmt.Errorf("sqlite: ping %s: %w", path, err)
	}
	return db, nil
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
func HasFTS5(db *sql.DB) (bool, error) {
	opts, err := CompileOptions(db)
	if err != nil {
		return false, err
	}
	for _, opt := range opts {
		if opt == "ENABLE_FTS5" || strings.HasPrefix(opt, "ENABLE_FTS5=") {
			return true, nil
		}
	}
	return false, nil
}
