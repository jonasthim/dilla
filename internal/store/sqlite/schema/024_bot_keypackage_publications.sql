CREATE TABLE bot_keypackage_publication_receipts (
  installation_id BLOB NOT NULL CHECK (length(installation_id) = 16) REFERENCES bot_installations(id),
  user_id         BLOB NOT NULL CHECK (length(user_id) = 16) REFERENCES users(id),
  device_id       BLOB NOT NULL CHECK (length(device_id) = 16) REFERENCES devices(id),
  operation_id    BLOB NOT NULL CHECK (length(operation_id) = 16),
  generation      INTEGER NOT NULL CHECK (generation >= 0),
  upload_sha256   BLOB NOT NULL CHECK (length(upload_sha256) = 32),
  package_count   INTEGER NOT NULL CHECK (package_count BETWEEN 1 AND 33),
  accepted_at     INTEGER NOT NULL,
  PRIMARY KEY (installation_id, operation_id)
) STRICT;
CREATE INDEX bot_keypackage_receipts_by_device ON bot_keypackage_publication_receipts(device_id, installation_id);
