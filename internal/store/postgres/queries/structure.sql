-- name: CreateCommunity :exec
INSERT INTO communities (id, owner, name, icon_blob, policy_json, policy_version,
                         min_account_age_seconds, require_mod_2fa, created, deleted_at)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10);

-- name: GetCommunity :one
SELECT id, owner, name, icon_blob, policy_json, policy_version,
       min_account_age_seconds, require_mod_2fa, created, deleted_at
FROM communities
WHERE id = $1 AND deleted_at IS NULL;

-- name: UpdateCommunityPolicy :execrows
-- The version is MONOTONE: two writers that read the same version both compute
-- the same successor, and the second must not land a different policy under a
-- number clients already hold. Zero rows is either an unknown community or a
-- lost race; the adapter tells the two apart.
UPDATE communities
SET policy_json = sqlc.arg(policy_json), policy_version = sqlc.arg(policy_version)
WHERE id = sqlc.arg(id) AND deleted_at IS NULL
  AND policy_version < sqlc.arg(policy_version)::bigint;

-- name: UpdateCommunityMeta :execrows
UPDATE communities
SET name = $1, min_account_age_seconds = $2, require_mod_2fa = $3
WHERE id = $4 AND deleted_at IS NULL;

-- name: SoftDeleteCommunity :execrows
UPDATE communities SET deleted_at = $1 WHERE id = $2 AND deleted_at IS NULL;

-- name: LockCommunity :one
-- The join and the ban both take this lock before they read or write the
-- membership, so a join's ban check and its member insert cannot interleave with
-- a ban under READ COMMITTED. FOR NO KEY UPDATE: two lockers conflict, while the
-- FOR KEY SHARE a foreign-key check on members or channels takes does not.
SELECT id FROM communities WHERE id = $1 AND deleted_at IS NULL FOR NO KEY UPDATE;

-- name: PutMember :exec
INSERT INTO members (community_id, user_id, joined, nick)
VALUES ($1, $2, $3, $4)
ON CONFLICT (community_id, user_id) DO UPDATE SET nick = excluded.nick;

-- name: DeleteMember :execrows
DELETE FROM members WHERE community_id = $1 AND user_id = $2;

-- name: GetMember :one
SELECT community_id, user_id, joined, nick
FROM members WHERE community_id = $1 AND user_id = $2;

-- name: ListMembersOfCommunity :many
SELECT community_id, user_id, joined, nick
FROM members
WHERE community_id = $1 AND user_id > $2
ORDER BY user_id
LIMIT sqlc.arg(max_rows)::bigint;

-- name: PutRole :exec
INSERT INTO roles (id, community_id, name, color, position, allow, deny, hoist, mentionable, created)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
ON CONFLICT (id) DO UPDATE SET
  name = excluded.name, color = excluded.color, position = excluded.position,
  allow = excluded.allow, deny = excluded.deny, hoist = excluded.hoist,
  mentionable = excluded.mentionable;

-- name: GetRole :one
SELECT id, community_id, name, color, position, allow, deny, hoist, mentionable, created
FROM roles WHERE id = $1;

-- name: ListRoles :many
SELECT id, community_id, name, color, position, allow, deny, hoist, mentionable, created
FROM roles WHERE community_id = $1 ORDER BY position, id;

-- name: PutMemberRole :exec
INSERT INTO member_roles (community_id, user_id, role_id)
VALUES ($1, $2, $3)
ON CONFLICT (community_id, user_id, role_id) DO NOTHING;

-- name: DeleteMemberRole :execrows
DELETE FROM member_roles WHERE community_id = $1 AND user_id = $2 AND role_id = $3;

-- name: ListMemberRoles :many
SELECT role_id FROM member_roles WHERE community_id = $1 AND user_id = $2 ORDER BY role_id;

-- Channels (Plan 2 task 2, 00005_channels.sql).

-- name: CreateChannel :exec
INSERT INTO channels (id, community_id, kind, mode, visibility, parent_id, name, topic,
                      position, settings_json, host_policy_version, slowmode_seconds,
                      seq, created, deleted_at)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15);

-- name: GetChannel :one
SELECT id, community_id, kind, mode, visibility, parent_id, name, topic, position,
       settings_json, host_policy_version, slowmode_seconds, seq, created, deleted_at
