-- Blobs, blob references and tombstones (Plan 2 task 10, 00010_blobs.sql). Every column in a
-- statement with a subquery is qualified: sqlc's analyser calls a bare blob_id ambiguous as soon
-- as a second table is in scope (gap-47 section 19.4, C11).

-- name: PutBlob :exec
-- Content addressing makes a second insert of the same id the same object, so it is a no-op
-- rather than a conflict: two uploads of the same bytes may race to here.
INSERT INTO blobs (blob_id, size, storage_ref, created, unref_since)
VALUES ($1, $2, $3, $4, $5)
ON CONFLICT (blob_id) DO NOTHING;

-- name: GetBlob :one
SELECT blob_id, size, storage_ref, created, unref_since FROM blobs WHERE blob_id = $1;

-- name: PutBlobRef :exec
-- One reference per (blob, channel); a repeat keeps the first uploader.
INSERT INTO blob_refs (blob_id, channel_id, uploader_device, mime, created)
VALUES ($1, $2, $3, $4, $5)
ON CONFLICT (blob_id, channel_id) DO NOTHING;

-- name: GetBlobRef :one
SELECT blob_id, channel_id, uploader_device, mime, created
FROM blob_refs WHERE blob_id = $1 AND channel_id = $2;

-- name: DeleteBlobRef :exec
DELETE FROM blob_refs WHERE blob_id = $1 AND channel_id = $2;

-- name: CountBlobRefs :one
SELECT COUNT(*) FROM blob_refs WHERE blob_id = $1;

-- name: MarkBlobUnreferenced :exec
-- Sets the mark only when no reference is left, and only when it is not already set, so a
-- repeated delete cannot push collection back.
UPDATE blobs SET unref_since = sqlc.arg(at)
WHERE blobs.blob_id = sqlc.arg(blob_id)
  AND blobs.unref_since IS NULL
  AND NOT EXISTS (SELECT 1 FROM blob_refs WHERE blob_refs.blob_id = blobs.blob_id);

-- name: ClearBlobUnreferenced :exec
UPDATE blobs SET unref_since = NULL WHERE blobs.blob_id = $1;

-- name: ListCollectableBlobs :many
SELECT blobs.blob_id, blobs.size, blobs.storage_ref, blobs.created, blobs.unref_since FROM blobs
WHERE blobs.unref_since IS NOT NULL AND blobs.unref_since < sqlc.arg(before)::bigint
  AND NOT EXISTS (SELECT 1 FROM blob_refs WHERE blob_refs.blob_id = blobs.blob_id)
ORDER BY blobs.unref_since
LIMIT sqlc.arg(max_rows)::bigint;

-- name: DeleteBlob :execrows
DELETE FROM blobs WHERE blob_id = $1;

-- name: PutBlobTombstone :exec
-- The first purge's record stands.
INSERT INTO blob_tombstones (blob_id, reason, by_user, created)
VALUES ($1, $2, $3, $4)
ON CONFLICT (blob_id) DO NOTHING;

-- name: GetBlobTombstone :one
-- COUNT, not EXISTS: EXISTS is int64 on SQLite and bool on Postgres, and the two Querier
-- interfaces must stay identical.
SELECT COUNT(*) FROM blob_tombstones WHERE blob_id = $1;

-- name: UserBlobBytes :one
-- The quota counts each distinct blob a user uploaded once, however many
-- channels they published it into. SUM over BIGINT is NUMERIC on Postgres; the
-- cast keeps it int64 like the SQLite twin.
SELECT CAST(COALESCE(SUM(b.size), 0) AS BIGINT) FROM blobs b
WHERE b.blob_id IN (
  SELECT DISTINCT r.blob_id FROM blob_refs r
  JOIN devices d ON d.id = r.uploader_device
  WHERE d.user_id = sqlc.arg(user_id)
);

-- name: DeleteAllBlobRefs :execrows
-- P2-D18 (Plan 2 task 11): the admin purge removes every reference to the blob, in every
-- channel, in one statement.
DELETE FROM blob_refs WHERE blob_id = $1;

-- name: ListBlobRetentionPolicies :many
-- Plan 2 task 11, R28: the policy of every live community that still holds a reference in a
-- live channel, so the sweeper parses one policy per community rather than one per reference.
SELECT communities.id, communities.policy_json FROM communities
WHERE communities.deleted_at IS NULL
  AND EXISTS (
    SELECT 1 FROM channels JOIN blob_refs ON blob_refs.channel_id = channels.id
    WHERE channels.community_id = communities.id AND channels.deleted_at IS NULL
  )
ORDER BY communities.id;

-- name: ListExpiredBlobRefs :many
-- A community's references created strictly before the retention cutoff, oldest first.
SELECT blob_refs.blob_id, blob_refs.channel_id, blob_refs.uploader_device, blob_refs.mime,
       blob_refs.created
FROM blob_refs
JOIN channels ON channels.id = blob_refs.channel_id
JOIN communities ON communities.id = channels.community_id
WHERE communities.id = sqlc.arg(community_id)
  AND blob_refs.created < sqlc.arg(before)::bigint
ORDER BY blob_refs.created, blob_refs.channel_id, blob_refs.blob_id
LIMIT sqlc.arg(max_rows)::bigint;

-- name: ListBlobRefsOfDeletedChannels :many
-- Channels are tombstoned, never removed, so the ON DELETE CASCADE on blob_refs never fires:
-- the sweeper drops a deleted channel's references itself.
SELECT blob_refs.blob_id, blob_refs.channel_id, blob_refs.uploader_device, blob_refs.mime,
       blob_refs.created
FROM blob_refs
JOIN channels ON channels.id = blob_refs.channel_id
WHERE channels.deleted_at IS NOT NULL
ORDER BY blob_refs.created, blob_refs.channel_id, blob_refs.blob_id
LIMIT sqlc.arg(max_rows)::bigint;

-- name: PutBackup :exec
-- One row per (user, kind, device, chunk); a re-upload of the same chunk replaces it.
INSERT INTO backups (user_id, kind, device_id, chunk_seq, blob_id, manifest_sig, created)
VALUES ($1, $2, $3, $4, $5, $6, $7)
ON CONFLICT (user_id, kind, device_id, chunk_seq) DO UPDATE SET
  blob_id = excluded.blob_id, manifest_sig = excluded.manifest_sig, created = excluded.created;

-- name: ListBackups :many
SELECT user_id, kind, device_id, chunk_seq, blob_id, manifest_sig, created
FROM backups WHERE user_id = $1 AND kind = $2
ORDER BY device_id, chunk_seq;
