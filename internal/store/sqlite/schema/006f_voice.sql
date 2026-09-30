-- 006f_voice.sql: voice_sessions (Plan 2 task 16, P2-D22), migration 00011_voice.sql. A file of
-- its own for the reason 006a_channels.sql gives: every schema file appears verbatim inside
-- exactly one migration, and 006_structure.sql is already 00004_structure.sql's. The name sorts
-- after 006a_channels.sql, so sqlc reads channels before the table that references it.
--
-- One row is one call: POST /v1/channels/{id}/calls writes it and DELETE /v1/calls/{call_id} ends
-- it. call_id is the call group's own call id (R9: mls_groups.call_id), so the next call of the
-- same call group reopens the row rather than adding one. group_id is the call group the
-- LiveKit token was gated on; it carries no foreign key, so a closed or re-created group leaves
-- the call's history readable. ended is NULL while the call is live; invariant 11's restore ends
-- every live row.
CREATE TABLE voice_sessions (
  call_id      BLOB    NOT NULL CHECK (length(call_id) = 16) PRIMARY KEY,
  channel_id   BLOB    NOT NULL CHECK (length(channel_id) = 16)
                       REFERENCES channels(id) ON DELETE CASCADE,
  group_id     BLOB    CHECK (group_id IS NULL OR length(group_id) = 16),
  livekit_room TEXT    NOT NULL,
  started      INTEGER NOT NULL,
  ended        INTEGER
) STRICT;
CREATE INDEX voice_sessions_live ON voice_sessions(channel_id) WHERE ended IS NULL;
