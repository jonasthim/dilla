-- 006a_channels.sql: the SQLite file with interfaces.md §4.2's substitutions (BLOB -> BYTEA
-- with octet_length, INTEGER -> BIGINT, the three enums SMALLINT, no STRICT suffix), migration
-- 00005_channels.sql. A file of its own for the reason the SQLite twin gives.
--
-- settings_json is TEXT, not the JSONB §4.2 names, for the reason communities.policy_json is
-- (006_structure.sql): JSONB re-serialises what it stores, so the bytes read back would differ
-- from the bytes written and from what SQLite returns, and sqlc would type the column []byte
-- here and string there.
CREATE TABLE channels (
  id                  BYTEA    NOT NULL CHECK (octet_length(id) = 16) PRIMARY KEY,
  community_id        BYTEA    CHECK (community_id IS NULL OR octet_length(community_id) = 16)
                               REFERENCES communities(id) ON DELETE CASCADE,
  kind                SMALLINT NOT NULL CHECK (kind IN (0, 1, 2, 3, 4)),
  mode                SMALLINT NOT NULL CHECK (mode IN (0, 1)),
  visibility          SMALLINT NOT NULL CHECK (visibility IN (0, 1, 2)),
  parent_id           BYTEA    CHECK (parent_id IS NULL OR octet_length(parent_id) = 16)
                               REFERENCES channels(id) ON DELETE SET NULL,
  name                TEXT     NOT NULL,
  topic               TEXT     NOT NULL DEFAULT '',
  position            BIGINT   NOT NULL DEFAULT 0,
  settings_json       TEXT     NOT NULL DEFAULT '{}',
  host_policy_version BIGINT   NOT NULL DEFAULT 1,
  slowmode_seconds    BIGINT   NOT NULL DEFAULT 0,
  seq                 BIGINT   NOT NULL DEFAULT 0,
  created             BIGINT   NOT NULL,
  deleted_at          BIGINT,
  -- Two rules from protocol/01 and interfaces.md §4.3, enforced by the engine so
  -- that no code path can create a channel the delivery service would reject:
  --   a category is always top level, and
  --   a channel that is invite-visible or discoverable is always readable.
  CHECK (kind <> 2 OR parent_id IS NULL),
  CHECK (visibility = 0 OR mode = 1),
  -- A DM or group DM has no community; every other kind has one.
  CHECK ((kind IN (3, 4)) = (community_id IS NULL))
);
CREATE INDEX channels_by_community ON channels(community_id, position, id);
CREATE INDEX channels_by_parent ON channels(parent_id) WHERE parent_id IS NOT NULL;
