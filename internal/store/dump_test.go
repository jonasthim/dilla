package store_test

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/binary"
	"net/url"
	"os"
	"path/filepath"
	"slices"
	"testing"
	"time"

	"github.com/pressly/goose/v3"

	"github.com/jonasthim/dilla/internal/store"
	"github.com/jonasthim/dilla/internal/store/postgres"
	pgmigrations "github.com/jonasthim/dilla/internal/store/postgres/migrations"
	"github.com/jonasthim/dilla/internal/store/sqlite"
	sqlitemigrations "github.com/jonasthim/dilla/internal/store/sqlite/migrations"
)

// TestVacuumIntoProducesAReadableCopy covers the pre-migration backup of
// interfaces.md §4.6 end to end: the copy is a plain database file carrying the
// source's rows and its goose version, so `dillad restore` needs no special
// case for it.
//
// The copy is opened with OpenRead, on purpose. VACUUM INTO writes the copy in
// SQLite's default rollback-journal mode rather than the source's WAL, so this
// is the exact file shape that the read DSN's `_pragma=journal_mode(WAL)` used
// to refuse with `attempt to write a readonly database (8)` — `dillad doctor`
// and `dillad restore` open such a file before any writer has touched it. The
// pragma is gone from the read DSN (§4.7 as amended by task 3 fix round 2), and
// the copy's journal mode is still logged so the evidence is in the test output.
func TestVacuumIntoProducesAReadableCopy(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	path := filepath.Join(dir, "source.db")

	write, err := sqlite.OpenWrite(path)
	if err != nil {
		t.Fatalf("sqlite OpenWrite: %v", err)
	}
	p, err := goose.NewProvider(goose.DialectSQLite3, write, sqlitemigrations.FS)
	if err != nil {
		t.Fatalf("sqlite provider: %v", err)
	}
	if _, err := p.Up(ctx); err != nil {
		t.Fatalf("sqlite up: %v", err)
	}
	read, err := sqlite.OpenRead(path)
	if err != nil {
		t.Fatalf("sqlite OpenRead: %v", err)
	}
	repo := sqlite.New(write, read)
	t.Cleanup(func() { repo.Close() })
	u := seedUser(ctx, t, repo)

	copyPath := filepath.Join(dir, "copy.db")
	if err := store.VacuumInto(ctx, write, copyPath); err != nil {
		t.Fatalf("VacuumInto: %v", err)
	}
	info, err := os.Stat(copyPath)
	if err != nil {
		t.Fatalf("stat copy: %v", err)
	}
	if info.Size() == 0 {
		t.Fatal("the vacuumed copy is empty")
	}

	// Before any writer touches the copy: a bare DSN, no pragmas, so the mode
	// read back is the file's own.
	probe, err := sql.Open("sqlite", "file:"+url.PathEscape(copyPath))
	if err != nil {
		t.Fatalf("open the copy bare: %v", err)
	}
	var mode string
	if err := probe.QueryRowContext(ctx, "PRAGMA journal_mode").Scan(&mode); err != nil {
		t.Fatalf("read the copy's journal mode: %v", err)
	}
	probe.Close()
	t.Logf("the VACUUM INTO copy is in journal_mode=%s (the source is wal)", mode)

	copyRead, err := sqlite.OpenRead(copyPath)
	if err != nil {
		t.Fatalf("OpenRead on the vacuumed copy: %v", err)
	}
	t.Cleanup(func() { copyRead.Close() })
	if err := sqlite.VerifyPragmas(ctx, copyRead, sqlite.WantReadPragmas); err != nil {
		t.Fatalf("VerifyPragmas on the vacuumed copy's read pool: %v", err)
	}
	copyRepo := sqlite.New(copyRead, copyRead)
	got, err := copyRepo.GetUser(ctx, u.ID)
	if err != nil {
		t.Fatalf("GetUser from the vacuumed copy: %v", err)
	}
	if got.Username != u.Username {
		t.Fatalf("copied username %q, want %q", got.Username, u.Username)
	}
	v, err := copyRepo.SchemaVersion(ctx)
	if err != nil {
		t.Fatalf("SchemaVersion on the vacuumed copy: %v", err)
	}
	if want := wantSchemaVersion(t); v != want {
		t.Fatalf("copied schema version = %d, want %d", v, want)
	}
}