FROM channels WHERE id = $1 AND deleted_at IS NULL;

-- name: ListChannels :many
SELECT id, community_id, kind, mode, visibility, parent_id, name, topic, position,
       settings_json, host_policy_version, slowmode_seconds, seq, created, deleted_at
FROM channels
WHERE community_id = $1 AND deleted_at IS NULL
ORDER BY position, id;

-- name: UpdateChannel :execrows
-- kind, community_id, seq and created are not written: a channel's kind and home
-- are immutable, and seq moves only through NextChannelSeq.
UPDATE channels
SET mode = $1, visibility = $2, parent_id = $3, name = $4, topic = $5, position = $6,
    settings_json = $7, host_policy_version = $8, slowmode_seconds = $9
WHERE id = $10 AND deleted_at IS NULL;

-- name: DeleteChannel :execrows
UPDATE channels SET deleted_at = $1 WHERE id = $2 AND deleted_at IS NULL;

-- name: DeleteChannelsOfCommunity :execrows
UPDATE channels SET deleted_at = $1 WHERE community_id = $2 AND deleted_at IS NULL;

-- name: NextChannelSeq :one
UPDATE channels SET seq = seq + 1 WHERE id = $1 AND deleted_at IS NULL RETURNING seq;

-- name: DeleteRole :execrows
DELETE FROM roles WHERE id = $1 AND community_id = $2;

-- Channel overwrites (Plan 2 task 3, 00006_overwrites.sql).

-- name: PutOverwrite :exec
INSERT INTO channel_overwrites (channel_id, target_kind, target_id, allow, deny)
VALUES ($1, $2, $3, $4, $5)
ON CONFLICT (channel_id, target_kind, target_id) DO UPDATE SET
  allow = excluded.allow, deny = excluded.deny;

-- name: DeleteOverwrite :execrows
DELETE FROM channel_overwrites WHERE channel_id = $1 AND target_kind = $2 AND target_id = $3;

-- name: ListOverwrites :many
SELECT channel_id, target_kind, target_id, allow, deny
FROM channel_overwrites WHERE channel_id = $1 ORDER BY target_kind, target_id;

-- Bans (Plan 2 task 4, 00007_bans.sql).

-- name: PutBan :exec
INSERT INTO bans (community_id, user_id, reason, by_user, created, expires)
VALUES ($1, $2, $3, $4, $5, $6)
ON CONFLICT (community_id, user_id) DO UPDATE SET
  reason = excluded.reason, by_user = excluded.by_user,
  created = excluded.created, expires = excluded.expires;

-- name: GetBan :one
SELECT community_id, user_id, reason, by_user, created, expires
FROM bans WHERE community_id = $1 AND user_id = $2;

-- name: ListBans :many
SELECT community_id, user_id, reason, by_user, created, expires
FROM bans WHERE community_id = $1 ORDER BY created DESC, user_id;

-- name: DeleteBan :execrows
DELETE FROM bans WHERE community_id = $1 AND user_id = $2;

-- Channel members (Plan 2 task 6, 00008_channel_members.sql).

-- name: PutChannelMember :exec
INSERT INTO channel_members (channel_id, user_id, added)
VALUES ($1, $2, $3) ON CONFLICT (channel_id, user_id) DO NOTHING;

-- name: DeleteChannelMember :execrows
DELETE FROM channel_members WHERE channel_id = $1 AND user_id = $2;

-- name: ListChannelMembers :many
SELECT user_id FROM channel_members WHERE channel_id = $1 ORDER BY user_id;

-- name: ListChannelsForUser :many
-- P2-D11: GET /v1/dms. The live DMs and group DMs (kinds 3 and 4) the user is a
-- participant of, newest first, ties broken by id.
SELECT c.id, c.community_id, c.kind, c.mode, c.visibility, c.parent_id, c.name, c.topic,
       c.position, c.settings_json, c.host_policy_version, c.slowmode_seconds, c.seq,
       c.created, c.deleted_at
FROM channels c
JOIN channel_members m ON m.channel_id = c.id
WHERE m.user_id = $1 AND c.kind IN (3, 4) AND c.deleted_at IS NULL
ORDER BY c.created DESC, c.id;
