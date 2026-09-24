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
