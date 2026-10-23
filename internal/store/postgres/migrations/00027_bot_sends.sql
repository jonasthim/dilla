-- +goose Up
CREATE TABLE bot_send_operations (
  installation_id BYTEA NOT NULL CHECK (octet_length(installation_id) = 16) REFERENCES bot_installations(id) ON DELETE CASCADE,
  operation_id BYTEA NOT NULL CHECK (octet_length(operation_id) = 16),
  user_id BYTEA NOT NULL CHECK (octet_length(user_id) = 16),
  device_id BYTEA NOT NULL CHECK (octet_length(device_id) = 16),
  community_id BYTEA NOT NULL CHECK (octet_length(community_id) = 16),
  group_id BYTEA NOT NULL CHECK (octet_length(group_id) = 16),
  current_attempt_id BYTEA NOT NULL CHECK (octet_length(current_attempt_id) = 16),
  accepted_attempt_id BYTEA CHECK (accepted_attempt_id IS NULL OR octet_length(accepted_attempt_id) = 16),
  state BIGINT NOT NULL CHECK (state BETWEEN 0 AND 2),
  CHECK ((state = 1 AND accepted_attempt_id IS NOT NULL) OR (state <> 1 AND accepted_attempt_id IS NULL)),
  PRIMARY KEY (installation_id, operation_id)
);

CREATE TABLE bot_send_attempts (
  installation_id BYTEA NOT NULL CHECK (octet_length(installation_id) = 16),
  operation_id BYTEA NOT NULL CHECK (octet_length(operation_id) = 16),
  attempt_id BYTEA NOT NULL CHECK (octet_length(attempt_id) = 16),
  predecessor_attempt_id BYTEA CHECK (predecessor_attempt_id IS NULL OR octet_length(predecessor_attempt_id) = 16),
  expected_generation BIGINT NOT NULL CHECK (expected_generation >= 0),
  epoch BIGINT NOT NULL CHECK (epoch >= 0),
  class BIGINT NOT NULL CHECK (class BETWEEN 0 AND 1),
  ciphertext_sha256 BYTEA NOT NULL CHECK (octet_length(ciphertext_sha256) = 32),
  fingerprint_sha256 BYTEA NOT NULL CHECK (octet_length(fingerprint_sha256) = 32),
  outcome BIGINT NOT NULL CHECK (outcome BETWEEN 0 AND 2),
  receipt BYTEA NOT NULL CHECK (octet_length(receipt) BETWEEN 1 AND 512),
  PRIMARY KEY (installation_id, operation_id, attempt_id),
  FOREIGN KEY (installation_id, operation_id) REFERENCES bot_send_operations(installation_id, operation_id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX bot_send_attempts_first ON bot_send_attempts(installation_id, operation_id) WHERE predecessor_attempt_id IS NULL;
CREATE UNIQUE INDEX bot_send_attempts_successor ON bot_send_attempts(installation_id, operation_id, predecessor_attempt_id) WHERE predecessor_attempt_id IS NOT NULL;

-- +goose Down
DROP TABLE bot_send_attempts;
DROP TABLE bot_send_operations;
