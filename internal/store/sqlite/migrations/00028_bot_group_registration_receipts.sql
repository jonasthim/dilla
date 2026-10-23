-- +goose Up
CREATE TABLE bot_group_registration_receipts (
  installation_id BLOB NOT NULL CHECK (length(installation_id) = 16) REFERENCES bot_installations(id) ON DELETE CASCADE,
  operation_id BLOB NOT NULL CHECK (length(operation_id) = 16),
  user_id BLOB NOT NULL CHECK (length(user_id) = 16),
  device_id BLOB NOT NULL CHECK (length(device_id) = 16),
  community_id BLOB NOT NULL CHECK (length(community_id) = 16),
  group_id BLOB NOT NULL CHECK (length(group_id) = 16),
  body_sha256 BLOB NOT NULL CHECK (length(body_sha256) = 32),
  generation INTEGER NOT NULL CHECK (generation >= 0),
  epoch INTEGER NOT NULL CHECK (epoch >= 0),
  next_seq INTEGER NOT NULL CHECK (next_seq > 0),
  accepted_at INTEGER NOT NULL,
  PRIMARY KEY (installation_id, operation_id),
  UNIQUE (group_id)
) STRICT;

-- +goose Down
DROP TABLE bot_group_registration_receipts;
