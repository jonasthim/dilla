-- +goose Up
-- The body of this section is internal/store/sqlite/schema/001_instance.sql,
-- 002_accounts.sql, 003_auth.sql and 009_ops.sql concatenated in that order,
-- verbatim. internal/store/schema_test.go asserts that, because sqlc reads the
-- schema directory and goose reads this file: if they drift, sqlc generates
-- against a schema the database does not have.

CREATE TABLE instances (
  instance_id            BLOB    NOT NULL PRIMARY KEY CHECK (length(instance_id) = 16),
  external_sender_key_id BLOB    NOT NULL CHECK (length(external_sender_key_id) = 16),
  key_history            BLOB    NOT NULL,
  franking_key_id        BLOB    NOT NULL CHECK (length(franking_key_id) = 16),
  generation             INTEGER NOT NULL DEFAULT 1,
  policy_version         INTEGER NOT NULL DEFAULT 1,
  created                INTEGER NOT NULL
) STRICT;

CREATE TABLE instance_settings (
  key     TEXT    NOT NULL PRIMARY KEY,
  value   BLOB    NOT NULL,
  updated INTEGER NOT NULL
) STRICT;
CREATE TABLE users (
  id          BLOB    NOT NULL PRIMARY KEY CHECK (length(id) = 16),
  username    TEXT    NOT NULL UNIQUE,
  display     TEXT    NOT NULL,
  kind        INTEGER NOT NULL CHECK (kind IN (0, 1)),
  umk_pub     BLOB    NOT NULL CHECK (length(umk_pub) = 32),
  ssk_pub     BLOB    NOT NULL CHECK (length(ssk_pub) = 32),
  sig_umk_ssk BLOB    NOT NULL CHECK (length(sig_umk_ssk) = 64),
  flags       INTEGER NOT NULL DEFAULT 0,
  age_bracket INTEGER NOT NULL DEFAULT 0,
  created     INTEGER NOT NULL,
  disabled_at INTEGER,
  deleted_at  INTEGER
) STRICT;

CREATE TABLE devices (
  id                BLOB    NOT NULL PRIMARY KEY CHECK (length(id) = 16),
  user_id           BLOB    NOT NULL CHECK (length(user_id) = 16) REFERENCES users(id) ON DELETE CASCADE,
  dsk_pub           BLOB    NOT NULL CHECK (length(dsk_pub) = 32),
  tier              INTEGER NOT NULL CHECK (tier IN (0, 1)),
  signer_tier       INTEGER NOT NULL CHECK (signer_tier IN (0, 1)),
  credential_blob   BLOB    NOT NULL,
  verified_at       INTEGER,
  revoked_at        INTEGER,
  quarantined_at    INTEGER,
  quarantine_reason TEXT    NOT NULL DEFAULT '',
  last_seen         INTEGER NOT NULL,
  created           INTEGER NOT NULL
) STRICT;

CREATE INDEX devices_by_user ON devices(user_id);

CREATE TABLE device_lists (
  user_id       BLOB    NOT NULL CHECK (length(user_id) = 16) REFERENCES users(id) ON DELETE CASCADE,
  version       INTEGER NOT NULL,
  blob          BLOB    NOT NULL,
  ssk_signature BLOB    NOT NULL CHECK (length(ssk_signature) = 64),
  prev_hash     BLOB    NOT NULL CHECK (length(prev_hash) = 32),
  created       INTEGER NOT NULL,
  PRIMARY KEY (user_id, version)
) STRICT;

CREATE TABLE sessions (
  token_hash   BLOB    NOT NULL PRIMARY KEY CHECK (length(token_hash) = 32),
  device_id    BLOB    NOT NULL CHECK (length(device_id) = 16) REFERENCES devices(id) ON DELETE CASCADE,
  user_id      BLOB    NOT NULL CHECK (length(user_id) = 16) REFERENCES users(id) ON DELETE CASCADE,
  scope        INTEGER NOT NULL CHECK (scope IN (0, 1, 2)),
  -- tier is copied from devices.tier when the session is issued, so Resolve can
  -- slide the idle window by the DEVICE tier without a second query and without
  -- confusing it with the session scope (deviation ID15).
  tier         INTEGER NOT NULL CHECK (tier IN (0, 1)),
  created      INTEGER NOT NULL,
  expires      INTEGER NOT NULL,
  idle_expires INTEGER NOT NULL
) STRICT;

CREATE INDEX sessions_by_device ON sessions(device_id, created);
CREATE TABLE password_credentials (
  user_id BLOB    NOT NULL PRIMARY KEY CHECK (length(user_id) = 16) REFERENCES users(id) ON DELETE CASCADE,
  phc     TEXT    NOT NULL,
  updated INTEGER NOT NULL
) STRICT;

CREATE TABLE totp_secrets (
  user_id      BLOB    NOT NULL PRIMARY KEY CHECK (length(user_id) = 16) REFERENCES users(id) ON DELETE CASCADE,
  secret       BLOB    NOT NULL,
  digits       INTEGER NOT NULL,
  period       INTEGER NOT NULL,
  algorithm    TEXT    NOT NULL,
  confirmed_at INTEGER,
  last_counter INTEGER NOT NULL DEFAULT 0,
  created      INTEGER NOT NULL
) STRICT;

