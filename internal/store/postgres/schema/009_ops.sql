CREATE TABLE reports (
  id                  BYTEA  NOT NULL PRIMARY KEY CHECK (octet_length(id) = 16),
  reporter            BYTEA  NOT NULL CHECK (octet_length(reporter) = 16),
  group_id            BYTEA  NOT NULL CHECK (octet_length(group_id) = 16),
  seq                 BIGINT NOT NULL,
  revealed_envelope   BYTEA  NOT NULL,
  k_f                 BYTEA  NOT NULL CHECK (octet_length(k_f) = 32),
  franking_key_id     BYTEA  NOT NULL CHECK (octet_length(franking_key_id) = 16),
  verification_result TEXT   NOT NULL,
  status              BIGINT NOT NULL,
  created             BIGINT NOT NULL
);

CREATE TABLE audit_log (
  id     BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor  BYTEA  CHECK (actor IS NULL OR octet_length(actor) = 16),
  action TEXT   NOT NULL,
  target TEXT   NOT NULL,
  detail TEXT   NOT NULL,
  at     BIGINT NOT NULL
);
