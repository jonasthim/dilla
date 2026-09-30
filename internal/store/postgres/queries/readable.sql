-- Server-readable channels (Plan 2 task 8, 00009_readable.sql). Search is NOT here: it is
-- hand-written database/sql in search.go, for symmetry with SQLite, where sqlc cannot type it at
-- all (gap-69 sections 5.1 and 5.2).
--
-- Every read names its columns: body_tsv exists for the index and is never selected, and the two
-- engines' Querier interfaces must stay identical (schema_test.go).

-- name: PutReadableMessage :one
INSERT INTO readable_messages (channel_id, channel_hex, seq, sender, envelope, body, franking_tag,
                               franking_key_id, mention_count, created, edited, deleted)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
RETURNING id;

-- name: ListReadableMessages :many
SELECT id, channel_id, channel_hex, seq, sender, envelope, body, franking_tag, franking_key_id,
       mention_count, created, edited, deleted
FROM readable_messages
WHERE channel_id = $1 AND seq >= $2
ORDER BY seq LIMIT sqlc.arg(max_rows)::bigint;

-- name: EditReadableMessage :execrows
-- A deleted message is not edited: its envelope and body are gone for good.
UPDATE readable_messages SET envelope = $1, body = $2, edited = $3
WHERE channel_id = $4 AND seq = $5 AND deleted IS NULL;

-- name: DeleteReadableMessage :execrows
-- A zero-length envelope, not an empty CBOR array: the column holds CBOR and a delete leaves none.
-- The body is emptied so body_tsv recomputes to an empty tsvector and the row stops matching,
-- while the franking tuple (franking_tag, franking_key_id, sender, created) survives for the report
-- path.
UPDATE readable_messages SET envelope = ''::bytea, body = '', deleted = $1
WHERE channel_id = $2 AND seq = $3 AND deleted IS NULL;

-- name: LastReadableMessageAt :one
-- The slowmode gate's read. A deleted message still counts: deleting the last message must not
-- reset the gate, or delete-and-repost would bypass slowmode.
SELECT created FROM readable_messages
WHERE channel_id = $1 AND sender = $2
ORDER BY created DESC LIMIT 1;

-- name: ListReadableAudience :many
-- Who message.plain reaches: the channel's materialised members (task 7's channel_members, which
-- holds exactly the users the resolver grants view_channel) who are still members of its
-- community, so a kicked, banned or departed user drops out before any re-materialisation.
SELECT cm.user_id
FROM channel_members cm
JOIN channels c ON c.id = cm.channel_id
JOIN members m ON m.community_id = c.community_id AND m.user_id = cm.user_id
WHERE cm.channel_id = $1 AND c.deleted_at IS NULL
ORDER BY cm.user_id;

-- name: PutReadState :exec
-- Monotone: a stale tab that reports an older position must not un-read the channel.
INSERT INTO read_state (user_id, channel_id, last_read_seq) VALUES ($1, $2, $3)
ON CONFLICT (user_id, channel_id) DO UPDATE
SET last_read_seq = GREATEST(read_state.last_read_seq, excluded.last_read_seq);

-- name: GetReadState :one
SELECT last_read_seq FROM read_state WHERE user_id = $1 AND channel_id = $2;
