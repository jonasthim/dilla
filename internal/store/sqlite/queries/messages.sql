-- name: PutAppMessage :exec
INSERT INTO mls_app_messages (group_id, seq, epoch, uploader_device, blob, commitment_c,
                              franking_tag, size, created, expires, deleted_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);

-- name: ListAppMessages :many
SELECT * FROM mls_app_messages WHERE group_id = ? AND seq >= ?
ORDER BY seq LIMIT sqlc.arg(max_rows);

-- name: GetAppMessage :one
SELECT * FROM mls_app_messages WHERE group_id = ? AND seq = ?;

-- name: TombstoneAppMessage :exec
UPDATE mls_app_messages SET blob = NULL, deleted_at = ?
WHERE group_id = ? AND seq = ? AND deleted_at IS NULL;

-- name: PruneAppMessages :execrows
DELETE FROM mls_app_messages WHERE group_id = ? AND seq < ? AND created < ?;

-- name: PutCursor :exec
INSERT INTO device_cursors (device_id, group_id, last_seq, last_epoch, updated)
VALUES (?, ?, ?, ?, ?)
ON CONFLICT (device_id, group_id) DO UPDATE
SET last_seq = excluded.last_seq, last_epoch = excluded.last_epoch, updated = excluded.updated;

-- name: GetCursor :one
SELECT * FROM device_cursors WHERE device_id = ? AND group_id = ?;

-- name: MinCursor :one
SELECT CAST(COALESCE(MIN(last_seq), 0) AS INTEGER) AS min_seq FROM device_cursors
WHERE group_id = ? AND updated >= ?;
