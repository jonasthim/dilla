-- 006f_voice.sql: the SQLite file with interfaces.md §4.2's substitutions (BLOB -> BYTEA with
-- octet_length, INTEGER -> BIGINT, no STRICT suffix), migration 00011_voice.sql. A file of its
-- own for the reason the SQLite twin gives.
--
-- One row is one call: POST /v1/channels/{id}/calls writes it and DELETE /v1/calls/{call_id} ends
-- it. call_id is the call group's own call id (R9: mls_groups.call_id), so the next call of the
-- same call group reopens the row rather than adding one. group_id is the call group the
-- LiveKit token was gated on; it carries no foreign key, so a closed or re-created group leaves
-- the call's history readable. ended is NULL while the call is live; invariant 11's restore ends
-- every live row.
CREATE TABLE voice_sessions (
  call_id      BYTEA  NOT NULL CHECK (octet_length(call_id) = 16) PRIMARY KEY,
  channel_id   BYTEA  NOT NULL CHECK (octet_length(channel_id) = 16)
                      REFERENCES channels(id) ON DELETE CASCADE,
  group_id     BYTEA  CHECK (group_id IS NULL OR octet_length(group_id) = 16),
  livekit_room TEXT   NOT NULL,
  started      BIGINT NOT NULL,
  ended        BIGINT
);
CREATE INDEX voice_sessions_live ON voice_sessions(channel_id) WHERE ended IS NULL;
