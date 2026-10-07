-- +goose Up
-- The body of this section is internal/store/postgres/schema/012_blob_refs_pending.sql, verbatim.
-- internal/store/schema_test.go asserts that, because sqlc reads the schema directory and
-- goose reads this file: if they drift, sqlc generates against a schema the database does
-- not have.

-- 012_blob_refs_pending.sql: a blob reference is pending until its uploader confirms it
-- (dilla-web-2b task 4, L-SQL-31), migration 00014_blob_refs_pending.sql. A PUT writes
-- confirmed = 0, POST /v1/channels/{id}/blobs/{blob_id}/confirm sets 1, and the sweeper drops a
-- pending reference older than blobs.pending_ttl. Every reference stored before this migration
-- is confirmed (the default), so nothing uploaded earlier is ever swept as pending.
ALTER TABLE blob_refs ADD COLUMN confirmed SMALLINT NOT NULL DEFAULT 1 CHECK (confirmed IN (0, 1));
CREATE INDEX blob_refs_pending ON blob_refs (created) WHERE confirmed = 0;

-- +goose Down
DROP INDEX blob_refs_pending;
ALTER TABLE blob_refs DROP COLUMN confirmed;
