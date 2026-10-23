-- +goose Up
CREATE TABLE bot_send_operations (
  installation_id BLOB NOT NULL CHECK (length(installation_id) = 16) REFERENCES bot_installations(id) ON DELETE CASCADE,
  operation_id BLOB NOT NULL CHECK (length(operation_id) = 16),
  user_id BLOB NOT NULL CHECK (length(user_id) = 16),
  device_id BLOB NOT NULL CHECK (length(device_id) = 16),
  community_id BLOB NOT NULL CHECK (length(community_id) = 16),
  group_id BLOB NOT NULL CHECK (length(group_id) = 16),
  current_attempt_id BLOB NOT NULL CHECK (length(current_attempt_id) = 16),
  accepted_attempt_id BLOB CHECK (accepted_attempt_id IS NULL OR length(accepted_attempt_id) = 16),
  state INTEGER NOT NULL CHECK (state BETWEEN 0 AND 2),
  CHECK ((state = 1 AND accepted_attempt_id IS NOT NULL) OR (state <> 1 AND accepted_attempt_id IS NULL)),
  PRIMARY KEY (installation_id, operation_id)
) STRICT;

CREATE TABLE bot_send_attempts (
  installation_id BLOB NOT NULL CHECK (length(installation_id) = 16),
  operation_id BLOB NOT NULL CHECK (length(operation_id) = 16),
  attempt_id BLOB NOT NULL CHECK (length(attempt_id) = 16),
  predecessor_attempt_id BLOB CHECK (predecessor_attempt_id IS NULL OR length(predecessor_attempt_id) = 16),
  expected_generation INTEGER NOT NULL CHECK (expected_generation >= 0),
  epoch INTEGER NOT NULL CHECK (epoch >= 0),
  class INTEGER NOT NULL CHECK (class BETWEEN 0 AND 1),
  ciphertext_sha256 BLOB NOT NULL CHECK (length(ciphertext_sha256) = 32),
  fingerprint_sha256 BLOB NOT NULL CHECK (length(fingerprint_sha256) = 32),
  outcome INTEGER NOT NULL CHECK (outcome BETWEEN 0 AND 2),
  receipt BLOB NOT NULL CHECK (length(receipt) BETWEEN 1 AND 512),
  PRIMARY KEY (installation_id, operation_id, attempt_id),
  FOREIGN KEY (installation_id, operation_id) REFERENCES bot_send_operations(installation_id, operation_id) ON DELETE CASCADE
) STRICT;

CREATE UNIQUE INDEX bot_send_attempts_first ON bot_send_attempts(installation_id, operation_id) WHERE predecessor_attempt_id IS NULL;
CREATE UNIQUE INDEX bot_send_attempts_successor ON bot_send_attempts(installation_id, operation_id, predecessor_attempt_id) WHERE predecessor_attempt_id IS NOT NULL;

-- +goose Down
DROP TABLE bot_send_attempts;
DROP TABLE bot_send_operations;
