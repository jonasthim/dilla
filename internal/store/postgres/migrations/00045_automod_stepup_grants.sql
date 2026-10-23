-- +goose Up
CREATE TABLE automod_stepup_grants (
  token_hash BYTEA PRIMARY KEY CHECK (octet_length(token_hash) = 32),
  community_id BYTEA NOT NULL REFERENCES communities(id) ON DELETE CASCADE CHECK (octet_length(community_id) = 16),
  installation_id BYTEA NOT NULL REFERENCES bot_installations(id) ON DELETE CASCADE CHECK (octet_length(installation_id) = 16),
  group_id BYTEA NOT NULL CHECK (octet_length(group_id) = 16),
  request_id BYTEA NOT NULL CHECK (octet_length(request_id) = 16),
  actor_user BYTEA NOT NULL CHECK (octet_length(actor_user) = 16),
  actor_device BYTEA NOT NULL CHECK (octet_length(actor_device) = 16),
  expected_revision BIGINT NOT NULL CHECK (expected_revision >= 0),
  request_expires BIGINT NOT NULL CHECK (request_expires >= 0),
  config_hash BYTEA NOT NULL CHECK (octet_length(config_hash) = 32),
  expires BIGINT NOT NULL,
  consumed_at BIGINT,
  accepted_request_hash BYTEA CHECK (accepted_request_hash IS NULL OR octet_length(accepted_request_hash) = 32),
  receipt BYTEA CHECK (receipt IS NULL OR octet_length(receipt) = 16),
  CHECK ((consumed_at IS NULL AND accepted_request_hash IS NULL AND receipt IS NULL) OR
         (consumed_at IS NOT NULL AND accepted_request_hash IS NOT NULL AND receipt IS NOT NULL))
);
CREATE INDEX automod_stepup_grants_expiry ON automod_stepup_grants(expires);

-- +goose Down
DROP TABLE automod_stepup_grants;
