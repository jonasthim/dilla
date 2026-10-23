-- +goose Up
CREATE TABLE automod_stepup_grants (
  token_hash BLOB PRIMARY KEY CHECK (length(token_hash) = 32),
  community_id BLOB NOT NULL CHECK (length(community_id) = 16) REFERENCES communities(id) ON DELETE CASCADE,
  installation_id BLOB NOT NULL CHECK (length(installation_id) = 16) REFERENCES bot_installations(id) ON DELETE CASCADE,
  group_id BLOB NOT NULL CHECK (length(group_id) = 16),
  request_id BLOB NOT NULL CHECK (length(request_id) = 16),
  actor_user BLOB NOT NULL CHECK (length(actor_user) = 16),
  actor_device BLOB NOT NULL CHECK (length(actor_device) = 16),
  expected_revision INTEGER NOT NULL CHECK (expected_revision >= 0),
  request_expires INTEGER NOT NULL CHECK (request_expires >= 0),
  config_hash BLOB NOT NULL CHECK (length(config_hash) = 32),
  expires INTEGER NOT NULL,
  consumed_at INTEGER,
  accepted_request_hash BLOB CHECK (accepted_request_hash IS NULL OR length(accepted_request_hash) = 32),
  receipt BLOB CHECK (receipt IS NULL OR length(receipt) = 16),
  CHECK ((consumed_at IS NULL AND accepted_request_hash IS NULL AND receipt IS NULL) OR
         (consumed_at IS NOT NULL AND accepted_request_hash IS NOT NULL AND receipt IS NOT NULL))
) STRICT;
CREATE INDEX automod_stepup_grants_expiry ON automod_stepup_grants(expires);

-- +goose Down
DROP TABLE automod_stepup_grants;
