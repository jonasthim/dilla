-- 006e_pending_joins.sql: pending_joins (Plan 1 follow-up card 8, deviation B22 / ruling 43,
-- taken by Plan 2 task 7). It lands inside migration 00008_channel_members.sql rather than in a
-- number of its own: Plan 2's migration numbers are fixed per task (00009 onward belong to tasks
-- 8, 10, 16 and 17), and 00008 is task 6's and has not left this branch, so no deployed database has
-- applied it without this table. The name sorts after 004_mls.sql, so sqlc reads mls_groups
-- before the table that references it.
--
-- One row is one device waiting to be added to one group by a delivery-service Add: the tail of
-- a join storm beyond the 256 Adds one commit may carry (protocol/01 § Joining). The delivery
-- service takes the next slice after each commit, oldest first, ties broken by device id.
-- device_id carries no foreign key: a device revoked or deleted while it waits is dropped by the
-- eligibility check the drain runs, and a batch naming an unknown device must not fail the rows
-- beside it. queued is the unix second the device was first queued; a re-queue keeps it.
CREATE TABLE pending_joins (
  group_id  BLOB    NOT NULL CHECK (length(group_id) = 16)
                    REFERENCES mls_groups(group_id) ON DELETE CASCADE,
  device_id BLOB    NOT NULL CHECK (length(device_id) = 16),
  queued    INTEGER NOT NULL,
  PRIMARY KEY (group_id, device_id)
) STRICT;
CREATE INDEX pending_joins_by_age ON pending_joins(group_id, queued, device_id);
