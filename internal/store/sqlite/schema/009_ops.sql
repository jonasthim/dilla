CREATE TABLE reports (
  id                  BLOB    NOT NULL PRIMARY KEY CHECK (length(id) = 16),
  reporter            BLOB    NOT NULL CHECK (length(reporter) = 16),
  group_id            BLOB    NOT NULL CHECK (length(group_id) = 16),
  seq                 INTEGER NOT NULL,
  revealed_envelope   BLOB    NOT NULL,
  k_f                 BLOB    NOT NULL CHECK (length(k_f) = 32),
  franking_key_id     BLOB    NOT NULL CHECK (length(franking_key_id) = 16),
  verification_result TEXT    NOT NULL,
  status              INTEGER NOT NULL,
  created             INTEGER NOT NULL
) STRICT;

CREATE TABLE audit_log (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  actor  BLOB    CHECK (actor IS NULL OR length(actor) = 16),
  action TEXT    NOT NULL,
  target TEXT    NOT NULL,
  detail TEXT    NOT NULL,
  at     INTEGER NOT NULL
) STRICT;
