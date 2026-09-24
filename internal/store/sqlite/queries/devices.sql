-- name: CreateDevice :exec
INSERT INTO devices (id, user_id, dsk_pub, tier, signer_tier, credential_blob, verified_at, revoked_at, quarantined_at, quarantine_reason, last_seen, created)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);

-- name: GetDevice :one
SELECT * FROM devices WHERE id = ?;

-- name: ListDevicesByUser :many
SELECT * FROM devices WHERE user_id = ? ORDER BY created;

-- name: TouchDevice :exec
UPDATE devices SET last_seen = ? WHERE id = ?;

-- name: RevokeDevice :exec
UPDATE devices SET revoked_at = ? WHERE id = ?;

-- name: PutDeviceList :exec
INSERT INTO device_lists (user_id, version, blob, ssk_signature, prev_hash, created)
VALUES (?, ?, ?, ?, ?, ?);

-- name: GetDeviceList :one
SELECT * FROM device_lists WHERE user_id = ? ORDER BY version DESC LIMIT 1;
