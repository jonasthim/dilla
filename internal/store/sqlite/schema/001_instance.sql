CREATE TABLE instances (
  instance_id            BLOB    NOT NULL PRIMARY KEY CHECK (length(instance_id) = 16),
  external_sender_key_id BLOB    NOT NULL CHECK (length(external_sender_key_id) = 16),
  key_history            BLOB    NOT NULL,
  franking_key_id        BLOB    NOT NULL CHECK (length(franking_key_id) = 16),
  generation             INTEGER NOT NULL DEFAULT 1,
  policy_version         INTEGER NOT NULL DEFAULT 1,
  created                INTEGER NOT NULL
) STRICT;

CREATE TABLE instance_settings (
  key     TEXT    NOT NULL PRIMARY KEY,
  value   BLOB    NOT NULL,
  updated INTEGER NOT NULL
) STRICT;
