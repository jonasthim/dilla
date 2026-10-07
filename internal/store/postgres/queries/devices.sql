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

-- name: ListDeviceListsAfter :many
-- dilla-web-2a (L-SQL-21, L-HTTP-56): the history a client walks from the version it holds.
SELECT * FROM device_lists
WHERE user_id = sqlc.arg(user_id) AND version > sqlc.arg(after)
ORDER BY version
LIMIT sqlc.arg(max_rows)::bigint;

-- name: CountLiveDevicesByUser :one
-- dilla-web-2a (L-SQL-21, Q04): the per-user device cap counts unrevoked devices only.
SELECT COUNT(*) FROM devices WHERE user_id = $1 AND revoked_at IS NULL;

-- name: ListDeviceCreationsSince :many
-- dilla-web-2a (L-SQL-21, Q04): the enrolment rate counts every enrolment, revoked devices
-- included, so enrol-revoke-enrol inside the hour still counts twice.
SELECT created FROM devices
WHERE user_id = sqlc.arg(user_id) AND created >= sqlc.arg(since)
ORDER BY created;

-- name: LockUserForDeviceRegistration :one
-- The row lock serializes count and insert for one user until Tx commits.
SELECT id FROM users WHERE id = $1 FOR UPDATE;
