-- +goose Up
-- Durable binding between a kind-3 admission request and the accepted group
-- registration it consumed. Keep this independently of admission payload
-- compaction so retries/recovery cannot spend the admission twice.
CREATE TABLE bot_group_registration_admission_receipts (
  installation_id BLOB NOT NULL REFERENCES bot_installations(id) ON DELETE CASCADE CHECK(length(installation_id)=16),
  admission_request_id BLOB NOT NULL CHECK(length(admission_request_id)=16),
  operation_id BLOB NOT NULL CHECK(length(operation_id)=16),
  user_id BLOB NOT NULL CHECK(length(user_id)=16),
  device_id BLOB NOT NULL CHECK(length(device_id)=16),
  community_id BLOB NOT NULL CHECK(length(community_id)=16),
  group_id BLOB NOT NULL CHECK(length(group_id)=16),
  body_sha256 BLOB NOT NULL CHECK(length(body_sha256)=32),
  generation INTEGER NOT NULL CHECK(generation >= 0),
  epoch INTEGER NOT NULL CHECK(epoch >= 0),
  next_seq INTEGER NOT NULL CHECK(next_seq > 0),
  accepted_at INTEGER NOT NULL,
  PRIMARY KEY(installation_id, admission_request_id),
  UNIQUE(group_id),
  UNIQUE(installation_id, operation_id)
) STRICT;

-- +goose Down
DROP TABLE bot_group_registration_admission_receipts;
