-- +goose Up
-- The body of this section is internal/store/sqlite/schema/013_voice_by_group.sql, verbatim.
-- internal/store/schema_test.go asserts that, because sqlc reads the schema directory and
-- goose reads this file: if they drift, sqlc generates against a schema the database does
-- not have.

-- 013_voice_by_group.sql: the live voice sessions by call group (dilla-web-3 task 3, L-HTTP-105),
-- migration 00015_voice_by_group.sql. The idle call-group close asks, for every open call group,
-- whether a live voice session names it; without this index each probe reads every voice session.
CREATE INDEX voice_sessions_by_group ON voice_sessions (group_id) WHERE ended IS NULL;

-- +goose Down
DROP INDEX voice_sessions_by_group;
