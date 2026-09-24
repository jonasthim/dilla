CREATE TABLE instances (
  instance_id            BYTEA  NOT NULL PRIMARY KEY CHECK (octet_length(instance_id) = 16),
  external_sender_key_id BYTEA  NOT NULL CHECK (octet_length(external_sender_key_id) = 16),
  key_history            BYTEA  NOT NULL,
  franking_key_id        BYTEA  NOT NULL CHECK (octet_length(franking_key_id) = 16),
  generation             BIGINT NOT NULL DEFAULT 1,
  policy_version         BIGINT NOT NULL DEFAULT 1,
  created                BIGINT NOT NULL
);

CREATE TABLE instance_settings (
  key     TEXT   NOT NULL PRIMARY KEY,
  value   BYTEA  NOT NULL,
  updated BIGINT NOT NULL
);
