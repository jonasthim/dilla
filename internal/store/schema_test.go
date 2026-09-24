package store_test

import (
	"context"
	"database/sql"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"testing"

	_ "github.com/jackc/pgx/v5/stdlib"
	pgmigrations "github.com/jonasthim/dilla/internal/store/postgres/migrations"
	"github.com/jonasthim/dilla/internal/store/postgres/pgdb"
	sqlitemigrations "github.com/jonasthim/dilla/internal/store/sqlite/migrations"
	"github.com/jonasthim/dilla/internal/store/sqlite/sqlitedb"
	"github.com/pressly/goose/v3"
	_ "modernc.org/sqlite"
)

// methodShapes returns one line per method of an interface type: its name, its
// arity and the KIND of every parameter and result, with struct parameters
// spelled out field by field. Names alone would pass while one engine returned
// :many where the other returned :one, or took one parameter more — which is
// precisely the drift this test exists to catch, and which would otherwise only
// surface when postgres/repo.go is written in task 3. The two param structs
// live in different packages, so their identity can never be equal; their field
// names and kinds can.
func methodShapes(t reflect.Type) []string {
	out := make([]string, 0, t.NumMethod())
	for i := 0; i < t.NumMethod(); i++ {
		m := t.Method(i)
		parts := []string{m.Name}
		for j := 0; j < m.Type.NumIn(); j++ {
			parts = append(parts, "in:"+shape(m.Type.In(j)))
		}
		for j := 0; j < m.Type.NumOut(); j++ {
			parts = append(parts, "out:"+shape(m.Type.Out(j)))
		}
		out = append(out, strings.Join(parts, " "))
	}
	sort.Strings(out)
	return out
}

func shape(t reflect.Type) string {
	switch t.Kind() {
	case reflect.Slice, reflect.Ptr:
		return t.Kind().String() + "<" + shape(t.Elem()) + ">"
	case reflect.Struct:
		fields := make([]string, 0, t.NumField())
		for i := 0; i < t.NumField(); i++ {
			f := t.Field(i)
			fields = append(fields, f.Name+":"+shape(f.Type))
		}
		return "struct{" + strings.Join(fields, ",") + "}"
	default:
		return t.Kind().String()
	}
}

func TestQuerierInterfacesAreIdentical(t *testing.T) {
	a := methodShapes(reflect.TypeOf((*sqlitedb.Querier)(nil)).Elem())
	b := methodShapes(reflect.TypeOf((*pgdb.Querier)(nil)).Elem())
	if !reflect.DeepEqual(a, b) {
		t.Fatalf("Querier method shapes diverge:\nsqlite: %v\npg:     %v", a, b)
	}
	if len(a) == 0 {
		t.Fatal("no generated queries at all")
	}
}

// The shapes above can only be identical if the two query sets declare the same
// names with the same annotations, so the header lines are compared directly as
// well: a `:one` that should be `:many` is a one-word diff here and a confusing
// type error three tasks later.
func TestQueryHeadersAreByteIdenticalAcrossEngines(t *testing.T) {
	headers := func(dir string) []string {
		entries, err := os.ReadDir(filepath.Join(dir, "queries"))
		if err != nil {
			t.Fatalf("read %s/queries: %v", dir, err)
		}
		var out []string
		for _, e := range entries {
			body, err := os.ReadFile(filepath.Join(dir, "queries", e.Name()))
			if err != nil {
				t.Fatalf("read %s: %v", e.Name(), err)
			}
			for _, line := range strings.Split(string(body), "\n") {
				if strings.HasPrefix(line, "-- name:") {
					out = append(out, strings.TrimSpace(line))
				}
			}
		}
		sort.Strings(out)
		return out
	}
	a, b := headers("sqlite"), headers("postgres")
	if !reflect.DeepEqual(a, b) {
		t.Fatalf("query headers diverge:\nsqlite: %v\npg:     %v", a, b)
	}
}

func openSQLite(t *testing.T) *sql.DB {
	t.Helper()
	db, err := sql.Open("sqlite", "file:"+filepath.Join(t.TempDir(), "schema.db")+"?_pragma=foreign_keys(ON)")
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	t.Cleanup(func() { db.Close() })
	return db
}

