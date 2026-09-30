-- name: CreateCommunity :exec
INSERT INTO communities (id, owner, name, icon_blob, policy_json, policy_version,
                         min_account_age_seconds, require_mod_2fa, created, deleted_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?);

-- name: GetCommunity :one
SELECT id, owner, name, icon_blob, policy_json, policy_version,
       min_account_age_seconds, require_mod_2fa, created, deleted_at
FROM communities
WHERE id = ? AND deleted_at IS NULL;

-- name: UpdateCommunityPolicy :execrows
-- The version is MONOTONE: two writers that read the same version both compute
-- the same successor, and the second must not land a different policy under a
-- number clients already hold. Zero rows is either an unknown community or a
-- lost race; the adapter tells the two apart.
UPDATE communities
SET policy_json = sqlc.arg(policy_json), policy_version = sqlc.arg(policy_version)
WHERE id = sqlc.arg(id) AND deleted_at IS NULL
  AND policy_version < CAST(sqlc.arg(policy_version) AS INTEGER);

-- name: UpdateCommunityMeta :execrows
UPDATE communities
SET name = ?, min_account_age_seconds = ?, require_mod_2fa = ?
WHERE id = ? AND deleted_at IS NULL;

-- name: SoftDeleteCommunity :execrows
UPDATE communities SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL;

-- name: PutMember :exec
INSERT INTO members (community_id, user_id, joined, nick)
VALUES (?, ?, ?, ?)
ON CONFLICT (community_id, user_id) DO UPDATE SET nick = excluded.nick;

-- name: DeleteMember :execrows
DELETE FROM members WHERE community_id = ? AND user_id = ?;

-- name: GetMember :one
SELECT community_id, user_id, joined, nick
FROM members WHERE community_id = ? AND user_id = ?;

-- name: ListMembersOfCommunity :many
SELECT community_id, user_id, joined, nick
FROM members
WHERE community_id = ? AND user_id > ?
ORDER BY user_id
LIMIT sqlc.arg(max_rows);

-- name: PutRole :exec
INSERT INTO roles (id, community_id, name, color, position, allow, deny, hoist, mentionable, created)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT (id) DO UPDATE SET
  name = excluded.name, color = excluded.color, position = excluded.position,
  allow = excluded.allow, deny = excluded.deny, hoist = excluded.hoist,
  mentionable = excluded.mentionable;

-- name: GetRole :one
SELECT id, community_id, name, color, position, allow, deny, hoist, mentionable, created
FROM roles WHERE id = ?;

-- name: ListRoles :many
SELECT id, community_id, name, color, position, allow, deny, hoist, mentionable, created
FROM roles WHERE community_id = ? ORDER BY position, id;

-- name: PutMemberRole :exec
INSERT INTO member_roles (community_id, user_id, role_id)
VALUES (?, ?, ?)
ON CONFLICT (community_id, user_id, role_id) DO NOTHING;

-- name: DeleteMemberRole :execrows
DELETE FROM member_roles WHERE community_id = ? AND user_id = ? AND role_id = ?;

-- name: ListMemberRoles :many
SELECT role_id FROM member_roles WHERE community_id = ? AND user_id = ? ORDER BY role_id;

-- Channels (Plan 2 task 2, 00005_channels.sql).

-- name: CreateChannel :exec
INSERT INTO channels (id, community_id, kind, mode, visibility, parent_id, name, topic,
                      position, settings_json, host_policy_version, slowmode_seconds,
                      seq, created, deleted_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);

-- name: GetChannel :one
SELECT id, community_id, kind, mode, visibility, parent_id, name, topic, position,
       settings_json, host_policy_version, slowmode_seconds, seq, created, deleted_at
FROM channels WHERE id = ? AND deleted_at IS NULL;

-- name: ListChannels :many
SELECT id, community_id, kind, mode, visibility, parent_id, name, topic, position,
       settings_json, host_policy_version, slowmode_seconds, seq, created, deleted_at
FROM channels
WHERE community_id = ? AND deleted_at IS NULL
ORDER BY position, id;

-- name: UpdateChannel :execrows
-- kind, community_id, seq and created are not written: a channel's kind and home
-- are immutable, and seq moves only through NextChannelSeq.
UPDATE channels
SET mode = ?, visibility = ?, parent_id = ?, name = ?, topic = ?, position = ?,
    settings_json = ?, host_policy_version = ?, slowmode_seconds = ?
WHERE id = ? AND deleted_at IS NULL;

-- name: DeleteChannel :execrows
UPDATE channels SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL;

-- name: DeleteChannelsOfCommunity :execrows
UPDATE channels SET deleted_at = ? WHERE community_id = ? AND deleted_at IS NULL;

-- name: NextChannelSeq :one
UPDATE channels SET seq = seq + 1 WHERE id = ? AND deleted_at IS NULL RETURNING seq;
