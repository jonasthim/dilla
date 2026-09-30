-- +goose Up
-- The body of this section is internal/store/sqlite/schema/006b_overwrites.sql, verbatim.
-- internal/store/schema_test.go asserts that, because sqlc reads the schema directory and
-- goose reads this file: if they drift, sqlc generates against a schema the database does
-- not have.

-- 006b_overwrites.sql: channel_overwrites (Plan 2 task 3), migration 00006_overwrites.sql.
-- A file of its own for the reason 006a_channels.sql gives: every schema file appears
-- verbatim inside exactly one migration. The name sorts after 006a_channels.sql, so sqlc
-- reads channels before the table that references it.
--
-- One row is one channel's permission overwrite for one target: target_kind 0 is a role
-- (target_id is roles.id), 1 is a user (target_id is users.id). target_id carries no
-- foreign key because it names one of two tables. allow and deny are the permission bits
-- of protocol/09 § Permissions, the same vocabulary roles.allow and roles.deny carry.
CREATE TABLE channel_overwrites (
  channel_id  BLOB    NOT NULL CHECK (length(channel_id) = 16)
                      REFERENCES channels(id) ON DELETE CASCADE,
  target_kind INTEGER NOT NULL CHECK (target_kind IN (0, 1)),
  target_id   BLOB    NOT NULL CHECK (length(target_id) = 16),
  allow       INTEGER NOT NULL DEFAULT 0,
  deny        INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (channel_id, target_kind, target_id)
) STRICT;

-- +goose Down
DROP TABLE channel_overwrites;