func TestGooseUpDownUpOnSQLite(t *testing.T) {
	db := openSQLite(t)
	p, err := goose.NewProvider(goose.DialectSQLite3, db, sqlitemigrations.FS)
	if err != nil {
		t.Fatalf("provider: %v", err)
	}
	ctx := context.Background()
	if _, err := p.Up(ctx); err != nil {
		t.Fatalf("up: %v", err)
	}
	if _, err := p.Down(ctx); err != nil {
		t.Fatalf("down: %v", err)
	}
	if _, err := p.Up(ctx); err != nil {
		t.Fatalf("second up: %v", err)
	}
	current, target, err := p.GetVersions(ctx)
	if err != nil {
		t.Fatalf("versions: %v", err)
	}
	if current != target {
		t.Fatalf("current %d != target %d after up", current, target)
	}
}

func TestGooseUpDownUpOnPostgres(t *testing.T) {
	dsn := os.Getenv("DILLA_TEST_PG")
	if dsn == "" {
		t.Skip("DILLA_TEST_PG is unset: no local Postgres server on this box; CI's postgres service container runs this test")
	}
	db, err := sql.Open("pgx", dsn)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	defer db.Close()
	p, err := goose.NewProvider(goose.DialectPostgres, db, pgmigrations.FS)
	if err != nil {
		t.Fatalf("provider: %v", err)
	}
	ctx := context.Background()
	if _, err := p.Up(ctx); err != nil {
		t.Fatalf("up: %v", err)
	}
	if _, err := p.Down(ctx); err != nil {
		t.Fatalf("down: %v", err)
	}
	if _, err := p.Up(ctx); err != nil {
		t.Fatalf("second up: %v", err)
	}
}

func TestEverySQLiteTableIsStrictAndTyped(t *testing.T) {
	db := openSQLite(t)
	p, err := goose.NewProvider(goose.DialectSQLite3, db, sqlitemigrations.FS)
	if err != nil {
		t.Fatalf("provider: %v", err)
	}
	if _, err := p.Up(context.Background()); err != nil {
		t.Fatalf("up: %v", err)
	}
	rows, err := db.Query(`SELECT name, sql FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`)
	if err != nil {
		t.Fatalf("query schema: %v", err)
	}
	defer rows.Close()
	seen := 0
	names := make([]string, 0, 17)
	for rows.Next() {
		var name, ddl string
		if err := rows.Scan(&name, &ddl); err != nil {
			t.Fatalf("scan: %v", err)
		}
		if name == "goose_db_version" {
			// goose's own table cannot be STRICT: its tstamp column is TIMESTAMP,
			// which STRICT does not permit (gap-67 §2.3).
			continue
		}
		seen++
		names = append(names, name)
		if !strings.Contains(ddl, ") STRICT") {
			t.Errorf("table %s is not STRICT: %s", name, ddl)
		}
		for _, banned := range []string{"DATETIME", "TIMESTAMP", "BOOLEAN"} {
			if strings.Contains(strings.ToUpper(ddl), banned) {
				t.Errorf("table %s declares %s: %s", name, banned, ddl)
			}
		}
	}
	sort.Strings(names)
	if !reflect.DeepEqual(names, wantTables) {
		t.Fatalf("tables = %v, want the seventeen 001/002/003/009 declare: %v", names, wantTables)
	}
	if seen != len(wantTables) {
		t.Fatalf("%d dilla tables found; 001/002/003/009 declare %d", seen, len(wantTables))
	}
}

// wantTables is the exact set 001/002/003/009 declare, sorted, so that a
// dropped or renamed table is caught and not just a change in the count.
var wantTables = []string{
	"audit_log", "device_lists", "devices", "instance_settings", "instances", "invites",
	"login_attempts", "oidc_identities", "password_credentials", "recovery_codes", "reports",
	"sessions", "totp_secrets", "users", "webauthn_ceremonies", "webauthn_credentials",
	"webauthn_users",
}

// The two AUTOINCREMENT surrogate keys must survive sqlc's `*.id` wildcard as
// int64 (deviation ID7): if a future override re-types them as id.ID, ListAudit
// fails at scan time and this test says so at build time instead.
func TestSurrogateKeysAreInt64InTheGeneratedModels(t *testing.T) {
	for _, tc := range []struct {
		name  string
		model any
	}{
		{"sqlite audit_log", sqlitedb.AuditLog{}},
		{"sqlite login_attempts", sqlitedb.LoginAttempts{}},
		{"pg audit_log", pgdb.AuditLog{}},
		{"pg login_attempts", pgdb.LoginAttempts{}},
	} {
		f, ok := reflect.TypeOf(tc.model).FieldByName("ID")
		if !ok {
			t.Fatalf("%s: generated model has no ID field", tc.name)
		}
		if f.Type.Kind() != reflect.Int64 {
			t.Fatalf("%s: ID is %s, want int64", tc.name, f.Type)
		}
	}
}

