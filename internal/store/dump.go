package store

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/binary"
	"fmt"
	"io"

	"github.com/jackc/pgx/v5"
)

// VacuumInto writes a consistent copy of an open SQLite database to path. It is
// the pre-migration backup of §4.6: VACUUM INTO takes a read lock rather than
// stopping the writer, and the copy is a plain database file, so `dillad
// restore` needs no special case for it.
func VacuumInto(ctx context.Context, db *sql.DB, path string) error {
	if _, err := db.ExecContext(ctx, `VACUUM INTO ?`, path); err != nil {
		return fmt.Errorf("store: vacuum into %s: %w", path, err)
	}
	return nil
}

// DumpMagic, DumpVersion and the record header below are the container format
// `dillad restore` parses. A text marker cannot be used: a binary COPY payload
// can contain any byte sequence, including "-- table ", so a text-delimited
// stream cannot be split back into per-table segments unambiguously. Each table
// is therefore a length-prefixed record, and the reader never scans for a
// delimiter.
//
//	file   = magic(8) || version(uint32 BE) || record*
//	record = nameLen(uint32 BE) || name || payloadLen(uint64 BE) || payload
const (
	DumpMagic   = "DILLADMP"
	DumpVersion = uint32(1)
)

// DumpTables is the replay order: parents before children. It grows with the
// schema — task 19 appends the mls_* tables, task 23 mls_app_messages, Plan 2
// the structure, readable and blob tables — and a restore replays it front to
// back.
var DumpTables = []string{
	"instances", "instance_settings", "users", "devices", "device_lists", "sessions",
	"password_credentials", "totp_secrets", "recovery_codes", "webauthn_users",
	"webauthn_credentials", "webauthn_ceremonies", "oidc_identities", "login_attempts",
	"invites", "reports", "audit_log",
	// 004_mls.sql, appended by task 19, parents before children: a group before
	// its handshakes, proposals and leaves, and a Welcome payload before the
	// per-device rows that reference it.
	"mls_groups", "mls_handshakes", "mls_pending_proposals", "mls_members",
	"mls_welcome_payloads", "mls_epoch_trees", "mls_welcomes", "key_packages",
	"device_cursors", "fork_reports",
	// 005_messages.sql, appended by task 23. Its only parent is mls_groups, so
	// it replays after the whole 004 block; a dump that omitted it would restore
	// an instance with every group intact and no message in any of them.
	"mls_app_messages",
	// 006_structure.sql, appended by Plan 2 task 1, parents before children: a
	// community before its members and roles, and both of those before the
	// member_roles rows that reference a (member, role) pair.
	"communities", "members", "roles", "member_roles",
}

// DumpPostgres writes a logical dump of dillad's tables to w using COPY TO.
// pg_dump is not assumed to exist on the host, which is why this is in-process.
//
// The whole dump runs inside ONE repeatable-read read-only transaction, so it is
// a snapshot: without it a write landing between two CopyTo calls yields a
// backup with a child row whose parent is missing, which D15/R38 cannot tolerate.
// Each table's payload is buffered so its length is known before the record
// header is written; the largest of these tables is bounded by the instance's
// account count, not by its message history.
func DumpPostgres(ctx context.Context, dsn string, w io.Writer) error {
	conn, err := pgx.Connect(ctx, dsn)
	if err != nil {
		return fmt.Errorf("store: connect for dump: %w", err)
	}
	defer func() { _ = conn.Close(ctx) }()
	tx, err := conn.BeginTx(ctx, pgx.TxOptions{
		IsoLevel:   pgx.RepeatableRead,
		AccessMode: pgx.ReadOnly,
	})
	if err != nil {
		return fmt.Errorf("store: begin dump snapshot: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	if _, err := io.WriteString(w, DumpMagic); err != nil {
		return fmt.Errorf("store: write dump magic: %w", err)
	}
	if err := binary.Write(w, binary.BigEndian, DumpVersion); err != nil {
		return fmt.Errorf("store: write dump version: %w", err)
	}
	for _, table := range DumpTables {
		var buf bytes.Buffer
		if _, err := tx.Conn().PgConn().CopyTo(ctx, &buf, `COPY `+table+` TO STDOUT (FORMAT binary)`); err != nil {
			return fmt.Errorf("store: copy %s: %w", table, err)
		}
		if err := binary.Write(w, binary.BigEndian, uint32(len(table))); err != nil { //nolint:gosec // G115: the length of a table name from the fixed DumpTables list
			return fmt.Errorf("store: write dump header for %s: %w", table, err)
		}
		if _, err := io.WriteString(w, table); err != nil {
			return fmt.Errorf("store: write dump header for %s: %w", table, err)
		}
		if err := binary.Write(w, binary.BigEndian, uint64(buf.Len())); err != nil { //nolint:gosec // G115: a buffer length is never negative
			return fmt.Errorf("store: write dump header for %s: %w", table, err)
		}
		if _, err := buf.WriteTo(w); err != nil {
			return fmt.Errorf("store: write dump payload for %s: %w", table, err)
		}
	}
	return tx.Commit(ctx)
}
