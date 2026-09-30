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
