-- +goose Up
-- The body of this section is internal/store/postgres/schema/004_mls.sql, verbatim.
-- internal/store/schema_test.go asserts that, because sqlc reads the schema directory and
-- goose reads this file: if they drift, sqlc generates against a schema the database does
-- not have.

CREATE TABLE mls_groups (
  group_id               BYTEA    NOT NULL CHECK (octet_length(group_id) = 16) PRIMARY KEY,
  binding                BYTEA    NOT NULL,
  kind                   SMALLINT NOT NULL CHECK (kind IN (0, 1, 2, 3)),
  community_id           BYTEA             CHECK (community_id IS NULL OR octet_length(community_id) = 16),
  target_id              BYTEA    NOT NULL CHECK (octet_length(target_id) = 16),
  call_id                BYTEA             CHECK (call_id IS NULL OR octet_length(call_id) = 16),
  ciphersuite            BIGINT   NOT NULL DEFAULT 1,
  epoch                  BIGINT   NOT NULL DEFAULT 0,
  seq                    BIGINT   NOT NULL DEFAULT 0,
  group_info_blob        BYTEA,
  tree_hash              BYTEA,
  public_group_state     BYTEA,
  external_sender_key_id BYTEA    NOT NULL CHECK (octet_length(external_sender_key_id) = 16),
  e2ee_version           BIGINT   NOT NULL,
  media_version          BIGINT   NOT NULL,
  policy_version         BIGINT   NOT NULL,
  epoch_unknown          SMALLINT NOT NULL DEFAULT 0 CHECK (epoch_unknown IN (0, 1)),
  heal_deadline          BIGINT,
  created                BIGINT   NOT NULL,
  closed_at              BIGINT,
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
  pruned_below              BIGINT   NOT NULL DEFAULT 0,
  handshakes_pruned_through BIGINT   NOT NULL DEFAULT 0
);
CREATE INDEX mls_groups_by_target ON mls_groups(target_id, kind);

CREATE TABLE mls_handshakes (
  group_id      BYTEA    NOT NULL CHECK (octet_length(group_id) = 16)
                REFERENCES mls_groups(group_id) ON DELETE CASCADE,
  seq           BIGINT   NOT NULL,
  epoch         BIGINT   NOT NULL,
  kind          SMALLINT NOT NULL CHECK (kind IN (0, 1, 2)),
  sender_leaf   BIGINT,
  sender_device BYTEA             CHECK (sender_device IS NULL OR octet_length(sender_device) = 16),
  blob          BYTEA    NOT NULL,
  created       BIGINT   NOT NULL,
  PRIMARY KEY (group_id, seq)
);
CREATE INDEX mls_handshakes_by_epoch ON mls_handshakes(group_id, epoch, kind);

CREATE TABLE mls_pending_proposals (
  group_id      BYTEA    NOT NULL CHECK (octet_length(group_id) = 16)
                REFERENCES mls_groups(group_id) ON DELETE CASCADE,
  ref           BYTEA    NOT NULL,
  epoch         BIGINT   NOT NULL,
  kind          SMALLINT NOT NULL CHECK (kind IN (1, 2, 3, 4, 5, 6, 7)),
  target_leaf   BIGINT,
  target_device BYTEA             CHECK (target_device IS NULL OR octet_length(target_device) = 16),
  key_package   BYTEA,
  origin        SMALLINT NOT NULL CHECK (origin IN (0, 1)),
  action_id     BYTEA    NOT NULL CHECK (octet_length(action_id) = 16),
  issued_at     BIGINT   NOT NULL,
  ttl           BIGINT   NOT NULL,
  void_at       BIGINT,
  PRIMARY KEY (group_id, ref)
);
CREATE INDEX mls_pending_by_group_epoch ON mls_pending_proposals(group_id, epoch, void_at);

