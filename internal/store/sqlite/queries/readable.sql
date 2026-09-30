-- Server-readable channels (Plan 2 task 8, 00009_readable.sql). Search is NOT here: sqlc can type
-- neither the FTS5 MATCH (a virtual table is not a value to it) nor the implicit rowid, so
-- SearchReadable is hand-written database/sql in search.go (gap-69 section 5.1).
--
-- Every read names its columns: the Postgres table carries body_tsv, which no query selects, and
-- the two engines' Querier interfaces must stay identical (schema_test.go).

-- name: PutReadableMessage :one
INSERT INTO readable_messages (channel_id, channel_hex, seq, sender, envelope, body, franking_tag,
                               franking_key_id, mention_count, created, edited, deleted)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
RETURNING id;

-- name: ListReadableMessages :many
SELECT id, channel_id, channel_hex, seq, sender, envelope, body, franking_tag, franking_key_id,
       mention_count, created, edited, deleted
FROM readable_messages
WHERE channel_id = ? AND seq >= ?
ORDER BY seq LIMIT sqlc.arg(max_rows);

-- name: EditReadableMessage :execrows
-- A deleted message is not edited: its envelope and body are gone for good.
UPDATE readable_messages SET envelope = ?, body = ?, edited = ?
WHERE channel_id = ? AND seq = ? AND deleted IS NULL;

-- name: DeleteReadableMessage :execrows
-- A zero-length envelope, not an empty CBOR array: the column holds CBOR and a delete leaves none.
-- The body is emptied so the row leaves the FTS index through the _au trigger, while the franking
-- tuple (franking_tag, franking_key_id, sender, created) survives for the report path.
UPDATE readable_messages SET envelope = x'', body = '', deleted = ?
WHERE channel_id = ? AND seq = ? AND deleted IS NULL;

-- name: LastReadableMessageAt :one
-- The slowmode gate's read. A deleted message still counts: deleting the last message must not
-- reset the gate, or delete-and-repost would bypass slowmode.
SELECT created FROM readable_messages
WHERE channel_id = ? AND sender = ?
ORDER BY created DESC LIMIT 1;

-- name: ListReadableAudience :many
-- Who message.plain reaches: the channel's materialised members (task 7's channel_members, which
-- holds exactly the users the resolver grants view_channel) who are still members of its
-- community, so a kicked, banned or departed user drops out before any re-materialisation.
SELECT cm.user_id
FROM channel_members cm
JOIN channels c ON c.id = cm.channel_id
JOIN members m ON m.community_id = c.community_id AND m.user_id = cm.user_id
WHERE cm.channel_id = ? AND c.deleted_at IS NULL
ORDER BY cm.user_id;

-- name: PutReadState :exec
-- Monotone: a stale tab that reports an older position must not un-read the channel.
INSERT INTO read_state (user_id, channel_id, last_read_seq) VALUES (?, ?, ?)
ON CONFLICT (user_id, channel_id) DO UPDATE
SET last_read_seq = MAX(read_state.last_read_seq, excluded.last_read_seq);

-- name: GetReadState :one
SELECT last_read_seq FROM read_state WHERE user_id = ? AND channel_id = ?;