CREATE TABLE recovery_codes (
  user_id   BLOB    NOT NULL CHECK (length(user_id) = 16) REFERENCES users(id) ON DELETE CASCADE,
  code_hash BLOB    NOT NULL CHECK (length(code_hash) = 32),
  created   INTEGER NOT NULL,
  used_at   INTEGER,
  PRIMARY KEY (user_id, code_hash)
) STRICT;

CREATE TABLE webauthn_users (
  rp_id       TEXT    NOT NULL,
  user_id     BLOB    NOT NULL CHECK (length(user_id) = 16) REFERENCES users(id) ON DELETE CASCADE,
  user_handle BLOB    NOT NULL CHECK (length(user_handle) = 64),
  created     INTEGER NOT NULL,
  PRIMARY KEY (rp_id, user_id)
) STRICT;

CREATE UNIQUE INDEX webauthn_users_by_handle ON webauthn_users(rp_id, user_handle);

CREATE TABLE webauthn_credentials (
  cred_id            BLOB    NOT NULL PRIMARY KEY,
  rp_id              TEXT    NOT NULL,
  user_id            BLOB    NOT NULL CHECK (length(user_id) = 16) REFERENCES users(id) ON DELETE CASCADE,
  public_key         BLOB    NOT NULL,
  sign_count         INTEGER NOT NULL DEFAULT 0,
  attestation_type   TEXT    NOT NULL DEFAULT '',
  attestation_format TEXT    NOT NULL DEFAULT '',
  transports         TEXT    NOT NULL DEFAULT '',
  flags              BLOB    NOT NULL,
  extensions_json    TEXT    NOT NULL DEFAULT '{}',
  name               TEXT    NOT NULL DEFAULT '',
  created            INTEGER NOT NULL,
  last_used          INTEGER
) STRICT;

CREATE INDEX webauthn_credentials_by_user ON webauthn_credentials(rp_id, user_id);

CREATE TABLE webauthn_ceremonies (
  id           BLOB    NOT NULL PRIMARY KEY CHECK (length(id) = 16),
  kind         INTEGER NOT NULL CHECK (kind IN (0, 1)),
  user_id      BLOB    CHECK (user_id IS NULL OR length(user_id) = 16) REFERENCES users(id) ON DELETE CASCADE,
  session_json TEXT    NOT NULL,
  created      INTEGER NOT NULL,
  expires      INTEGER NOT NULL
) STRICT;

CREATE TABLE oidc_identities (
  issuer  TEXT    NOT NULL,
  subject TEXT    NOT NULL,
  user_id BLOB    NOT NULL CHECK (length(user_id) = 16) REFERENCES users(id) ON DELETE CASCADE,
  created INTEGER NOT NULL,
  PRIMARY KEY (issuer, subject)
) STRICT;

CREATE TABLE login_attempts (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id BLOB    CHECK (user_id IS NULL OR length(user_id) = 16),
  ip      TEXT    NOT NULL,
  method  INTEGER NOT NULL,
  ok      INTEGER NOT NULL CHECK (ok IN (0, 1)),
  at      INTEGER NOT NULL
) STRICT;

CREATE INDEX login_attempts_by_user ON login_attempts(user_id, at);

CREATE TABLE invites (
  id           BLOB    NOT NULL PRIMARY KEY CHECK (length(id) = 16),
  code_hash    BLOB    NOT NULL UNIQUE CHECK (length(code_hash) = 32),
  community_id BLOB    CHECK (community_id IS NULL OR length(community_id) = 16),
  created_by   BLOB    CHECK (created_by IS NULL OR length(created_by) = 16),
  grants_admin INTEGER NOT NULL DEFAULT 0 CHECK (grants_admin IN (0, 1)),
  max_uses     INTEGER NOT NULL DEFAULT 1 CHECK (max_uses BETWEEN 1 AND 1000),
  used_count   INTEGER NOT NULL DEFAULT 0,
  created      INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL,
  revoked_at   INTEGER
) STRICT;
CREATE TABLE reports (
  id                  BLOB    NOT NULL PRIMARY KEY CHECK (length(id) = 16),
  reporter            BLOB    NOT NULL CHECK (length(reporter) = 16),
  group_id            BLOB    NOT NULL CHECK (length(group_id) = 16),
  seq                 INTEGER NOT NULL,
  revealed_envelope   BLOB    NOT NULL,
  k_f                 BLOB    NOT NULL CHECK (length(k_f) = 32),
  franking_key_id     BLOB    NOT NULL CHECK (length(franking_key_id) = 16),
  verification_result TEXT    NOT NULL,
  status              INTEGER NOT NULL,
  created             INTEGER NOT NULL
) STRICT;

CREATE TABLE audit_log (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  actor  BLOB    CHECK (actor IS NULL OR length(actor) = 16),
  action TEXT    NOT NULL,
  target TEXT    NOT NULL,
  detail TEXT    NOT NULL,
  at     INTEGER NOT NULL
) STRICT;

-- +goose Down
DROP TABLE audit_log;
DROP TABLE reports;
DROP TABLE invites;
DROP TABLE login_attempts;
DROP TABLE oidc_identities;
DROP TABLE webauthn_ceremonies;
DROP TABLE webauthn_credentials;
DROP TABLE webauthn_users;
DROP TABLE recovery_codes;
DROP TABLE totp_secrets;
DROP TABLE password_credentials;
DROP TABLE sessions;
DROP TABLE device_lists;
DROP TABLE devices;
DROP TABLE users;
DROP TABLE instance_settings;
DROP TABLE instances;