// TestDumpPostgresWritesTheContainerFormat parses the DILLADMP container back:
// the magic, the version, one length-prefixed record per table in DumpTables
// order, and a users payload that is a well-formed binary COPY stream holding
// the seeded row. Plan 2's `dillad restore` is written against exactly this
// framing, so it is asserted here rather than discovered there.
func TestDumpPostgresWritesTheContainerFormat(t *testing.T) {
	dsn := os.Getenv("DILLA_TEST_PG")
	if dsn == "" {
		t.Skip("DILLA_TEST_PG is unset: Postgres tests run in CI's service container")
	}
	ctx := context.Background()
	dsn = freshPostgresDSN(t, dsn)

	db, err := postgres.Open(dsn, 8, time.Hour)
	if err != nil {
		t.Fatalf("postgres Open: %v", err)
	}
	t.Cleanup(func() { db.Close() })
	p, err := goose.NewProvider(goose.DialectPostgres, db, pgmigrations.FS)
	if err != nil {
		t.Fatalf("postgres provider: %v", err)
	}
	if _, err := p.Up(ctx); err != nil {
		t.Fatalf("postgres up: %v", err)
	}
	u := seedUser(ctx, t, postgres.New(db))

	var buf bytes.Buffer
	if err := store.DumpPostgres(ctx, dsn, &buf); err != nil {
		t.Fatalf("DumpPostgres: %v", err)
	}

	b := buf.Bytes()
	if len(b) < len(store.DumpMagic)+4 {
		t.Fatalf("the dump is %d bytes, too short for a prologue", len(b))
	}
	if magic := string(b[:len(store.DumpMagic)]); magic != store.DumpMagic {
		t.Fatalf("magic = %q, want %q", magic, store.DumpMagic)
	}
	off := len(store.DumpMagic)
	if version := binary.BigEndian.Uint32(b[off:]); version != store.DumpVersion {
		t.Fatalf("version = %d, want %d", version, store.DumpVersion)
	}
	off += 4

	var names []string
	payloads := map[string][]byte{}
	for off < len(b) {
		if off+4 > len(b) {
			t.Fatalf("truncated name length at offset %d", off)
		}
		nameLen := int(binary.BigEndian.Uint32(b[off:]))
		off += 4
		if off+nameLen+8 > len(b) {
			t.Fatalf("truncated record header at offset %d", off)
		}
		name := string(b[off : off+nameLen])
		off += nameLen
		payloadLen := int(binary.BigEndian.Uint64(b[off:]))
		off += 8
		if off+payloadLen > len(b) {
			t.Fatalf("record %q claims %d payload bytes, %d remain", name, payloadLen, len(b)-off)
		}
		names = append(names, name)
		payloads[name] = b[off : off+payloadLen]
		off += payloadLen
	}
	if off != len(b) {
		t.Fatalf("the records end at %d of %d bytes", off, len(b))
	}
	if !slices.Equal(names, store.DumpTables) {
		t.Fatalf("records %v, want %v", names, store.DumpTables)
	}

	// A binary COPY payload is the 11-byte signature, a 4-byte flags field and
	// a 4-byte header extension length, then the tuples, then the 0xFFFF
	// trailer. Anything else means the record framing swallowed or split a
	// payload.
	users := payloads["users"]
	if !bytes.HasPrefix(users, []byte("PGCOPY\n\xff\r\n\x00")) {
		t.Fatalf("the users payload is not a binary COPY stream: % x", users[:min(19, len(users))])
	}
	if !bytes.HasSuffix(users, []byte{0xff, 0xff}) {
		t.Fatal("the users payload does not end in the binary COPY trailer")
	}
	if !bytes.Contains(users, []byte(u.Username)) {
		t.Fatalf("the seeded user %q is not in the users payload", u.Username)
	}
}

// The upload class (web3.7 SB1, migration 00018) survives a dump and a restore: a binary COPY
// carries no column names, so a class the dump dropped or shifted would land as a wrong value
// or fail the COPY. One row with class 0 and one with NULL (a legacy upload).
func TestADumpRoundTripsTheUploadClass(t *testing.T) {
	dsn := os.Getenv("DILLA_TEST_PG")
	if dsn == "" {
		t.Skip("DILLA_TEST_PG is unset: Postgres tests run in CI's service container")
	}
	ctx := context.Background()
	open := func() (*sql.DB, string) {
		d := freshPostgresDSN(t, dsn)
		db, err := postgres.Open(d, 8, time.Hour)
		if err != nil {
			t.Fatalf("postgres Open: %v", err)
		}
		t.Cleanup(func() { db.Close() })
		p, err := goose.NewProvider(goose.DialectPostgres, db, pgmigrations.FS)
		if err != nil {
			t.Fatalf("postgres provider: %v", err)
		}
		if _, err := p.Up(ctx); err != nil {
			t.Fatalf("postgres up: %v", err)
		}
		return db, d
	}
	srcDB, srcDSN := open()
	src := postgres.New(srcDB)
	g := seedGroup(ctx, t, src, 1)
	zero := uint8(0)
	for seq, class := range map[uint64]*uint8{1: &zero, 2: nil} {
		if err := src.PutAppMessage(ctx, store.AppMessageRow{
			GroupID: g.GroupID, Seq: seq, Epoch: 1, UploaderDevice: g.GroupID, Blob: []byte("ct"),
			FrankingTag: make([]byte, 32), Size: 2, Created: 10, Class: class,
		}); err != nil {
			t.Fatalf("PutAppMessage(%d): %v", seq, err)
		}
	}
	var buf bytes.Buffer
	if err := store.DumpPostgres(ctx, srcDSN, &buf); err != nil {
		t.Fatalf("DumpPostgres: %v", err)
	}
	dstDB, _ := open()
	if err := store.LoadPostgres(ctx, dstDB, &buf, nil); err != nil {
		t.Fatalf("LoadPostgres: %v", err)
	}
	dst := postgres.New(dstDB)
	post, err := dst.GetAppMessage(ctx, g.GroupID, 1)
	if err != nil || post.Class == nil || *post.Class != 0 {
		t.Fatalf("restored class-0 row: class %v, %v; want 0", post.Class, err)
	}
	legacy, err := dst.GetAppMessage(ctx, g.GroupID, 2)
	if err != nil || legacy.Class != nil {
		t.Fatalf("restored legacy row: class %v, %v; want nil", legacy.Class, err)
	}
}
