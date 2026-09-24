-- name: CreateDevice :exec
INSERT INTO devices (id, user_id, dsk_pub, tier, signer_tier, credential_blob, verified_at, revoked_at, quarantined_at, quarantine_reason, last_seen, created)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12);

-- name: GetDevice :one
SELECT * FROM devices WHERE id = $1;

-- name: ListDevicesByUser :many
SELECT * FROM devices WHERE user_id = $1 ORDER BY created;

-- name: TouchDevice :exec
UPDATE devices SET last_seen = $1 WHERE id = $2;

-- name: RevokeDevice :exec
UPDATE devices SET revoked_at = $1 WHERE id = $2;

-- name: PutDeviceList :exec
INSERT INTO device_lists (user_id, version, blob, ssk_signature, prev_hash, created)
VALUES ($1, $2, $3, $4, $5, $6);

-- name: GetDeviceList :one
SELECT * FROM device_lists WHERE user_id = $1 ORDER BY version DESC LIMIT 1;
