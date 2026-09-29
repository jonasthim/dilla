-- name: CreateSession :exec
INSERT INTO sessions (token_hash, device_id, user_id, scope, tier, created, expires, idle_expires)
VALUES (?, ?, ?, ?, ?, ?, ?, ?);

-- name: GetSessionByHash :one
SELECT * FROM sessions WHERE token_hash = ? AND expires > ? AND idle_expires > ?;

-- name: TouchSession :exec
UPDATE sessions SET idle_expires = ? WHERE token_hash = ?;

-- name: DeleteSession :exec
DELETE FROM sessions WHERE token_hash = ?;

-- name: DeleteSessionsByDevice :execrows
DELETE FROM sessions WHERE device_id = ?;

-- name: DeleteSessionsByUser :execrows
DELETE FROM sessions WHERE user_id = ?;

-- name: CountSessionsByDevice :one
SELECT count(*) FROM sessions WHERE device_id = ?;

-- name: DeleteOldestSessionForDevice :exec
DELETE FROM sessions WHERE token_hash = (
  SELECT s.token_hash FROM sessions s WHERE s.device_id = ? ORDER BY s.created LIMIT 1
);

-- name: PruneSessions :execrows
DELETE FROM sessions WHERE expires <= ? OR idle_expires <= ?;
