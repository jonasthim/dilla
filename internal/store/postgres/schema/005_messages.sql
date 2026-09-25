CREATE TABLE mls_app_messages (
  group_id        BYTEA  NOT NULL CHECK (octet_length(group_id) = 16)
                  REFERENCES mls_groups(group_id) ON DELETE CASCADE,
  seq             BIGINT NOT NULL,
  epoch           BIGINT NOT NULL,
  uploader_device BYTEA  NOT NULL CHECK (octet_length(uploader_device) = 16),
  blob            BYTEA,                                  -- NULL once tombstoned
  commitment_c    BYTEA           CHECK (commitment_c IS NULL OR octet_length(commitment_c) = 32),
  franking_tag    BYTEA  NOT NULL CHECK (octet_length(franking_tag) = 32),
  size            BIGINT NOT NULL,
  created         BIGINT NOT NULL,                        -- recv_ts
  expires         BIGINT,                                 -- NULL = retained (archival policy)
  deleted_at      BIGINT,
  PRIMARY KEY (group_id, seq)
);
CREATE INDEX mls_app_messages_expiry ON mls_app_messages(expires) WHERE expires IS NOT NULL;
