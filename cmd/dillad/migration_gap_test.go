package main

// migration_gap_test.go: a database at the binary's highest version that never applied a lower
// migration (a build that carried 23 but not 21 once ran against it, and a later build carries
// both) must not be served, migrated past or reported healthy. goose's Up refuses it, but serve
// skipped Up whenever the two highest versions were equal.

import (
	"fmt"
	"strings"
	"testing"

	"github.com/jonasthim/dilla/internal/exit"
	sqlitemigrations "github.com/jonasthim/dilla/internal/store/sqlite/migrations"
)

// gapHarness is an instance whose goose table lacks one migration below its highest: the second
// highest embedded version, so the test holds both with a gap in the tree and without one.
func gapHarness(t *testing.T) (h *cliHarness, missing int) {
	t.Helper()
	h = newCLIHarness(t)
	top, second := 0, 0
	entries, err := sqlitemigrations.FS.ReadDir(".")
	if err != nil {
		t.Fatal(err)
	}
	for _, e := range entries {
		prefix, _, ok := strings.Cut(e.Name(), "_")
		if !ok {
			continue
		}
		var v int
		if _, err := fmt.Sscanf(prefix, "%d", &v); err != nil {
			continue
		}
		switch {
		case v > top:
			top, second = v, top
		case v > second:
			second = v
		}
	}
	db, err := openSQLiteForTest(h.cfg.DB.Path)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	defer func() { _ = db.Close() }()
	if _, err := db.ExecContext(t.Context(), `DELETE FROM goose_db_version WHERE version_id = ?`, second); err != nil {
		t.Fatalf("forget migration %d: %v", second, err)
	}
	return h, second
}

func TestServeRefusesADatabaseThatSkippedAMigration(t *testing.T) {
	h, missing := gapHarness(t)
	code, out := h.Run(t, "serve", "--config="+h.ConfigPath)
	if code != int(exit.Data) {
		t.Fatalf("serve exit = %d, want %d (exit.Data):\n%s", code, exit.Data, out)
	}
	if !strings.Contains(out, fmt.Sprintf("missing migration %d", missing)) {
		t.Fatalf("serve does not name the missing migration %d:\n%s", missing, out)
	}
}

func TestMigrateStatusAndUpRefuseADatabaseThatSkippedAMigration(t *testing.T) {
	h, missing := gapHarness(t)
	for _, verb := range []string{"status", "up"} {
		code, out := h.Run(t, "migrate", verb, "--config="+h.ConfigPath)
		if code == 0 {
			t.Fatalf("migrate %s accepted a database missing migration %d:\n%s", verb, missing, out)
		}
		if !strings.Contains(out, fmt.Sprint(missing)) {
			t.Fatalf("migrate %s does not name migration %d:\n%s", verb, missing, out)
		}
	}
}

func TestDoctorFailsADatabaseThatSkippedAMigration(t *testing.T) {
	stubWasi(t, nil)
	h, missing := gapHarness(t)
	out, _, err := run(t, "doctor", "--config="+h.ConfigPath)
	if code, ok := exitCode(err); !ok || code != exit.Unavailable {
		t.Fatalf("doctor gave %v, want exit.Unavailable:\n%s", err, out)
	}
	if !strings.Contains(out, "FAIL  database") || !strings.Contains(out, fmt.Sprintf("missing migration %d", missing)) {
		t.Fatalf("the database leg does not fail naming migration %d:\n%s", missing, out)
	}
}
