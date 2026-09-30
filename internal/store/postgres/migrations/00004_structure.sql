-- +goose Up
-- The body of this section is internal/store/postgres/schema/006_structure.sql, verbatim.
-- internal/store/schema_test.go asserts that, because sqlc reads the schema directory and
-- goose reads this file: if they drift, sqlc generates against a schema the database does
-- not have.

-- 006_structure.sql: the SQLite file with interfaces.md §4.2's substitutions:
-- BLOB -> BYTEA with octet_length, INTEGER -> BIGINT, enums -> SMALLINT, no STRICT suffix.
--
-- policy_json is TEXT here too, not the JSONB §4.2 names (plan deviation, gap-66's rule:
-- JSONB only where a Postgres-only query needs its operators, and none does). JSONB
-- re-serialises what it stores (whitespace, key order, duplicate keys), so a policy read
-- back from Postgres would differ byte for byte from the one written and from what SQLite
-- returns. The API validates the document as JSON on the way in, on both engines.
CREATE TABLE communities (
  id                      BYTEA    NOT NULL CHECK (octet_length(id) = 16) PRIMARY KEY,
  owner                   BYTEA    NOT NULL CHECK (octet_length(owner) = 16),
  name                    TEXT     NOT NULL,
  icon_blob               BYTEA,
  policy_json             TEXT     NOT NULL,
  policy_version          BIGINT   NOT NULL DEFAULT 1,
  min_account_age_seconds BIGINT   NOT NULL DEFAULT 0,
  require_mod_2fa         SMALLINT NOT NULL DEFAULT 0 CHECK (require_mod_2fa IN (0, 1)),
  created                 BIGINT   NOT NULL,
  deleted_at              BIGINT
);

CREATE TABLE members (
  community_id BYTEA  NOT NULL CHECK (octet_length(community_id) = 16)
                      REFERENCES communities(id) ON DELETE CASCADE,
  user_id      BYTEA  NOT NULL CHECK (octet_length(user_id) = 16)
                      REFERENCES users(id) ON DELETE CASCADE,
  joined       BIGINT NOT NULL,
  nick         TEXT   NOT NULL DEFAULT '',
  PRIMARY KEY (community_id, user_id)
);

CREATE TABLE roles (
  id           BYTEA    NOT NULL CHECK (octet_length(id) = 16) PRIMARY KEY,
  community_id BYTEA    NOT NULL CHECK (octet_length(community_id) = 16)
                        REFERENCES communities(id) ON DELETE CASCADE,
  name         TEXT     NOT NULL,
  color        BIGINT   NOT NULL DEFAULT 0,
  position     BIGINT   NOT NULL DEFAULT 0,
  allow        BIGINT   NOT NULL DEFAULT 0,
  deny         BIGINT   NOT NULL DEFAULT 0,
  hoist        SMALLINT NOT NULL DEFAULT 0 CHECK (hoist IN (0, 1)),
  mentionable  SMALLINT NOT NULL DEFAULT 0 CHECK (mentionable IN (0, 1)),
  created      BIGINT   NOT NULL
);
CREATE INDEX roles_by_community ON roles(community_id, position);

CREATE TABLE member_roles (
  community_id BYTEA NOT NULL CHECK (octet_length(community_id) = 16),
  user_id      BYTEA NOT NULL CHECK (octet_length(user_id) = 16),
  role_id      BYTEA NOT NULL CHECK (octet_length(role_id) = 16)
                     REFERENCES roles(id) ON DELETE CASCADE,
  PRIMARY KEY (community_id, user_id, role_id),
  FOREIGN KEY (community_id, user_id) REFERENCES members(community_id, user_id) ON DELETE CASCADE
);

-- +goose Down
DROP TABLE member_roles;
DROP INDEX roles_by_community;
DROP TABLE roles;
DROP TABLE members;
DROP TABLE communities;
