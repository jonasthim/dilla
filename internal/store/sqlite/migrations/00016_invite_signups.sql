-- +goose Up
-- The body of this section is internal/store/sqlite/schema/014_invite_signups.sql, verbatim.
-- internal/store/schema_test.go asserts that, because sqlc reads the schema directory and
-- goose reads this file: if they drift, sqlc generates against a schema the database does
-- not have.

-- 014_invite_signups.sql: who signed up with which community invite (dilla-web-3.1, WB walk I1),
-- migration 00016_invite_signups.sql. The name sorts after 003_auth.sql and 002_accounts.sql, so
-- sqlc reads invites and users before the table that references them.
--
-- One row is one account registered (POST /v1/accounts) with a community invite. The sign-up
-- spent one use of the invite; the row lets that person's join of the invite's community, with the
-- same invite, spend nothing more (protocol/09 § Invites), so a new person costs one use, not
-- two. The join takes the row (deletes it) in the transaction that writes the member row, so the
-- free join happens once. user_id is the key: an account signs up once. created is the unix second
-- of the sign-up.
CREATE TABLE invite_signups (
  user_id   BLOB    NOT NULL PRIMARY KEY CHECK (length(user_id) = 16)
                    REFERENCES users(id) ON DELETE CASCADE,
  invite_id BLOB    NOT NULL CHECK (length(invite_id) = 16)
                    REFERENCES invites(id) ON DELETE CASCADE,
  created   INTEGER NOT NULL
) STRICT;

-- +goose Down
DROP TABLE invite_signups;
