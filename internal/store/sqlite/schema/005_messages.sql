CREATE TABLE mls_app_messages (
  group_id        BLOB    NOT NULL CHECK (length(group_id) = 16)
                  REFERENCES mls_groups(group_id) ON DELETE CASCADE,
  seq             INTEGER NOT NULL,
  epoch           INTEGER NOT NULL,
  uploader_device BLOB    NOT NULL CHECK (length(uploader_device) = 16),
  blob            BLOB,                                   -- NULL once tombstoned
  commitment_c    BLOB             CHECK (commitment_c IS NULL OR length(commitment_c) = 32),
  franking_tag    BLOB    NOT NULL CHECK (length(franking_tag) = 32),
  size            INTEGER NOT NULL,
  created         INTEGER NOT NULL,                       -- recv_ts
  expires         INTEGER,                                -- NULL = retained (archival policy)
  deleted_at      INTEGER,
  PRIMARY KEY (group_id, seq)
) STRICT;
CREATE INDEX mls_app_messages_expiry ON mls_app_messages(expires) WHERE expires IS NOT NULL;
