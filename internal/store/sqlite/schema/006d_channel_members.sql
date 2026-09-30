-- 006d_channel_members.sql: channel_members (Plan 2 task 6), migration
-- 00008_channel_members.sql. A file of its own for the reason 006a_channels.sql gives: every
-- schema file appears verbatim inside exactly one migration. The name sorts after
-- 006a_channels.sql, so sqlc reads channels before the table that references it.
--
-- One row is one user's membership of one channel. For a DM or group DM it is the participant
-- list, the only place that list is stored; for a community channel it is the set the permission
-- resolver derives (task 7). added is the unix second the row was written.
CREATE TABLE channel_members (
  channel_id BLOB    NOT NULL CHECK (length(channel_id) = 16)
                     REFERENCES channels(id) ON DELETE CASCADE,
  user_id    BLOB    NOT NULL CHECK (length(user_id) = 16)
                     REFERENCES users(id) ON DELETE CASCADE,
  added      INTEGER NOT NULL,
  PRIMARY KEY (channel_id, user_id)
) STRICT;
CREATE INDEX channel_members_by_user ON channel_members(user_id, channel_id);
