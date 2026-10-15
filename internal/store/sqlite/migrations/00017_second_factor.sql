-- +goose Up
-- The body of this section is internal/store/sqlite/schema/015_second_factor.sql, verbatim.
-- internal/store/schema_test.go asserts that, because sqlc reads the schema directory and
-- goose reads this file: if they drift, sqlc generates against a schema the database does
-- not have. The backfill UPDATE is in the schema file too: sqlc reads it and changes nothing.

-- 015_second_factor.sql: an account owes a second factor until it holds one (dilla web3.6 S1),
-- migration 00017_second_factor.sql. The name sorts after 003_auth.sql, so sqlc reads totp_secrets
-- and webauthn_credentials before the backfill that reads them.
--
-- factor_owed = 1 is an account the instance refuses everywhere but a short allow-list
-- (protocol/09 § Sessions, the `F` and `P` routes; protocol/02 § Device sessions) until it holds a
-- confirmed TOTP secret or a passkey. POST /v1/accounts writes 1 for a human account; adding the
-- first factor clears it; the boot reconcile (MarkFactorOwedWithoutFactor) sets it again on any
-- live human account that holds no usable factor, and ClearFactorOwedWithFactor clears it from
-- any that holds one.
ALTER TABLE users ADD COLUMN factor_owed INTEGER NOT NULL DEFAULT 0 CHECK (factor_owed IN (0, 1));

-- Backfill (data, not schema)
UPDATE users SET factor_owed = 1
 WHERE kind = 0 AND deleted_at IS NULL
   AND id NOT IN (SELECT user_id FROM totp_secrets WHERE confirmed_at IS NOT NULL)
   AND id NOT IN (SELECT user_id FROM webauthn_credentials);

-- +goose Down
ALTER TABLE users DROP COLUMN factor_owed;
