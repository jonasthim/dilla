-- name: CreateInvite :exec
INSERT INTO invites (id, code_hash, community_id, created_by, grants_admin, max_uses, used_count, created, expires_at, revoked_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?);

-- name: GetInviteByHash :one
SELECT * FROM invites WHERE code_hash = ?;

-- name: RedeemInvite :one
UPDATE invites SET used_count = used_count + 1
WHERE code_hash = ? AND used_count < max_uses AND revoked_at IS NULL AND expires_at > ?
RETURNING *;

-- name: RevokeInvite :exec
UPDATE invites SET revoked_at = ? WHERE id = ?;

-- name: ListInvites :many
SELECT * FROM invites ORDER BY created DESC;

-- name: ListInvitesByCommunity :many
SELECT * FROM invites WHERE community_id = ? ORDER BY created DESC;
