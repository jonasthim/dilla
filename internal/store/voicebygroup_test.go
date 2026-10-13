package store_test

import (
	"strings"
	"testing"
)

// web-3 task 3 fix round 1: the idle call-group close's NOT EXISTS probe of voice_sessions by
// group_id reads the voice_sessions_by_group partial index (live sessions only) instead of scanning
// every voice session once per open call group.
func TestVoiceSessionsByGroupIndexServesTheIdleClose(t *testing.T) {
	const probe = "SELECT 1 FROM voice_sessions v WHERE v.group_id = ? AND v.ended IS NULL"
	for engine, repo := range engines(t) {
		t.Run(engine, func(t *testing.T) {
			ctx := t.Context()
			db := rawDB(t, repo)
			switch engine {
			case "sqlite":
				var ddl string
				if err := db.QueryRowContext(ctx,
					`SELECT sql FROM sqlite_schema WHERE type = 'index' AND name = 'voice_sessions_by_group'`).Scan(&ddl); err != nil {
					t.Fatalf("read voice_sessions_by_group: %v", err)
				}
				if ddl != "CREATE INDEX voice_sessions_by_group ON voice_sessions (group_id) WHERE ended IS NULL" {
					t.Fatalf("voice_sessions_by_group is %q", ddl)
				}
				rows, err := db.QueryContext(ctx, "EXPLAIN QUERY PLAN "+probe, make([]byte, 16))
				if err != nil {
					t.Fatalf("EXPLAIN QUERY PLAN: %v", err)
				}
				defer rows.Close()
				var plan []string
				for rows.Next() {
					var node, parent, unused int64
					var detail string
					if err := rows.Scan(&node, &parent, &unused, &detail); err != nil {
						t.Fatalf("scan plan: %v", err)
					}
					plan = append(plan, detail)
				}
				if err := rows.Err(); err != nil {
					t.Fatalf("iterate plan: %v", err)
				}
				if !strings.Contains(strings.Join(plan, "\n"), "voice_sessions_by_group") {
					t.Fatalf("the idle close's probe does not use voice_sessions_by_group; plan: %q", plan)
				}
			case "postgres":
				var def string
				if err := db.QueryRowContext(ctx,
					`SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'voice_sessions_by_group'`).Scan(&def); err != nil {
					t.Fatalf("read voice_sessions_by_group: %v", err)
				}
				if def != "CREATE INDEX voice_sessions_by_group ON public.voice_sessions USING btree (group_id) WHERE (ended IS NULL)" {
					t.Fatalf("voice_sessions_by_group is %q", def)
				}
			default:
				t.Fatalf("unknown engine %q", engine)
			}
		})
	}
}
