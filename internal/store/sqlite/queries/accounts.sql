-- name: CreateUser :exec
INSERT INTO users (id, username, display, kind, umk_pub, ssk_pub, sig_umk_ssk, flags, age_bracket, created, disabled_at, deleted_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);

-- name: GetUser :one
SELECT * FROM users WHERE id = ?;

-- name: GetUserByUsername :one
SELECT * FROM users WHERE username = ?;

-- name: ListUsers :many
SELECT * FROM users WHERE id > ? ORDER BY id LIMIT sqlc.arg(max_rows);

-- name: SetUserDisabled :exec
UPDATE users SET disabled_at = ? WHERE id = ?;

-- name: TombstoneUser :exec
UPDATE users SET deleted_at = ?, display = '', umk_pub = zeroblob(32), ssk_pub = zeroblob(32),
                 sig_umk_ssk = zeroblob(64), flags = 0
WHERE id = ?;
