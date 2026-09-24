-- name: CreateSession :exec
INSERT INTO sessions (token_hash, device_id, user_id, scope, tier, created, expires, idle_expires)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8);

-- name: GetSessionByHash :one
SELECT * FROM sessions WHERE token_hash = $1 AND expires > $2 AND idle_expires > $3;

-- name: TouchSession :exec
UPDATE sessions SET idle_expires = $1 WHERE token_hash = $2;

-- name: DeleteSession :exec
DELETE FROM sessions WHERE token_hash = $1;

-- name: DeleteSessionsByDevice :execrows
DELETE FROM sessions WHERE device_id = $1;

-- name: DeleteSessionsByUser :execrows
DELETE FROM sessions WHERE user_id = $1;

-- name: CountSessionsByDevice :one
SELECT count(*) FROM sessions WHERE device_id = $1;

-- name: DeleteOldestSessionForDevice :exec
DELETE FROM sessions WHERE token_hash = (
  SELECT s.token_hash FROM sessions s WHERE s.device_id = $1 ORDER BY s.created LIMIT 1
);

-- name: PruneSessions :execrows
DELETE FROM sessions WHERE expires <= $1 OR idle_expires <= $2;
