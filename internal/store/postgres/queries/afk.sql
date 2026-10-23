-- name: GetCommunityAFK :one
SELECT channel_id, timeout_seconds FROM community_afk WHERE community_id = $1;

-- name: SetCommunityAFK :exec
INSERT INTO community_afk (community_id, channel_id, timeout_seconds)
VALUES ($1, $2, $3)
ON CONFLICT (community_id) DO UPDATE SET channel_id = excluded.channel_id, timeout_seconds = excluded.timeout_seconds;

-- name: SetAFKAway :execrows
INSERT INTO community_afk_away (community_id, user_id, since)
VALUES ($1, $2, $3)
ON CONFLICT (community_id, user_id) DO NOTHING;

-- name: ClearAFKAway :execrows
DELETE FROM community_afk_away WHERE community_id = $1 AND user_id = $2;

-- name: ClearAFKAwayUser :many
DELETE FROM community_afk_away WHERE user_id = $1 RETURNING community_id;

-- name: ListAFKAway :many
SELECT user_id, since FROM community_afk_away WHERE community_id = $1 ORDER BY user_id;

-- name: ListAFKAwayFirst :many
SELECT user_id, since FROM community_afk_away WHERE community_id = $1 ORDER BY user_id LIMIT sqlc.arg(max_rows)::bigint;

-- name: AFKAwayExists :one
SELECT COUNT(*) FROM (SELECT 1 FROM community_afk_away WHERE community_id = $1 AND user_id = $2 LIMIT 1) AS t;

-- name: AFKAwayExistsUser :one
SELECT COUNT(*) FROM (SELECT 1 FROM community_afk_away WHERE user_id = $1 LIMIT 1) AS t;
