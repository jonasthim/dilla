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
DELETE FROM mls_app_messages WHERE group_id = $1 AND seq < $2 AND created < $3;

-- name: PutCursor :exec
INSERT INTO device_cursors (device_id, group_id, last_seq, last_epoch, updated)
VALUES ($1, $2, $3, $4, $5)
ON CONFLICT (device_id, group_id) DO UPDATE
SET last_seq = excluded.last_seq, last_epoch = excluded.last_epoch, updated = excluded.updated;

-- name: GetCursor :one
SELECT * FROM device_cursors WHERE device_id = $1 AND group_id = $2;

-- name: MinCursor :one
SELECT COALESCE(MIN(last_seq), 0)::bigint AS min_seq FROM device_cursors
WHERE group_id = $1 AND updated >= $2;
