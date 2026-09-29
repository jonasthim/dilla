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
