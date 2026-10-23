-- +goose Up
-- The body of this section is internal/store/postgres/schema/019_session_capabilities.sql, verbatim.
-- internal/store/schema_test.go asserts that, because sqlc reads the schema directory and
-- goose reads this file: if they drift, sqlc generates against a schema the database does
-- not have.
-- Capability selection belongs to the bearer session. Session deletion removes its selection.
ALTER TABLE sessions ADD COLUMN wire_version BIGINT NOT NULL DEFAULT 0 CHECK (wire_version IN (0, 2, 3));
ALTER TABLE sessions ADD COLUMN e2ee_version BIGINT NOT NULL DEFAULT 0 CHECK (e2ee_version IN (0, 1));
ALTER TABLE sessions ADD COLUMN media_version BIGINT NOT NULL DEFAULT 0 CHECK (media_version IN (0, 1));

-- +goose Down
ALTER TABLE sessions DROP COLUMN media_version;
ALTER TABLE sessions DROP COLUMN e2ee_version;
ALTER TABLE sessions DROP COLUMN wire_version;
