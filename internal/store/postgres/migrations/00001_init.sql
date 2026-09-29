-- +goose Up
-- The body of this section is internal/store/postgres/schema/001_instance.sql,
-- 002_accounts.sql, 003_auth.sql and 009_ops.sql concatenated in that order,
-- verbatim. internal/store/schema_test.go asserts that, because sqlc reads the
-- schema directory and goose reads this file: if they drift, sqlc generates
-- against a schema the database does not have.

CREATE TABLE instances (
  instance_id            BYTEA  NOT NULL PRIMARY KEY CHECK (octet_length(instance_id) = 16),
  external_sender_key_id BYTEA  NOT NULL CHECK (octet_length(external_sender_key_id) = 16),
  key_history            BYTEA  NOT NULL,
  franking_key_id        BYTEA  NOT NULL CHECK (octet_length(franking_key_id) = 16),
  generation             BIGINT NOT NULL DEFAULT 1,
  policy_version         BIGINT NOT NULL DEFAULT 1,
  created                BIGINT NOT NULL
);

CREATE TABLE instance_settings (
  key     TEXT   NOT NULL PRIMARY KEY,
  value   BYTEA  NOT NULL,
  updated BIGINT NOT NULL
);
CREATE TABLE users (
  id          BYTEA    NOT NULL PRIMARY KEY CHECK (octet_length(id) = 16),
  username    TEXT     NOT NULL UNIQUE,
  display     TEXT     NOT NULL,
  kind        SMALLINT NOT NULL CHECK (kind IN (0, 1)),
  umk_pub     BYTEA    NOT NULL CHECK (octet_length(umk_pub) = 32),
  ssk_pub     BYTEA    NOT NULL CHECK (octet_length(ssk_pub) = 32),
  sig_umk_ssk BYTEA    NOT NULL CHECK (octet_length(sig_umk_ssk) = 64),
  flags       BIGINT   NOT NULL DEFAULT 0,
  age_bracket BIGINT   NOT NULL DEFAULT 0,
  created     BIGINT   NOT NULL,
  disabled_at BIGINT,
  deleted_at  BIGINT
);

CREATE TABLE devices (
  id                BYTEA    NOT NULL PRIMARY KEY CHECK (octet_length(id) = 16),
  user_id           BYTEA    NOT NULL CHECK (octet_length(user_id) = 16) REFERENCES users(id) ON DELETE CASCADE,
  dsk_pub           BYTEA    NOT NULL CHECK (octet_length(dsk_pub) = 32),
  tier              SMALLINT NOT NULL CHECK (tier IN (0, 1)),
  signer_tier       SMALLINT NOT NULL CHECK (signer_tier IN (0, 1)),
  credential_blob   BYTEA    NOT NULL,
  verified_at       BIGINT,
  revoked_at        BIGINT,
  quarantined_at    BIGINT,
  quarantine_reason TEXT     NOT NULL DEFAULT '',
  last_seen         BIGINT   NOT NULL,
  created           BIGINT   NOT NULL
);

CREATE INDEX devices_by_user ON devices(user_id);

CREATE TABLE device_lists (
  user_id       BYTEA  NOT NULL CHECK (octet_length(user_id) = 16) REFERENCES users(id) ON DELETE CASCADE,
  version       BIGINT NOT NULL,
  blob          BYTEA  NOT NULL,
  ssk_signature BYTEA  NOT NULL CHECK (octet_length(ssk_signature) = 64),
  prev_hash     BYTEA  NOT NULL CHECK (octet_length(prev_hash) = 32),
  created       BIGINT NOT NULL,
  PRIMARY KEY (user_id, version)
);

CREATE TABLE sessions (
  token_hash   BYTEA    NOT NULL PRIMARY KEY CHECK (octet_length(token_hash) = 32),
  device_id    BYTEA    NOT NULL CHECK (octet_length(device_id) = 16) REFERENCES devices(id) ON DELETE CASCADE,
  user_id      BYTEA    NOT NULL CHECK (octet_length(user_id) = 16) REFERENCES users(id) ON DELETE CASCADE,
  scope        SMALLINT NOT NULL CHECK (scope IN (0, 1, 2)),
  tier         SMALLINT NOT NULL CHECK (tier IN (0, 1)),
  created      BIGINT   NOT NULL,
  expires      BIGINT   NOT NULL,
  idle_expires BIGINT   NOT NULL
);

CREATE INDEX sessions_by_device ON sessions(device_id, created);
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
CREATE TABLE reports (
  id                  BYTEA  NOT NULL PRIMARY KEY CHECK (octet_length(id) = 16),
  reporter            BYTEA  NOT NULL CHECK (octet_length(reporter) = 16),
  group_id            BYTEA  NOT NULL CHECK (octet_length(group_id) = 16),
  seq                 BIGINT NOT NULL,
  revealed_envelope   BYTEA  NOT NULL,
  k_f                 BYTEA  NOT NULL CHECK (octet_length(k_f) = 32),
  franking_key_id     BYTEA  NOT NULL CHECK (octet_length(franking_key_id) = 16),
  verification_result TEXT   NOT NULL,
  status              BIGINT NOT NULL,
  created             BIGINT NOT NULL
);

CREATE TABLE audit_log (
  id     BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor  BYTEA  CHECK (actor IS NULL OR octet_length(actor) = 16),
  action TEXT   NOT NULL,
  target TEXT   NOT NULL,
  detail TEXT   NOT NULL,
  at     BIGINT NOT NULL
);

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
