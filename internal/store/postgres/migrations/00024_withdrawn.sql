-- +goose Up
-- The body of this section is internal/store/postgres/schema/022_withdrawn.sql, verbatim.
-- internal/store/schema_test.go asserts that, because sqlc reads the schema directory and
-- goose reads this file: if they drift, sqlc generates against a schema the database does
-- not have.

-- 022_withdrawn.sql: the withdrawal of an absence Remove (UP6b, R-UP12), migration
-- 00024_withdrawn.sql. protocol/02 invariant 6, "Withdrawal".
--
-- withdrawable is 1 only for an instance Remove issued because a device stayed out of its call's
-- room (the room sweep) or left it: never for a revocation, a kick or ban, an eviction, a barred
-- device's cut or a member's own proposal. Every re-issue of the row carries it over.
-- withdrawn_at and withdrawn_seq mark a Remove the resuming device's own call start withdrew, and
-- the seq of the kind-3 handshake row that says so. The row stays (marked) so that a commit that
-- still applies it is refused 409 `withdrawn`; it is excluded from every listing and pruned with
-- its epoch.
ALTER TABLE mls_pending_proposals ADD COLUMN withdrawable SMALLINT NOT NULL DEFAULT 0 CHECK (withdrawable IN (0, 1));
ALTER TABLE mls_pending_proposals ADD COLUMN withdrawn_at BIGINT;
ALTER TABLE mls_pending_proposals ADD COLUMN withdrawn_seq BIGINT;
-- mls_handshakes gains kind 3 (withdrawn).
ALTER TABLE mls_handshakes DROP CONSTRAINT mls_handshakes_kind_check;
ALTER TABLE mls_handshakes ADD CONSTRAINT mls_handshakes_kind_check CHECK (kind IN (0, 1, 2, 3));

-- +goose Down
-- A rollback below web3.13 (I5), to any web3.12.x too: the web3.11 and web3.12.x cores refuse a
-- whole page that carries a kind-3 row (wire.rs `kind > 2`), so such a rollback needs this step
-- (migrate down --to=23) first. Every withdrawn row goes, and so does every withdrawn proposal: it is
-- deleted, never revived (clients that dropped it stay consistent with a DS that no longer lists
-- it).
DELETE FROM mls_handshakes WHERE kind = 3;
DELETE FROM mls_pending_proposals WHERE withdrawn_at IS NOT NULL;
ALTER TABLE mls_handshakes DROP CONSTRAINT mls_handshakes_kind_check;
ALTER TABLE mls_handshakes ADD CONSTRAINT mls_handshakes_kind_check CHECK (kind IN (0, 1, 2));
ALTER TABLE mls_pending_proposals DROP COLUMN withdrawn_seq;
ALTER TABLE mls_pending_proposals DROP COLUMN withdrawn_at;
ALTER TABLE mls_pending_proposals DROP COLUMN withdrawable;
