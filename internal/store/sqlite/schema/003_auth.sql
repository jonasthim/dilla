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