// The WebAuthn credential id is 16-1023 bytes, so it must survive the `*.*_id`
// wildcard as []byte (deviation ID7).
func TestCredIDIsAByteSliceInTheGeneratedModels(t *testing.T) {
	for _, tc := range []struct {
		name  string
		model any
	}{
		{"sqlite", sqlitedb.WebauthnCredentials{}},
		{"pg", pgdb.WebauthnCredentials{}},
	} {
		f, ok := reflect.TypeOf(tc.model).FieldByName("CredID")
		if !ok {
			f, ok = reflect.TypeOf(tc.model).FieldByName("CredId")
		}
		if !ok {
			t.Fatalf("%s: generated model has no cred_id field", tc.name)
		}
		if f.Type != reflect.TypeOf([]byte(nil)) {
			t.Fatalf("%s: cred_id is %s, want []byte", tc.name, f.Type)
		}
	}
}

func TestMigrationTableIsGooseDefault(t *testing.T) {
	db := openSQLite(t)
	p, _ := goose.NewProvider(goose.DialectSQLite3, db, sqlitemigrations.FS)
	if _, err := p.Up(context.Background()); err != nil {
		t.Fatalf("up: %v", err)
	}
	var n int
	if err := db.QueryRow(`SELECT count(*) FROM sqlite_schema WHERE type='table' AND name='goose_db_version'`).Scan(&n); err != nil {
		t.Fatalf("query: %v", err)
	}
	if n != 1 {
		t.Fatalf("goose_db_version missing")
	}
	if err := db.QueryRow(`SELECT count(*) FROM sqlite_schema WHERE type='table' AND name='schema_migrations'`).Scan(&n); err != nil {
		t.Fatalf("query: %v", err)
	}
	if n != 0 {
		t.Fatalf("schema_migrations exists; D3 says goose's default name is kept")
	}
}

func TestIdentifierColumnsRejectFifteenBytes(t *testing.T) {
	db := openSQLite(t)
	p, _ := goose.NewProvider(goose.DialectSQLite3, db, sqlitemigrations.FS)
	if _, err := p.Up(context.Background()); err != nil {
		t.Fatalf("up: %v", err)
	}
	short := make([]byte, 15)
	_, err := db.Exec(`INSERT INTO instance_settings (key, value, updated) VALUES ('k', ?, 1)`, short)
	if err != nil {
		t.Fatalf("a 15-byte blob is legal in a plain BLOB column: %v", err)
	}
	_, err = db.Exec(`INSERT INTO instances (instance_id, external_sender_key_id, key_history, franking_key_id, generation, policy_version, created)
	                  VALUES (?, ?, x'00', ?, 1, 1, 1)`, short, short, short)
	if err == nil {
		t.Fatal("instances accepted a 15-byte instance_id; the length CHECK is missing")
	}
}

func TestMigrationCarriesEverySchemaFileVerbatim(t *testing.T) {
	for _, dir := range []string{"sqlite", "postgres"} {
		t.Run(dir, func(t *testing.T) {
			mig, err := os.ReadFile(filepath.Join("..", "store", dir, "migrations", "00001_init.sql"))
			if err != nil {
				mig, err = os.ReadFile(filepath.Join(dir, "migrations", "00001_init.sql"))
			}
			if err != nil {
				t.Fatalf("read migration: %v", err)
			}
			entries, err := os.ReadDir(filepath.Join(dir, "schema"))
			if err != nil {
				t.Fatalf("read schema dir: %v", err)
			}
			for _, e := range entries {
				body, err := os.ReadFile(filepath.Join(dir, "schema", e.Name()))
				if err != nil {
					t.Fatalf("read %s: %v", e.Name(), err)
				}
				if !strings.Contains(string(mig), strings.TrimSpace(string(body))) {
					t.Fatalf("%s/migrations/00001_init.sql does not contain %s verbatim; sqlc and goose would see different schemas", dir, e.Name())
				}
			}
		})
	}
}
