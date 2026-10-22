CREATE TABLE bot_group_registration_receipts (
  installation_id BYTEA NOT NULL CHECK (octet_length(installation_id) = 16) REFERENCES bot_installations(id) ON DELETE CASCADE,
  operation_id BYTEA NOT NULL CHECK (octet_length(operation_id) = 16),
  user_id BYTEA NOT NULL CHECK (octet_length(user_id) = 16),
  device_id BYTEA NOT NULL CHECK (octet_length(device_id) = 16),
  community_id BYTEA NOT NULL CHECK (octet_length(community_id) = 16),
  group_id BYTEA NOT NULL CHECK (octet_length(group_id) = 16),
  body_sha256 BYTEA NOT NULL CHECK (octet_length(body_sha256) = 32),
  generation BIGINT NOT NULL CHECK (generation >= 0),
  epoch BIGINT NOT NULL CHECK (epoch >= 0),
  next_seq BIGINT NOT NULL CHECK (next_seq > 0),
  accepted_at BIGINT NOT NULL,
  PRIMARY KEY (installation_id, operation_id),
  UNIQUE (group_id)
);
