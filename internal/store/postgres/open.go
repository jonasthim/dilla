// Package postgres is the Postgres half of dillad's storage. It opens through
// pgx/v5/stdlib so the same database/sql-shaped generated code serves both
// engines, and so goose's Provider (which takes *sql.DB) works unchanged.
package postgres

import (
	"context"
	"database/sql"
	"fmt"
	"time"

	_ "github.com/jackc/pgx/v5/stdlib"
)

// Open returns a pool over dsn. maxOpen 0 leaves database/sql's default.
func Open(dsn string, maxOpen int, connMaxLifetime time.Duration) (*sql.DB, error) {
	db, err := sql.Open("pgx", dsn)
	if err != nil {
		return nil, fmt.Errorf("postgres: open: %w", err)
	}
	if maxOpen > 0 {
		db.SetMaxOpenConns(maxOpen)
	}
	if connMaxLifetime > 0 {
		db.SetConnMaxLifetime(connMaxLifetime)
	}
	if err := db.PingContext(context.Background()); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("postgres: ping: %w", err)
	}
	return db, nil
}
