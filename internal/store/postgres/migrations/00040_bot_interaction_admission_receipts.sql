-- +goose Up
CREATE TABLE bot_interaction_admission_receipts (
  installation_id BYTEA NOT NULL REFERENCES bot_installations(id) ON DELETE CASCADE CHECK(octet_length(installation_id)=16),
  request_id BYTEA NOT NULL CHECK(octet_length(request_id)=16),
  request_hash BYTEA NOT NULL CHECK(octet_length(request_hash)=32),
  payload BYTEA NOT NULL,
  signature BYTEA NOT NULL CHECK(octet_length(signature) IN (0,64)),
  not_after BIGINT NOT NULL CHECK(not_after > 0),
  PRIMARY KEY(installation_id,request_id)
);

-- +goose Down
DROP TABLE bot_interaction_admission_receipts;
