-- +goose Up
-- The body of this section is internal/store/postgres/schema/006c_bans.sql, verbatim.
-- internal/store/schema_test.go asserts that, because sqlc reads the schema directory and
-- goose reads this file: if they drift, sqlc generates against a schema the database does
-- not have.

-- 006c_bans.sql: the SQLite file with interfaces.md §4.2's substitutions (BLOB -> BYTEA with
-- octet_length, INTEGER -> BIGINT, no STRICT suffix), migration 00007_bans.sql. A file of its
-- own for the reason the SQLite twin gives.
--
-- One row is one user's ban from one community. expires is NULL for a ban that stands until
-- it is lifted; a row whose expires has passed stays (a moderator sees the history) but no
-- longer gates a join. by_user is the moderator and carries no foreign key, so the row
-- survives that account.
CREATE TABLE bans (
  community_id BYTEA  NOT NULL CHECK (octet_length(community_id) = 16)
                      REFERENCES communities(id) ON DELETE CASCADE,
  user_id      BYTEA  NOT NULL CHECK (octet_length(user_id) = 16)
                      REFERENCES users(id) ON DELETE CASCADE,
  reason       TEXT   NOT NULL DEFAULT '',
  by_user      BYTEA  NOT NULL CHECK (octet_length(by_user) = 16),
  created      BIGINT NOT NULL,
  expires      BIGINT,
  PRIMARY KEY (community_id, user_id)
);

-- +goose Down
DROP TABLE bans;
