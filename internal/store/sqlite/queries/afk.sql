-- name: GetCommunityAFK :one
SELECT channel_id, timeout_seconds FROM community_afk WHERE community_id = ?;

-- name: SetCommunityAFK :exec
INSERT INTO community_afk (community_id, channel_id, timeout_seconds)
VALUES (?, ?, ?)
ON CONFLICT (community_id) DO UPDATE SET channel_id = excluded.channel_id, timeout_seconds = excluded.timeout_seconds;
