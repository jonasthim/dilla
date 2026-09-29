-- +goose Up
-- The body of this section is internal/store/sqlite/schema/004_mls.sql, verbatim.
-- internal/store/schema_test.go asserts that, because sqlc reads the schema directory and
-- goose reads this file: if they drift, sqlc generates against a schema the database does
-- not have.

CREATE TABLE mls_groups (
  group_id               BLOB    NOT NULL CHECK (length(group_id) = 16) PRIMARY KEY,
  -- Deviation B11: interfaces §4.3 names this column `binding_json TEXT NOT NULL`, but
  -- `dilla_binding` is not JSON. `core/dilla-core/src/mls/binding.rs:70-82` encodes a
  -- deterministic-CBOR 8-element array and `public_group_state` hands it over as a `bstr` wrapping
  -- that array (`core/dilla-core-wasi/src/exports.rs:249-263`, deviation A2-13). Raw CBOR is not
  -- valid UTF-8, so a STRICT TEXT column rejects it on SQLite and a Postgres TEXT column rejects
  -- it outright. The column keeps the bytes.
  binding                BLOB    NOT NULL,
  kind                   INTEGER NOT NULL CHECK (kind IN (0, 1, 2, 3)),
  community_id           BLOB             CHECK (community_id IS NULL OR length(community_id) = 16),
  target_id              BLOB    NOT NULL CHECK (length(target_id) = 16),
  call_id                BLOB             CHECK (call_id IS NULL OR length(call_id) = 16),
  ciphersuite            INTEGER NOT NULL DEFAULT 1,
  epoch                  INTEGER NOT NULL DEFAULT 0,
  seq                    INTEGER NOT NULL DEFAULT 0,   -- high-water; next_seq = seq + 1
  group_info_blob        BLOB,
  tree_hash              BLOB,
  public_group_state     BLOB,
  external_sender_key_id BLOB    NOT NULL CHECK (length(external_sender_key_id) = 16),
  e2ee_version           INTEGER NOT NULL,
  media_version          INTEGER NOT NULL,
  policy_version         INTEGER NOT NULL,
  epoch_unknown          INTEGER NOT NULL DEFAULT 0 CHECK (epoch_unknown IN (0, 1)),
  heal_deadline          INTEGER,
  created                INTEGER NOT NULL,
  closed_at              INTEGER,
  -- Invariant 10's retention high-waters, one per stream of the group's one seq space: the
  -- highest seq of an application message (pruned_below) and of a handshake
  -- (handshakes_pruned_through) that any retention trigger has deleted, raised by the store in
  -- the same transaction as the DELETE. 0 means nothing of that stream was ever deleted. A
  -- catch-up from `from` has lost something exactly when `from` is at or below the mark, which
  -- makes E_PRUNED exact rather than a guess from the group's age (deviation B20).
  --
  -- They are columns and not recomputations because nothing can read a deleted row's seq back
  -- later: `MinCursor` is an aggregate over cursor rows that move, and the oldest surviving row of
  -- a stream says nothing about seqs below it, which may never have belonged to that stream.
  pruned_below              INTEGER NOT NULL DEFAULT 0,
  handshakes_pruned_through INTEGER NOT NULL DEFAULT 0
) STRICT;
CREATE INDEX mls_groups_by_target ON mls_groups(target_id, kind);

