package main

import (
	"context"
	"fmt"
	"slices"
	"strings"

	"github.com/pressly/goose/v3"
)

// migrationState says whether a migration is waiting to run, and refuses a database that skipped
// one: a migration numbered below the database's highest version that was never applied (a build
// carrying 23 but not 21 once ran against it). Comparing the two highest versions cannot see
// that, so serve, migrate and doctor ask goose's HasPending, which can, and the error names the
// missing versions so the operator knows which build to go back to.
func migrationState(ctx context.Context, p *goose.Provider) (pending bool, err error) {
	pending, err = p.HasPending(ctx)
	if err == nil {
		return pending, nil
	}
	current, derr := p.GetDBVersion(ctx)
	results, serr := p.Status(ctx)
	if derr != nil || serr != nil {
		return false, fmt.Errorf("check migrations: %w", err)
	}
	var missing []string
	for _, r := range results {
		if r.State == goose.StatePending && r.Source.Version < current {
			missing = append(missing, fmt.Sprint(r.Source.Version))
		}
	}
	if len(missing) == 0 {
		return false, fmt.Errorf("check migrations: %w", err)
	}
	slices.Sort(missing)
	return false, fmt.Errorf("missing migration %s below the database's version %d: this database was migrated by a build that lacked them, "+
		"so it has not got their schema; run the dillad that carries every migration against a restored backup from before, or restore this "+
		"database from a backup taken before that build ran", strings.Join(missing, ", "), current)
}
