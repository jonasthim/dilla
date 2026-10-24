-- +goose Up
CREATE TABLE bot_keypackage_publication_receipts (
  installation_id BYTEA NOT NULL REFERENCES bot_installations(id),
  user_id         BYTEA NOT NULL REFERENCES users(id),
  device_id       BYTEA NOT NULL REFERENCES devices(id),
  operation_id    BYTEA NOT NULL CHECK (octet_length(operation_id) = 16),
  generation      BIGINT NOT NULL CHECK (generation >= 0),
  upload_sha256   BYTEA NOT NULL CHECK (octet_length(upload_sha256) = 32),
  package_count   BIGINT NOT NULL CHECK (package_count BETWEEN 1 AND 33),
  accepted_at     BIGINT NOT NULL,
  PRIMARY KEY (installation_id, operation_id)
);
CREATE INDEX bot_keypackage_receipts_by_device ON bot_keypackage_publication_receipts(device_id, installation_id);

-- +goose Down
DROP TABLE bot_keypackage_publication_receipts;
