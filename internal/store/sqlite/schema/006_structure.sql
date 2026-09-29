-- 006_structure.sql: communities, members, roles and member_roles (Plan 2 task 1).
-- Shorthand expanded per interfaces.md §4.3: ID -> BLOB NOT NULL CHECK (length(x) = 16),
-- TS/U -> INTEGER NOT NULL, every table STRICT (gap-66). Channels, overwrites, bans,
-- channel members and voice sessions land in their own schema files and migrations
-- (00005 onward), one per task, so a half-landed plan still migrates cleanly.
--
-- policy_json is the community policy document of protocol/09 (join mode, the stored but
-- unenforced screening flag, archival and delivery retention). It is TEXT on both engines:
-- the API validates it as JSON, and the bytes a client wrote are the bytes it reads back.
CREATE TABLE communities (
  id                      BLOB    NOT NULL CHECK (length(id) = 16) PRIMARY KEY,
  owner                   BLOB    NOT NULL CHECK (length(owner) = 16),
  name                    TEXT    NOT NULL,
  icon_blob               BLOB,
  policy_json             TEXT    NOT NULL,
  policy_version          INTEGER NOT NULL DEFAULT 1,
  min_account_age_seconds INTEGER NOT NULL DEFAULT 0,
  require_mod_2fa         INTEGER NOT NULL DEFAULT 0 CHECK (require_mod_2fa IN (0, 1)),
  created                 INTEGER NOT NULL,
  deleted_at              INTEGER
) STRICT;

CREATE TABLE members (
  community_id BLOB    NOT NULL CHECK (length(community_id) = 16)
                       REFERENCES communities(id) ON DELETE CASCADE,
  user_id      BLOB    NOT NULL CHECK (length(user_id) = 16)
                       REFERENCES users(id) ON DELETE CASCADE,
  joined       INTEGER NOT NULL,
  nick         TEXT    NOT NULL DEFAULT '',
  PRIMARY KEY (community_id, user_id)
) STRICT;

CREATE TABLE roles (
  id           BLOB    NOT NULL CHECK (length(id) = 16) PRIMARY KEY,
  community_id BLOB    NOT NULL CHECK (length(community_id) = 16)
                       REFERENCES communities(id) ON DELETE CASCADE,
  name         TEXT    NOT NULL,
  color        INTEGER NOT NULL DEFAULT 0,
  position     INTEGER NOT NULL DEFAULT 0,
  allow        INTEGER NOT NULL DEFAULT 0,
  deny         INTEGER NOT NULL DEFAULT 0,
  hoist        INTEGER NOT NULL DEFAULT 0 CHECK (hoist IN (0, 1)),
  mentionable  INTEGER NOT NULL DEFAULT 0 CHECK (mentionable IN (0, 1)),
  created      INTEGER NOT NULL
) STRICT;
CREATE INDEX roles_by_community ON roles(community_id, position);

CREATE TABLE member_roles (
  community_id BLOB NOT NULL CHECK (length(community_id) = 16),
  user_id      BLOB NOT NULL CHECK (length(user_id) = 16),
  role_id      BLOB NOT NULL CHECK (length(role_id) = 16)
                    REFERENCES roles(id) ON DELETE CASCADE,
  PRIMARY KEY (community_id, user_id, role_id),
  FOREIGN KEY (community_id, user_id) REFERENCES members(community_id, user_id) ON DELETE CASCADE
) STRICT;
