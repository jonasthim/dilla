-- name: CreateUser :exec
INSERT INTO users (id, username, display, kind, umk_pub, ssk_pub, sig_umk_ssk, flags, age_bracket, created, disabled_at, deleted_at, factor_owed)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);

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

-- name: SetFactorOwed :execrows
UPDATE users SET factor_owed = ? WHERE id = ?;

-- name: MarkFactorOwedWithoutFactor :execrows
-- The boot reconcile (web3.6 S1, ruling P2): every live human account that holds no confirmed
-- TOTP secret and no passkey registered for the instance's rp_id owes a second factor. It only
-- ever sets the flag: an account that owes one stays owed until a factor is added.
UPDATE users SET factor_owed = 1
 WHERE kind = 0 AND deleted_at IS NULL AND factor_owed = 0
   AND id NOT IN (SELECT t.user_id FROM totp_secrets t WHERE t.confirmed_at IS NOT NULL)
   AND id NOT IN (SELECT w.user_id FROM webauthn_credentials w WHERE w.rp_id = sqlc.arg(rp_id));
