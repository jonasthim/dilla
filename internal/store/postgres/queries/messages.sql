-- name: PutAppMessage :exec
INSERT INTO mls_app_messages (group_id, seq, epoch, uploader_device, blob, commitment_c,
                              franking_tag, size, created, expires, deleted_at)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11);

-- name: ListAppMessages :many
SELECT * FROM mls_app_messages WHERE group_id = $1 AND seq >= $2
ORDER BY seq LIMIT sqlc.arg(max_rows)::bigint;

-- name: GetAppMessage :one
SELECT * FROM mls_app_messages WHERE group_id = $1 AND seq = $2;

-- name: TombstoneAppMessage :exec
UPDATE mls_app_messages SET blob = NULL, deleted_at = $1
WHERE group_id = $2 AND seq = $3 AND deleted_at IS NULL;

-- name: PruneAppMessages :execrows
-- Invariant 10 has TWO independent deletion triggers (R28/D14); a row goes when EITHER fires.
--   (1) DELIVERY retention: every ELIGIBLE cursor has passed the row (cursor_floor), or the row
--       is older than MessageRetention (delivery_floor). cursor_floor = 0 means "no eligible
--       device has acknowledged anything in this group", which must delete NOTHING rather than
--       everything -- hence the guard. `seq` is 1-based, so `seq <= 0` already matches nothing
--       and the guard is belt-and-braces: it is kept because it states the rule where the rule
--       is enforced, and because it stops a future 0-based or signed cursor from emptying a
--       group silently.
--   (2) ARCHIVAL retention: `expires` is a wall-clock deadline compared against NOW, never
--       against the delivery floor. NULL -- the value Upload writes -- means retained
--       indefinitely, and this half never touches such a row.
DELETE FROM mls_app_messages
 WHERE group_id = sqlc.arg(group_id)
   AND ((sqlc.arg(cursor_floor)::bigint > 0 AND seq <= sqlc.arg(cursor_floor)::bigint)
        OR created < sqlc.arg(delivery_floor)::bigint
        OR (expires IS NOT NULL AND expires <= sqlc.arg(now)::bigint));

-- name: MaxPrunableAppMessageSeq :one
-- The highest seq PruneAppMessages' DELIVERY triggers are about to delete with the same arguments,
-- or 0. The store runs it in PruneAppMessages' transaction and raises pruned_below to it before the
-- DELETE, so the high-water records exactly what delivery retention took.
--
-- The archival trigger is deliberately NOT in this predicate (Plan 2 task 8's retention ruling):
-- `expires` is not monotone in seq -- a community that shortens its retention makes newer messages
-- expire before older ones -- so a mark raised to the highest expired seq would stand above
-- messages that still exist, and the catch-up would answer E_PRUNED for a range it can serve. An
-- archival deletion removes the row for every device alike; it never moves the mark.
SELECT CAST(COALESCE(MAX(seq), 0) AS BIGINT) AS max_seq FROM mls_app_messages
 WHERE group_id = sqlc.arg(group_id)
   AND ((sqlc.arg(cursor_floor)::bigint > 0 AND seq <= sqlc.arg(cursor_floor)::bigint)
        OR created < sqlc.arg(delivery_floor)::bigint);

-- name: RaisePrunedBelow :exec
-- The record of what the DELIVERY-CURSOR trigger above actually deleted at, kept on the group
-- because nothing can recompute it afterwards: `MinCursor` aggregates rows that move, and a device
-- has no cursor row at all until its first POST /cursor. The catch-up predicate reads this column,
-- never a freshly recomputed floor.
--
-- MONOTONE by the `<`: a later sweep whose eligible cursors have gone (every one revoked, disabled
-- or 90 days idle, so the floor falls back to 0) must not walk the high-water back down and
-- un-say a deletion that happened.
UPDATE mls_groups
   SET pruned_below = sqlc.arg(pruned_below)::bigint
 WHERE group_id = sqlc.arg(group_id)
   AND pruned_below < sqlc.arg(pruned_below)::bigint;

-- name: PutCursor :exec
INSERT INTO device_cursors (device_id, group_id, last_seq, last_epoch, updated)
VALUES ($1, $2, $3, $4, $5)
ON CONFLICT (device_id, group_id) DO UPDATE
SET last_seq = excluded.last_seq, last_epoch = excluded.last_epoch, updated = excluded.updated;

-- name: GetCursor :one
SELECT * FROM device_cursors WHERE device_id = $1 AND group_id = $2;

-- name: MinCursor :one
-- The retention floor: the lowest seq an ELIGIBLE device has acknowledged in this group, or 0
-- when no eligible cursor exists. A device is ineligible when it is revoked, when its user is
-- disabled, or when its cursor has not moved since `updated` (the 90-day inactivity horizon) --
-- one abandoned phone must not pin a community's storage forever.
--
-- The two joins are LEFT joins on purpose: a cursor whose `devices` or `users` row is missing
-- counts as eligible and so HOLDS the floor, which is the conservative direction. Holding costs
-- storage; dropping costs ciphertext a device never received.
SELECT COALESCE(MIN(c.last_seq), 0)::bigint AS min_seq
FROM device_cursors c
LEFT JOIN devices d ON d.id = c.device_id
LEFT JOIN users u ON u.id = d.user_id
WHERE c.group_id = $1 AND c.updated >= $2
  AND d.revoked_at IS NULL
  AND u.disabled_at IS NULL;
