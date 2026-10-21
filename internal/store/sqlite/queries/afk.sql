-- name: GetCommunityAFK :one
SELECT channel_id, timeout_seconds FROM community_afk WHERE community_id = ?;

-- name: SetCommunityAFK :exec
INSERT INTO community_afk (community_id, channel_id, timeout_seconds)
VALUES (?, ?, ?)
ON CONFLICT (community_id) DO UPDATE SET channel_id = excluded.channel_id, timeout_seconds = excluded.timeout_seconds;

-- name: SetAFKAway :execrows
INSERT INTO community_afk_away (community_id, user_id, since)
VALUES (?, ?, ?)
ON CONFLICT (community_id, user_id) DO NOTHING;

-- name: ClearAFKAway :execrows
DELETE FROM community_afk_away WHERE community_id = ? AND user_id = ?;

-- name: ClearAFKAwayUser :many
DELETE FROM community_afk_away WHERE user_id = ? RETURNING community_id;

-- name: ListAFKAway :many
SELECT user_id, since FROM community_afk_away WHERE community_id = ? ORDER BY user_id;

-- name: ListAFKAwayFirst :many
SELECT user_id, since FROM community_afk_away WHERE community_id = ? ORDER BY user_id LIMIT sqlc.arg(max_rows);
