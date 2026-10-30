package store_test

import (
	"context"
	"database/sql"
	"strings"
	"testing"
)

// Every admission compacts its installation's receipts inside the writer transaction. The Bot asks
// for an admission on every private-group sync and every private reply, and the tombstones stay
// for 30 days, so an installation holds hundreds of thousands of rows. Searched by installation
// alone, both compaction statements visit all of them while every other write on the instance
// waits on the one SQLite writer (CT 144, 2026-10-30: about 6 s per admission, cursor and upload
// POSTs queued behind it). Both statements must be range searches on the expiry.
func TestBotInteractionAdmissionCompactionSearchesByExpiry(t *testing.T) {
	ctx := context.Background()
	repo := engines(t)["sqlite"]
	db := rawWriteDB(t, repo)
	// The two statements of sqlite.(*Repo).CompactExpiredBotInteractionAdmissionReceipts.
	// The payload compaction must use the partial index of receipts that still hold a payload: a
	// range over every expired receipt would still visit the 30 days of tombstones.
	for name, c := range map[string]struct{ statement, index string }{
		"payload compaction": {`UPDATE bot_interaction_admission_receipts INDEXED BY bot_interaction_admission_receipts_live SET payload=x'',signature=x'' WHERE installation_id=? AND not_after<=? AND length(payload)>0`, "bot_interaction_admission_receipts_live"},
		"tombstone deletion": {`DELETE FROM bot_interaction_admission_receipts WHERE installation_id=? AND not_after<=?`, "bot_interaction_admission_receipts_expiry"},
	} {
		joined := strings.Join(explainPlan(ctx, t, db, name, c.statement), "; ")
		if !strings.Contains(joined, "INDEX "+c.index+" (installation_id=? AND not_after<?)") {
			t.Errorf("%s plan = %q, want a range on %s (installation_id, not_after)", name, joined, c.index)
		}
	}
}

func explainPlan(ctx context.Context, t *testing.T, db *sql.DB, name, statement string) []string {
	t.Helper()
	rows, err := db.QueryContext(ctx, `EXPLAIN QUERY PLAN `+statement, make([]byte, 16), int64(1))
	if err != nil {
		t.Fatalf("%s: explain: %v", name, err)
	}
	defer func() { _ = rows.Close() }()
	var plan []string
	for rows.Next() {
		var id, parent, unused int
		var detail string
		if err := rows.Scan(&id, &parent, &unused, &detail); err != nil {
			t.Fatalf("%s: scan plan: %v", name, err)
		}
		plan = append(plan, detail)
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("%s: plan rows: %v", name, err)
	}
	return plan
}
