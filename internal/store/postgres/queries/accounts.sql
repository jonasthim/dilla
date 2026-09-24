-- name: CreateUser :exec
INSERT INTO users (id, username, display, kind, umk_pub, ssk_pub, sig_umk_ssk, flags, age_bracket, created, disabled_at, deleted_at)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12);

-- name: GetUser :one
SELECT * FROM users WHERE id = $1;

-- name: GetUserByUsername :one
SELECT * FROM users WHERE username = $1;

-- name: ListUsers :many
SELECT * FROM users WHERE id > $1 ORDER BY id LIMIT sqlc.arg(max_rows)::bigint;

-- name: SetUserDisabled :exec
UPDATE users SET disabled_at = $1 WHERE id = $2;

-- name: TombstoneUser :exec
UPDATE users SET deleted_at = $1, display = '', umk_pub = '\x0000000000000000000000000000000000000000000000000000000000000000'::bytea, ssk_pub = '\x0000000000000000000000000000000000000000000000000000000000000000'::bytea,
                 sig_umk_ssk = '\x00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000'::bytea, flags = 0
WHERE id = $2;
