CREATE TABLE password_credentials (
  user_id BYTEA  NOT NULL PRIMARY KEY CHECK (octet_length(user_id) = 16) REFERENCES users(id) ON DELETE CASCADE,
  phc     TEXT   NOT NULL,
  updated BIGINT NOT NULL
);

CREATE TABLE totp_secrets (
  user_id      BYTEA  NOT NULL PRIMARY KEY CHECK (octet_length(user_id) = 16) REFERENCES users(id) ON DELETE CASCADE,
  secret       BYTEA  NOT NULL,
  digits       BIGINT NOT NULL,
  period       BIGINT NOT NULL,
  algorithm    TEXT   NOT NULL,
  confirmed_at BIGINT,
  last_counter BIGINT NOT NULL DEFAULT 0,
  created      BIGINT NOT NULL
);

CREATE TABLE recovery_codes (
  user_id   BYTEA  NOT NULL CHECK (octet_length(user_id) = 16) REFERENCES users(id) ON DELETE CASCADE,
  code_hash BYTEA  NOT NULL CHECK (octet_length(code_hash) = 32),
  created   BIGINT NOT NULL,
  used_at   BIGINT,
  PRIMARY KEY (user_id, code_hash)
);

CREATE TABLE webauthn_users (
  rp_id       TEXT   NOT NULL,
  user_id     BYTEA  NOT NULL CHECK (octet_length(user_id) = 16) REFERENCES users(id) ON DELETE CASCADE,
  user_handle BYTEA  NOT NULL CHECK (octet_length(user_handle) = 64),
  created     BIGINT NOT NULL,
  PRIMARY KEY (rp_id, user_id)
);

CREATE UNIQUE INDEX webauthn_users_by_handle ON webauthn_users(rp_id, user_handle);

CREATE TABLE webauthn_credentials (
  cred_id            BYTEA  NOT NULL PRIMARY KEY,
  rp_id              TEXT   NOT NULL,
  user_id            BYTEA  NOT NULL CHECK (octet_length(user_id) = 16) REFERENCES users(id) ON DELETE CASCADE,
  public_key         BYTEA  NOT NULL,
  sign_count         BIGINT NOT NULL DEFAULT 0,
  attestation_type   TEXT   NOT NULL DEFAULT '',
  attestation_format TEXT   NOT NULL DEFAULT '',
  transports         TEXT   NOT NULL DEFAULT '',
  flags              BYTEA  NOT NULL,
  extensions_json    TEXT   NOT NULL DEFAULT '{}',
  name               TEXT   NOT NULL DEFAULT '',
  created            BIGINT NOT NULL,
  last_used          BIGINT
);

CREATE INDEX webauthn_credentials_by_user ON webauthn_credentials(rp_id, user_id);

CREATE TABLE webauthn_ceremonies (
  id           BYTEA    NOT NULL PRIMARY KEY CHECK (octet_length(id) = 16),
  kind         SMALLINT NOT NULL CHECK (kind IN (0, 1)),
  user_id      BYTEA    CHECK (user_id IS NULL OR octet_length(user_id) = 16) REFERENCES users(id) ON DELETE CASCADE,
  session_json TEXT     NOT NULL,
  created      BIGINT   NOT NULL,
  expires      BIGINT   NOT NULL
);

CREATE TABLE oidc_identities (
  issuer  TEXT   NOT NULL,
  subject TEXT   NOT NULL,
  user_id BYTEA  NOT NULL CHECK (octet_length(user_id) = 16) REFERENCES users(id) ON DELETE CASCADE,
  created BIGINT NOT NULL,
  PRIMARY KEY (issuer, subject)
);

CREATE TABLE login_attempts (
  id      BIGINT   GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id BYTEA    CHECK (user_id IS NULL OR octet_length(user_id) = 16),
  ip      TEXT     NOT NULL,
  method  BIGINT   NOT NULL,
  ok      SMALLINT NOT NULL CHECK (ok IN (0, 1)),
  at      BIGINT   NOT NULL
);

CREATE INDEX login_attempts_by_user ON login_attempts(user_id, at);

CREATE TABLE invites (
  id           BYTEA    NOT NULL PRIMARY KEY CHECK (octet_length(id) = 16),
  code_hash    BYTEA    NOT NULL UNIQUE CHECK (octet_length(code_hash) = 32),
  community_id BYTEA    CHECK (community_id IS NULL OR octet_length(community_id) = 16),
  created_by   BYTEA    CHECK (created_by IS NULL OR octet_length(created_by) = 16),
  grants_admin SMALLINT NOT NULL DEFAULT 0 CHECK (grants_admin IN (0, 1)),
  max_uses     BIGINT   NOT NULL DEFAULT 1 CHECK (max_uses BETWEEN 1 AND 1000),
  used_count   BIGINT   NOT NULL DEFAULT 0,
  created      BIGINT   NOT NULL,
  expires_at   BIGINT   NOT NULL,
  revoked_at   BIGINT
);
