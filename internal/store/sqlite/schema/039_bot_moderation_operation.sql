CREATE TABLE bot_operations_new (
  community_id BLOB NOT NULL CHECK (length(community_id) = 16) REFERENCES communities(id) ON DELETE CASCADE,
  request_id BLOB NOT NULL CHECK (length(request_id) = 16),
  installation_id BLOB NOT NULL CHECK (length(installation_id) = 16) REFERENCES bot_installations(id) ON DELETE CASCADE,
  actor_kind INTEGER NOT NULL CHECK (actor_kind IN (0, 1, 2)),
  actor_id BLOB NOT NULL CHECK (length(actor_id) = 16),
  actor_device BLOB CHECK (actor_device IS NULL OR length(actor_device) = 16),
  operation INTEGER NOT NULL CHECK (operation BETWEEN 1 AND 8),
  payload_hash BLOB NOT NULL CHECK (length(payload_hash) = 32),
  result_cbor BLOB NOT NULL CHECK (length(result_cbor) <= 8192),
  created INTEGER NOT NULL,
  PRIMARY KEY (community_id, request_id)
) STRICT;
INSERT INTO bot_operations_new SELECT community_id,request_id,installation_id,actor_kind,actor_id,actor_device,operation,payload_hash,result_cbor,created FROM bot_operations;
DROP TABLE bot_operations;
ALTER TABLE bot_operations_new RENAME TO bot_operations;
CREATE INDEX bot_operations_by_installation ON bot_operations(installation_id, created);

