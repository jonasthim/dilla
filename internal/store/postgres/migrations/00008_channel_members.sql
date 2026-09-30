-- +goose Up
-- The body of this section is internal/store/postgres/schema/006d_channel_members.sql, verbatim.
-- internal/store/schema_test.go asserts that, because sqlc reads the schema directory and
-- goose reads this file: if they drift, sqlc generates against a schema the database does
-- not have.

-- 006d_channel_members.sql: the SQLite file with interfaces.md §4.2's substitutions (BLOB ->
-- BYTEA with octet_length, INTEGER -> BIGINT, no STRICT suffix), migration
-- 00008_channel_members.sql. A file of its own for the reason the SQLite twin gives.
--
-- One row is one user's membership of one channel. For a DM or group DM it is the participant
-- list, the only place that list is stored; for a community channel it is the set the permission
-- resolver derives (task 7). added is the unix second the row was written.
CREATE TABLE channel_members (
  channel_id BYTEA  NOT NULL CHECK (octet_length(channel_id) = 16)
                    REFERENCES channels(id) ON DELETE CASCADE,
  user_id    BYTEA  NOT NULL CHECK (octet_length(user_id) = 16)
                    REFERENCES users(id) ON DELETE CASCADE,
  added      BIGINT NOT NULL,
  PRIMARY KEY (channel_id, user_id)
);
CREATE INDEX channel_members_by_user ON channel_members(user_id, channel_id);

-- The body below is internal/store/postgres/schema/006e_pending_joins.sql, verbatim: Plan 1
-- follow-up card 8's table, which Plan 2 task 7 lands in this migration (see that file).

-- 006e_pending_joins.sql: the SQLite file with interfaces.md §4.2's substitutions (BLOB ->
-- BYTEA with octet_length, INTEGER -> BIGINT, no STRICT suffix), inside migration
-- 00008_channel_members.sql for the reason the SQLite twin gives.
--
-- One row is one device waiting to be added to one group by a delivery-service Add: the tail of
-- a join storm beyond the 256 Adds one commit may carry (protocol/01 § Joining). The delivery
-- service takes the next slice after each commit, oldest first, ties broken by device id.
-- device_id carries no foreign key: a device revoked or deleted while it waits is dropped by the
-- eligibility check the drain runs, and a batch naming an unknown device must not fail the rows
-- beside it. queued is the unix second the device was first queued; a re-queue keeps it.
CREATE TABLE pending_joins (
  group_id  BYTEA  NOT NULL CHECK (octet_length(group_id) = 16)
                   REFERENCES mls_groups(group_id) ON DELETE CASCADE,
  device_id BYTEA  NOT NULL CHECK (octet_length(device_id) = 16),
  queued    BIGINT NOT NULL,
  PRIMARY KEY (group_id, device_id)
);
CREATE INDEX pending_joins_by_age ON pending_joins(group_id, queued, device_id);

-- +goose Down
DROP TABLE pending_joins;
DROP TABLE channel_members;
