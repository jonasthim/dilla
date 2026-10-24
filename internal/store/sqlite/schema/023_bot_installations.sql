-- Managed bot rows contain identifiers and structural state only; no bearer secrets or reason text.
CREATE UNIQUE INDEX devices_id_user ON devices(id, user_id);
CREATE UNIQUE INDEX roles_id_community ON roles(id, community_id);
CREATE UNIQUE INDEX sessions_hash_user_device ON sessions(token_hash, user_id, device_id);

CREATE TABLE bot_runtimes (
  id         BLOB    NOT NULL PRIMARY KEY CHECK (length(id) = 16),
  token_hash BLOB    NOT NULL UNIQUE CHECK (length(token_hash) = 32),
  created    INTEGER NOT NULL,
  rotated    INTEGER NOT NULL,
  revoked_at INTEGER
) STRICT;

CREATE TABLE bot_installations (
  id                      BLOB    NOT NULL PRIMARY KEY CHECK (length(id) = 16),
  community_id            BLOB    NOT NULL CHECK (length(community_id) = 16) REFERENCES communities(id) ON DELETE CASCADE,
  runtime_id              BLOB    REFERENCES bot_runtimes(id) ON DELETE SET NULL,
  user_id                 BLOB    CHECK (user_id IS NULL OR length(user_id) = 16) REFERENCES users(id) ON DELETE SET NULL,
  device_id               BLOB    CHECK (device_id IS NULL OR length(device_id) = 16),
  role_id                 BLOB    CHECK (role_id IS NULL OR length(role_id) = 16),
  state                   INTEGER NOT NULL CHECK (state BETWEEN 0 AND 5),
  revision                INTEGER NOT NULL CHECK (revision > 0),
  capabilities            INTEGER NOT NULL CHECK (capabilities BETWEEN 0 AND 255),
  approved_by             BLOB    NOT NULL CHECK (length(approved_by) = 16) REFERENCES users(id),
  approved_at             INTEGER NOT NULL,
  credential_verified_at  INTEGER,
  created                 INTEGER NOT NULL,
  updated                 INTEGER NOT NULL,
  removed_at              INTEGER,
  CHECK (removed_at IS NULL OR state = 4),
  CHECK ((user_id IS NULL AND device_id IS NULL) OR (user_id IS NOT NULL AND device_id IS NOT NULL)),
  UNIQUE (id, user_id, device_id),
  FOREIGN KEY (device_id, user_id) REFERENCES devices(id, user_id) ON DELETE SET NULL,
  FOREIGN KEY (role_id, community_id) REFERENCES roles(id, community_id)
) STRICT;
CREATE UNIQUE INDEX bot_installations_active_community ON bot_installations(community_id) WHERE removed_at IS NULL;
CREATE UNIQUE INDEX bot_installations_user_device ON bot_installations(user_id, device_id) WHERE user_id IS NOT NULL;
CREATE INDEX bot_installations_by_device ON bot_installations(device_id, id);
CREATE INDEX bot_installations_by_community ON bot_installations(community_id, id);

CREATE TABLE bot_claims (
  installation_id BLOB    NOT NULL PRIMARY KEY CHECK (length(installation_id) = 16) REFERENCES bot_installations(id) ON DELETE CASCADE,
  runtime_id      BLOB    NOT NULL CHECK (length(runtime_id) = 16) REFERENCES bot_runtimes(id) ON DELETE CASCADE,
  claim_id        BLOB    NOT NULL UNIQUE CHECK (length(claim_id) = 16),
  request_id      BLOB    NOT NULL CHECK (length(request_id) = 16),
  expires         INTEGER NOT NULL
) STRICT;
CREATE INDEX bot_claims_by_runtime ON bot_claims(runtime_id);

CREATE TABLE bot_operations (
  community_id    BLOB    NOT NULL CHECK (length(community_id) = 16) REFERENCES communities(id) ON DELETE CASCADE,
  request_id      BLOB    NOT NULL CHECK (length(request_id) = 16),
  installation_id BLOB    NOT NULL CHECK (length(installation_id) = 16) REFERENCES bot_installations(id) ON DELETE CASCADE,
  actor_kind      INTEGER NOT NULL CHECK (actor_kind IN (0, 1, 2)),
  actor_id        BLOB    NOT NULL CHECK (length(actor_id) = 16),
  actor_device    BLOB    CHECK (actor_device IS NULL OR length(actor_device) = 16),
  operation       INTEGER NOT NULL CHECK (operation BETWEEN 1 AND 7),
  payload_hash    BLOB    NOT NULL CHECK (length(payload_hash) = 32),
  result_cbor     BLOB    NOT NULL CHECK (length(result_cbor) <= 8192),
  created         INTEGER NOT NULL,
  PRIMARY KEY (community_id, request_id)
) STRICT;
CREATE INDEX bot_operations_by_installation ON bot_operations(installation_id, created);

CREATE TABLE bot_session_bindings (
  token_hash      BLOB    NOT NULL PRIMARY KEY CHECK (length(token_hash) = 32),
  installation_id BLOB    NOT NULL CHECK (length(installation_id) = 16),
  user_id         BLOB    NOT NULL CHECK (length(user_id) = 16),
  device_id       BLOB    NOT NULL CHECK (length(device_id) = 16),
  created         INTEGER NOT NULL,
  FOREIGN KEY (token_hash, user_id, device_id) REFERENCES sessions(token_hash, user_id, device_id) ON DELETE CASCADE,
  FOREIGN KEY (installation_id, user_id, device_id) REFERENCES bot_installations(id, user_id, device_id) ON DELETE CASCADE
) STRICT;
CREATE INDEX bot_session_bindings_by_installation ON bot_session_bindings(installation_id);
