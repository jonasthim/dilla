-- +goose Up
-- The body of this section is internal/store/postgres/schema/006b_overwrites.sql, verbatim.
-- internal/store/schema_test.go asserts that, because sqlc reads the schema directory and
-- goose reads this file: if they drift, sqlc generates against a schema the database does
-- not have.

-- 006b_overwrites.sql: the SQLite file with interfaces.md §4.2's substitutions (BLOB -> BYTEA
-- with octet_length, INTEGER -> BIGINT, the target_kind enum SMALLINT, no STRICT suffix),
-- migration 00006_overwrites.sql. A file of its own for the reason the SQLite twin gives.
--
-- allow and deny are signed BIGINT, which is why the permission vocabulary of protocol/09
-- § Permissions never uses bit 62 or above.
CREATE TABLE channel_overwrites (
  channel_id  BYTEA    NOT NULL CHECK (octet_length(channel_id) = 16)
                       REFERENCES channels(id) ON DELETE CASCADE,
  target_kind SMALLINT NOT NULL CHECK (target_kind IN (0, 1)),
  target_id   BYTEA    NOT NULL CHECK (octet_length(target_id) = 16),
  allow       BIGINT   NOT NULL DEFAULT 0,
  deny        BIGINT   NOT NULL DEFAULT 0,
  PRIMARY KEY (channel_id, target_kind, target_id)
);

-- +goose Down
DROP TABLE channel_overwrites;
