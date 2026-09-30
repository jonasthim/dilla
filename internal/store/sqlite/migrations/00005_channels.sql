-- +goose Up
-- The body of this section is internal/store/sqlite/schema/006a_channels.sql, verbatim.
-- internal/store/schema_test.go asserts that, because sqlc reads the schema directory and
-- goose reads this file: if they drift, sqlc generates against a schema the database does
-- not have.

-- 006a_channels.sql: channels (Plan 2 task 2), migration 00005_channels.sql.
-- A file of its own, not an append to 006_structure.sql: goose applies 00004 and 00005 as
-- two migrations, and internal/store/schema_test.go requires every schema file to appear
-- verbatim inside one of them. The name sorts after 006_structure.sql, so sqlc reads
-- communities before the table that references it.
--
-- kind: 0 text, 1 voice, 2 category, 3 DM, 4 group DM. mode: 0 e2ee, 1 readable.
-- visibility: 0 private, 1 invite, 2 discoverable (interfaces.md §4.3).
-- settings_json is TEXT on both engines for the reason communities.policy_json is: the bytes
-- written are the bytes read back, on either engine.
CREATE TABLE channels (
  id                  BLOB    NOT NULL CHECK (length(id) = 16) PRIMARY KEY,
  community_id        BLOB    CHECK (community_id IS NULL OR length(community_id) = 16)
                              REFERENCES communities(id) ON DELETE CASCADE,
  kind                INTEGER NOT NULL CHECK (kind IN (0, 1, 2, 3, 4)),
  mode                INTEGER NOT NULL CHECK (mode IN (0, 1)),
  visibility          INTEGER NOT NULL CHECK (visibility IN (0, 1, 2)),
  parent_id           BLOB    CHECK (parent_id IS NULL OR length(parent_id) = 16)
                              REFERENCES channels(id) ON DELETE SET NULL,
  name                TEXT    NOT NULL,
  topic               TEXT    NOT NULL DEFAULT '',
  position            INTEGER NOT NULL DEFAULT 0,
  settings_json       TEXT    NOT NULL DEFAULT '{}',
  host_policy_version INTEGER NOT NULL DEFAULT 1,
  slowmode_seconds    INTEGER NOT NULL DEFAULT 0,
  seq                 INTEGER NOT NULL DEFAULT 0,
  created             INTEGER NOT NULL,
  deleted_at          INTEGER,
  -- Two rules from protocol/01 and interfaces.md §4.3, enforced by the engine so
  -- that no code path can create a channel the delivery service would reject:
  --   a category is always top level, and
  --   a channel that is invite-visible or discoverable is always readable.
  CHECK (kind <> 2 OR parent_id IS NULL),
  CHECK (visibility = 0 OR mode = 1),
  -- A DM or group DM has no community; every other kind has one.
  CHECK ((kind IN (3, 4)) = (community_id IS NULL))
) STRICT;
CREATE INDEX channels_by_community ON channels(community_id, position, id);
CREATE INDEX channels_by_parent ON channels(parent_id) WHERE parent_id IS NOT NULL;

-- +goose Down
DROP INDEX channels_by_parent;
DROP INDEX channels_by_community;
DROP TABLE channels;
