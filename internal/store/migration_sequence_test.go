package store_test

import (
	"io/fs"
	"strconv"
	"strings"
	"testing"

	pgmigrations "github.com/jonasthim/dilla/internal/store/postgres/migrations"
	sqlitemigrations "github.com/jonasthim/dilla/internal/store/sqlite/migrations"
)

// The embedded migrations are numbered 1..N with no gap, on both engines, and the two engines
// carry the same number of them. goose applies a gap in order on a fresh database, but a database
// that ran a build with the gap (23 without 21) is refused by a later build that fills it: the
// missing migration never ran. A branch that takes a number early must merge after the ones below
// it, and this test is what fails on main when it does not.
func TestMigrationsAreNumberedWithoutGaps(t *testing.T) {
	counts := map[string]int{}
	for name, fsys := range map[string]fs.FS{"sqlite": sqlitemigrations.FS, "postgres": pgmigrations.FS} {
		entries, err := fs.ReadDir(fsys, ".")
		if err != nil {
			t.Fatalf("%s: read the migrations: %v", name, err)
		}
		seen := map[int]string{}
		for _, e := range entries {
			prefix, _, ok := strings.Cut(e.Name(), "_")
			if !ok || !strings.HasSuffix(e.Name(), ".sql") {
				continue
			}
			v, err := strconv.Atoi(prefix)
			if err != nil || v < 1 {
				t.Fatalf("%s: migration %s has no positive numeric prefix", name, e.Name())
			}
			if other, dup := seen[v]; dup {
				t.Fatalf("%s: migrations %s and %s share version %d", name, other, e.Name(), v)
			}
			seen[v] = e.Name()
		}
		if len(seen) == 0 {
			t.Fatalf("%s: no embedded migrations at all", name)
		}
		for v := 1; v <= len(seen); v++ {
			if _, ok := seen[v]; !ok {
				t.Errorf("%s: migration %d is missing, but %d migrations exist: the numbering must run 1..%d with no gap", name, v, len(seen), len(seen))
			}
		}
		counts[name] = len(seen)
	}
	if counts["sqlite"] != counts["postgres"] {
		t.Errorf("sqlite has %d migrations and postgres %d; the engines carry the same set", counts["sqlite"], counts["postgres"])
	}
}