CREATE TABLE mls_members (
  group_id      BYTEA  NOT NULL CHECK (octet_length(group_id) = 16)
                REFERENCES mls_groups(group_id) ON DELETE CASCADE,
  leaf_index    BIGINT NOT NULL,
  user_id       BYTEA  NOT NULL CHECK (octet_length(user_id) = 16),
  device_id     BYTEA  NOT NULL CHECK (octet_length(device_id) = 16),
  signature_key BYTEA  NOT NULL CHECK (octet_length(signature_key) = 32),
  added_epoch   BIGINT NOT NULL,
  removed_epoch BIGINT,
  PRIMARY KEY (group_id, leaf_index)
);
CREATE INDEX mls_members_by_device ON mls_members(device_id) WHERE removed_epoch IS NULL;

CREATE TABLE mls_welcome_payloads (
  blob_sha256 BYTEA  NOT NULL CHECK (octet_length(blob_sha256) = 32) PRIMARY KEY,
  group_id    BYTEA  NOT NULL CHECK (octet_length(group_id) = 16),
  epoch       BIGINT NOT NULL,
  blob        BYTEA  NOT NULL,
  created     BIGINT NOT NULL
);

CREATE TABLE mls_epoch_trees (
  group_id     BYTEA  NOT NULL CHECK (octet_length(group_id) = 16),
  epoch        BIGINT NOT NULL,
  ratchet_tree BYTEA  NOT NULL,
  tree_hash    BYTEA  NOT NULL CHECK (octet_length(tree_hash) = 32),
  created      BIGINT NOT NULL,
  PRIMARY KEY (group_id, epoch)
);

CREATE TABLE mls_welcomes (
  welcome_id   BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  device_id    BYTEA  NOT NULL CHECK (octet_length(device_id) = 16),
  group_id     BYTEA  NOT NULL CHECK (octet_length(group_id) = 16),
  epoch        BIGINT NOT NULL,
  commit_seq   BIGINT NOT NULL,
  blob_sha256  BYTEA  NOT NULL CHECK (octet_length(blob_sha256) = 32)
               REFERENCES mls_welcome_payloads(blob_sha256) ON DELETE CASCADE,
  created      BIGINT NOT NULL,
  expires      BIGINT NOT NULL,
  delivered_at BIGINT
);
CREATE UNIQUE INDEX mls_welcomes_unique ON mls_welcomes(device_id, blob_sha256);
CREATE INDEX mls_welcomes_pending ON mls_welcomes(device_id, welcome_id) WHERE delivered_at IS NULL;

CREATE TABLE key_packages (
  device_id   BYTEA    NOT NULL CHECK (octet_length(device_id) = 16)
              REFERENCES devices(id) ON DELETE CASCADE,
  kp_ref      BYTEA    NOT NULL,
  blob        BYTEA    NOT NULL,
  last_resort SMALLINT NOT NULL CHECK (last_resort IN (0, 1)),
  expires     BIGINT   NOT NULL,
  created     BIGINT   NOT NULL,
  consumed_at BIGINT,
  PRIMARY KEY (device_id, kp_ref)
);
CREATE INDEX key_packages_available ON key_packages(device_id, last_resort, expires)
  WHERE consumed_at IS NULL;

CREATE TABLE device_cursors (
  device_id  BYTEA  NOT NULL CHECK (octet_length(device_id) = 16),
  group_id   BYTEA  NOT NULL CHECK (octet_length(group_id) = 16),
  last_seq   BIGINT NOT NULL,
  last_epoch BIGINT NOT NULL,
  updated    BIGINT NOT NULL,
  PRIMARY KEY (device_id, group_id)
);

CREATE TABLE fork_reports (
  group_id        BYTEA  NOT NULL CHECK (octet_length(group_id) = 16),
  seq             BIGINT NOT NULL,
  reporter_device BYTEA  NOT NULL CHECK (octet_length(reporter_device) = 16),
  epoch           BIGINT NOT NULL,
  reason          TEXT   NOT NULL,
  created         BIGINT NOT NULL,
  PRIMARY KEY (group_id, seq, reporter_device)
);

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
