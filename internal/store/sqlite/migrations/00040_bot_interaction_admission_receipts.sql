-- +goose Up
CREATE TABLE bot_interaction_admission_receipts (
  installation_id BLOB NOT NULL REFERENCES bot_installations(id) ON DELETE CASCADE CHECK(length(installation_id)=16),
  request_id BLOB NOT NULL CHECK(length(request_id)=16),
  request_hash BLOB NOT NULL CHECK(length(request_hash)=32),
  payload BLOB NOT NULL,
  signature BLOB NOT NULL CHECK(length(signature) IN (0,64)),
  not_after INTEGER NOT NULL CHECK(not_after > 0),
  PRIMARY KEY(installation_id,request_id)
) STRICT;

-- +goose Down
DROP TABLE bot_interaction_admission_receipts;
