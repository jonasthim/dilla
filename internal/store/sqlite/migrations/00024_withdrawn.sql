-- +goose Up
-- The body of this section is internal/store/sqlite/schema/022_withdrawn.sql, verbatim.
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
ALTER TABLE mls_pending_proposals ADD COLUMN withdrawable INTEGER NOT NULL DEFAULT 0 CHECK (withdrawable IN (0, 1));
ALTER TABLE mls_pending_proposals ADD COLUMN withdrawn_at INTEGER;
ALTER TABLE mls_pending_proposals ADD COLUMN withdrawn_seq INTEGER;
-- mls_handshakes gains kind 3 (withdrawn). A STRICT table's CHECK cannot be altered, so the table
-- is rebuilt with every row; nothing references it.
CREATE TABLE mls_handshakes_v24 (
  group_id      BLOB    NOT NULL CHECK (length(group_id) = 16)
                REFERENCES mls_groups(group_id) ON DELETE CASCADE,
  seq           INTEGER NOT NULL,
  epoch         INTEGER NOT NULL,
  kind          INTEGER NOT NULL CHECK (kind IN (0, 1, 2, 3)),
  sender_leaf   INTEGER,                                    -- NULL = the instance external sender
  sender_device BLOB             CHECK (sender_device IS NULL OR length(sender_device) = 16),
  blob          BLOB    NOT NULL,
  created       INTEGER NOT NULL,
  PRIMARY KEY (group_id, seq)
) STRICT;
INSERT INTO mls_handshakes_v24 (group_id, seq, epoch, kind, sender_leaf, sender_device, blob, created)
SELECT group_id, seq, epoch, kind, sender_leaf, sender_device, blob, created FROM mls_handshakes;
DROP TABLE mls_handshakes;
ALTER TABLE mls_handshakes_v24 RENAME TO mls_handshakes;
CREATE INDEX mls_handshakes_by_epoch ON mls_handshakes(group_id, epoch, kind);

-- +goose Down
-- A rollback below web3.12 (I5): web3.11's core refuses a whole page that carries a kind-3 row
-- (wire.rs `kind > 2`), so every withdrawn row goes, and so does every withdrawn proposal: it is
-- deleted, never revived (clients that dropped it stay consistent with a DS that no longer lists
-- it).
DELETE FROM mls_handshakes WHERE kind = 3;
DELETE FROM mls_pending_proposals WHERE withdrawn_at IS NOT NULL;
CREATE TABLE mls_handshakes_v23 (
  group_id      BLOB    NOT NULL CHECK (length(group_id) = 16)
                REFERENCES mls_groups(group_id) ON DELETE CASCADE,
  seq           INTEGER NOT NULL,
  epoch         INTEGER NOT NULL,
  kind          INTEGER NOT NULL CHECK (kind IN (0, 1, 2)),
  sender_leaf   INTEGER,                                    -- NULL = the instance external sender
  sender_device BLOB             CHECK (sender_device IS NULL OR length(sender_device) = 16),
  blob          BLOB    NOT NULL,
  created       INTEGER NOT NULL,
  PRIMARY KEY (group_id, seq)
) STRICT;
INSERT INTO mls_handshakes_v23 (group_id, seq, epoch, kind, sender_leaf, sender_device, blob, created)
SELECT group_id, seq, epoch, kind, sender_leaf, sender_device, blob, created FROM mls_handshakes;
DROP TABLE mls_handshakes;
ALTER TABLE mls_handshakes_v23 RENAME TO mls_handshakes;
CREATE INDEX mls_handshakes_by_epoch ON mls_handshakes(group_id, epoch, kind);
ALTER TABLE mls_pending_proposals DROP COLUMN withdrawn_seq;
ALTER TABLE mls_pending_proposals DROP COLUMN withdrawn_at;
ALTER TABLE mls_pending_proposals DROP COLUMN withdrawable;
