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
	var missing []int64
	var applied []int64
	for _, r := range results {
		switch {
		case r.State == goose.StatePending && r.Source.Version < current:
			missing = append(missing, r.Source.Version)
		case r.State == goose.StateApplied:
			applied = append(applied, r.Source.Version)
		}
	}
	if len(missing) == 0 {
		return false, fmt.Errorf("check migrations: %w", err)
	}
	slices.Sort(missing)
	// The last version the database can go back to without losing a migration that did run in order.
	var back int64
	for _, v := range applied {
		if v < missing[0] {
			back = max(back, v)
		}
	}
	names := make([]string, len(missing))
	for i, v := range missing {
		names[i] = fmt.Sprint(v)
	}
	noun := "migration"
	if len(missing) > 1 {
		noun = "migrations"
	}
	return false, fmt.Errorf("missing %s %s below the database's version %d: a build that lacked %s ran against this database, so it has not got their schema. "+
		"Stop dilla, run `dillad migrate down --to=%d --i-know-what-i-am-doing` (it undoes only the newer migrations that ran out of order), "+
		"then start a dillad that carries every migration. The copy dillad took before its last migration, <db.path>.pre-migration-<time>, "+
		"holds the database as it was; if neither way works, restore a backup taken before that build ran",
		noun, strings.Join(names, ", "), current, pronoun(len(missing)), back)
}

func pronoun(n int) string {
	if n > 1 {
		return "them"
	}
	return "it"
}