CREATE TABLE mls_handshakes (
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
CREATE INDEX mls_handshakes_by_epoch ON mls_handshakes(group_id, epoch, kind);

CREATE TABLE mls_pending_proposals (
  group_id      BLOB    NOT NULL CHECK (length(group_id) = 16)
                REFERENCES mls_groups(group_id) ON DELETE CASCADE,
  ref           BLOB    NOT NULL,
  epoch         INTEGER NOT NULL,
  kind          INTEGER NOT NULL CHECK (kind IN (1, 2, 3, 4, 5, 6, 7)),
  target_leaf   INTEGER,
  target_device BLOB             CHECK (target_device IS NULL OR length(target_device) = 16),
  key_package   BLOB,
  origin        INTEGER NOT NULL CHECK (origin IN (0, 1)),
  action_id     BLOB    NOT NULL CHECK (length(action_id) = 16),
  issued_at     INTEGER NOT NULL,
  ttl           INTEGER NOT NULL,
  void_at       INTEGER,
  PRIMARY KEY (group_id, ref)
) STRICT;
CREATE INDEX mls_pending_by_group_epoch ON mls_pending_proposals(group_id, epoch, void_at);

CREATE TABLE mls_members (
  group_id      BLOB    NOT NULL CHECK (length(group_id) = 16)
                REFERENCES mls_groups(group_id) ON DELETE CASCADE,
  leaf_index    INTEGER NOT NULL,
  user_id       BLOB    NOT NULL CHECK (length(user_id) = 16),
  device_id     BLOB    NOT NULL CHECK (length(device_id) = 16),
  signature_key BLOB    NOT NULL CHECK (length(signature_key) = 32),
  added_epoch   INTEGER NOT NULL,
  removed_epoch INTEGER,
  PRIMARY KEY (group_id, leaf_index)
) STRICT;
CREATE INDEX mls_members_by_device ON mls_members(device_id) WHERE removed_epoch IS NULL;

CREATE TABLE mls_welcome_payloads (
  blob_sha256 BLOB    NOT NULL CHECK (length(blob_sha256) = 32) PRIMARY KEY,
  group_id    BLOB    NOT NULL CHECK (length(group_id) = 16),
  epoch       INTEGER NOT NULL,
  blob        BLOB    NOT NULL,
  created     INTEGER NOT NULL
) STRICT;

CREATE TABLE mls_epoch_trees (
  group_id     BLOB    NOT NULL CHECK (length(group_id) = 16),
  epoch        INTEGER NOT NULL,
  ratchet_tree BLOB    NOT NULL,
  tree_hash    BLOB    NOT NULL CHECK (length(tree_hash) = 32),
  created      INTEGER NOT NULL,
  PRIMARY KEY (group_id, epoch)
) STRICT;

CREATE TABLE mls_welcomes (
  welcome_id   INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id    BLOB    NOT NULL CHECK (length(device_id) = 16),
  group_id     BLOB    NOT NULL CHECK (length(group_id) = 16),
  epoch        INTEGER NOT NULL,
  commit_seq   INTEGER NOT NULL,
  blob_sha256  BLOB    NOT NULL CHECK (length(blob_sha256) = 32)
               REFERENCES mls_welcome_payloads(blob_sha256) ON DELETE CASCADE,
  created      INTEGER NOT NULL,
  expires      INTEGER NOT NULL,
  delivered_at INTEGER
) STRICT;
CREATE UNIQUE INDEX mls_welcomes_unique ON mls_welcomes(device_id, blob_sha256);
CREATE INDEX mls_welcomes_pending ON mls_welcomes(device_id, welcome_id) WHERE delivered_at IS NULL;

CREATE TABLE key_packages (
  device_id   BLOB    NOT NULL CHECK (length(device_id) = 16)
              REFERENCES devices(id) ON DELETE CASCADE,
  kp_ref      BLOB    NOT NULL,
  blob        BLOB    NOT NULL,
  last_resort INTEGER NOT NULL CHECK (last_resort IN (0, 1)),
  expires     INTEGER NOT NULL,
  created     INTEGER NOT NULL,
  consumed_at INTEGER,
  PRIMARY KEY (device_id, kp_ref)
) STRICT;
CREATE INDEX key_packages_available ON key_packages(device_id, last_resort, expires)
  WHERE consumed_at IS NULL;

CREATE TABLE device_cursors (
  device_id  BLOB    NOT NULL CHECK (length(device_id) = 16),
  group_id   BLOB    NOT NULL CHECK (length(group_id) = 16),
  last_seq   INTEGER NOT NULL,
  last_epoch INTEGER NOT NULL,
  updated    INTEGER NOT NULL,
  PRIMARY KEY (device_id, group_id)
) STRICT;

CREATE TABLE fork_reports (
  group_id        BLOB    NOT NULL CHECK (length(group_id) = 16),
  seq             INTEGER NOT NULL,
  reporter_device BLOB    NOT NULL CHECK (length(reporter_device) = 16),
  epoch           INTEGER NOT NULL,
  reason          TEXT    NOT NULL,
  created         INTEGER NOT NULL,
  PRIMARY KEY (group_id, seq, reporter_device)
) STRICT;

-- +goose Down
DROP TABLE fork_reports;
DROP TABLE device_cursors;
DROP TABLE key_packages;
DROP TABLE mls_welcomes;
DROP TABLE mls_epoch_trees;
DROP TABLE mls_welcome_payloads;
DROP TABLE mls_members;
DROP TABLE mls_pending_proposals;
DROP TABLE mls_handshakes;
DROP TABLE mls_groups;
