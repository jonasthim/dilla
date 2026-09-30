-- +goose Up
-- The body of this section is internal/store/postgres/schema/006d_channel_members.sql, verbatim.
-- internal/store/schema_test.go asserts that, because sqlc reads the schema directory and
-- goose reads this file: if they drift, sqlc generates against a schema the database does
-- not have.

-- 006d_channel_members.sql: the SQLite file with interfaces.md §4.2's substitutions (BLOB ->
-- BYTEA with octet_length, INTEGER -> BIGINT, no STRICT suffix), migration
-- 00008_channel_members.sql. A file of its own for the reason the SQLite twin gives.
--
-- One row is one user's membership of one channel. For a DM or group DM it is the participant
-- list, the only place that list is stored; for a community channel it is the set the permission
-- resolver derives (task 7). added is the unix second the row was written.
CREATE TABLE channel_members (
  channel_id BYTEA  NOT NULL CHECK (octet_length(channel_id) = 16)
                    REFERENCES channels(id) ON DELETE CASCADE,
  user_id    BYTEA  NOT NULL CHECK (octet_length(user_id) = 16)
                    REFERENCES users(id) ON DELETE CASCADE,
  added      BIGINT NOT NULL,
  PRIMARY KEY (channel_id, user_id)
);
CREATE INDEX channel_members_by_user ON channel_members(user_id, channel_id);

-- +goose Down
DROP TABLE channel_members;
