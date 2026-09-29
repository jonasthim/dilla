-- name: CreateInvite :exec
INSERT INTO invites (id, code_hash, community_id, created_by, grants_admin, max_uses, used_count, created, expires_at, revoked_at)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10);

-- name: GetInviteByHash :one
SELECT * FROM invites WHERE code_hash = $1;

-- name: RedeemInvite :one
UPDATE invites SET used_count = used_count + 1
WHERE code_hash = $1 AND used_count < max_uses AND revoked_at IS NULL AND expires_at > $2
RETURNING *;

-- name: RevokeInvite :exec
UPDATE invites SET revoked_at = $1 WHERE id = $2;

-- name: ListInvites :many
SELECT * FROM invites ORDER BY created DESC;

-- name: ListInvitesByCommunity :many
SELECT * FROM invites WHERE community_id = $1 ORDER BY created DESC;
