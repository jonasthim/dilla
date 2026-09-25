-- name: CreateGroup :exec
INSERT INTO mls_groups (group_id, binding, kind, community_id, target_id, call_id, ciphersuite,
                        epoch, seq, group_info_blob, tree_hash, public_group_state,
                        external_sender_key_id, e2ee_version, media_version, policy_version,
                        epoch_unknown, heal_deadline, created, closed_at)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20);

-- name: GetGroup :one
SELECT * FROM mls_groups WHERE group_id = $1;

-- name: ListOpenGroups :many
SELECT * FROM mls_groups WHERE closed_at IS NULL AND group_id > $1
ORDER BY group_id LIMIT sqlc.arg(max_rows)::bigint;

-- name: ListGroupsForRetention :many
-- The retention walk, and deliberately NOT `ListOpenGroups`: invariant 10 caps application
-- ciphertext at thirty days for every group, and a group invariant 11 closed is still ciphertext
-- on the disk. Filtering on `closed_at IS NULL` here would mean a closed group's blobs are never
-- swept again by either half of retention -- neither the delivery floor nor archival `expires` --
-- and no other path reclaims them, so the promise inverts into "kept forever" at exactly the
-- moment the group stops being useful.
SELECT * FROM mls_groups WHERE group_id > $1
ORDER BY group_id LIMIT sqlc.arg(max_rows)::bigint;

-- name: CloseGroup :exec
UPDATE mls_groups SET closed_at = $1 WHERE group_id = $2;

-- name: BumpGroupSeq :one
UPDATE mls_groups SET seq = seq + 1 WHERE group_id = $1 RETURNING seq;

-- name: PutGroupState :exec
UPDATE mls_groups
SET epoch = $1, public_group_state = $2, group_info_blob = $3, tree_hash = $4, epoch_unknown = 0
WHERE group_id = $5;

-- name: SetGroupHealing :exec
UPDATE mls_groups SET epoch_unknown = $1, heal_deadline = $2 WHERE group_id = $3;

-- name: AppendHandshake :exec
INSERT INTO mls_handshakes (group_id, seq, epoch, kind, sender_leaf, sender_device, blob, created)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8);

-- name: ListHandshakes :many
SELECT * FROM mls_handshakes WHERE group_id = $1 AND seq >= $2
ORDER BY seq LIMIT sqlc.arg(max_rows)::bigint;

-- name: OldestHandshakeSeq :one
SELECT seq FROM mls_handshakes WHERE group_id = $1 ORDER BY seq LIMIT 1;

-- name: GetCommitAtEpoch :one
SELECT * FROM mls_handshakes
WHERE group_id = $1 AND epoch = $2 AND kind IN (1, 2)
ORDER BY seq LIMIT 1;

-- name: PruneHandshakes :execrows
DELETE FROM mls_handshakes WHERE created < $1;

-- name: PutProposal :exec
INSERT INTO mls_pending_proposals (group_id, ref, epoch, kind, target_leaf, target_device,
                                   key_package, origin, action_id, issued_at, ttl, void_at)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12);

-- name: GetProposal :one
SELECT * FROM mls_pending_proposals WHERE group_id = $1 AND ref = $2;

-- name: ListLiveProposals :many
SELECT * FROM mls_pending_proposals WHERE group_id = $1 AND epoch = $2 AND void_at IS NULL
ORDER BY issued_at, ref;

-- name: ListAllProposals :many
SELECT * FROM mls_pending_proposals WHERE group_id = $1 AND epoch = $2
ORDER BY issued_at, ref;

-- name: VoidProposal :exec
UPDATE mls_pending_proposals SET void_at = $1 WHERE group_id = $2 AND ref = $3;

-- name: DeleteProposal :exec
DELETE FROM mls_pending_proposals WHERE group_id = $1 AND ref = $2;

-- name: DeleteMembers :exec
DELETE FROM mls_members WHERE group_id = $1;

-- name: PutMemberLeaf :exec
INSERT INTO mls_members (group_id, leaf_index, user_id, device_id, signature_key, added_epoch,
                         removed_epoch)
VALUES ($1, $2, $3, $4, $5, $6, $7);

-- name: ListMembers :many
SELECT * FROM mls_members WHERE group_id = $1 AND removed_epoch IS NULL ORDER BY leaf_index;

-- name: GroupsForDevice :many
SELECT DISTINCT group_id FROM mls_members WHERE device_id = $1 AND removed_epoch IS NULL
ORDER BY group_id;

-- name: PutKeyPackage :exec
INSERT INTO key_packages (device_id, kp_ref, blob, last_resort, expires, created, consumed_at)
VALUES ($1, $2, $3, $4, $5, $6, $7)
ON CONFLICT (device_id, kp_ref) DO NOTHING;

-- name: DeleteOtherLastResortKeyPackages :exec
DELETE FROM key_packages
WHERE device_id = $1 AND last_resort = 1 AND kp_ref <> $2;

-- name: TakeKeyPackage :one
-- FOR UPDATE SKIP LOCKED is the one difference from the SQLite form: on Postgres two concurrent
-- takes for one device read the same snapshot, and a join storm makes that routine.
UPDATE key_packages SET consumed_at = sqlc.arg(now)
WHERE key_packages.device_id = sqlc.arg(device_id) AND key_packages.kp_ref = (
  SELECT kp.kp_ref FROM key_packages kp
  WHERE kp.device_id = sqlc.arg(device_id) AND kp.consumed_at IS NULL AND kp.last_resort = 0
        AND kp.expires > sqlc.arg(now)
  ORDER BY kp.expires, kp.kp_ref LIMIT 1
  FOR UPDATE SKIP LOCKED)
RETURNING *;

-- name: GetLastResortKeyPackage :one
SELECT * FROM key_packages
WHERE device_id = $1 AND consumed_at IS NULL AND last_resort = 1 AND expires > $2
ORDER BY expires DESC, kp_ref LIMIT 1;

-- name: CountKeyPackages :one
SELECT count(*) FROM key_packages
WHERE device_id = $1 AND consumed_at IS NULL AND last_resort = 0 AND expires > $2;

-- name: PurgeKeyPackagesKeepingLastResort :execrows
DELETE FROM key_packages WHERE last_resort = 0;

-- name: PurgeAllKeyPackages :execrows
DELETE FROM key_packages;

-- name: PutWelcomePayload :exec
INSERT INTO mls_welcome_payloads (blob_sha256, group_id, epoch, blob, created)
VALUES ($1, $2, $3, $4, $5)
ON CONFLICT (blob_sha256) DO NOTHING;

-- name: PutEpochTree :exec
INSERT INTO mls_epoch_trees (group_id, epoch, ratchet_tree, tree_hash, created)
VALUES ($1, $2, $3, $4, $5)
ON CONFLICT (group_id, epoch) DO NOTHING;

-- name: PutWelcome :exec
INSERT INTO mls_welcomes (device_id, group_id, epoch, commit_seq, blob_sha256, created, expires,
                          delivered_at)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
ON CONFLICT (device_id, blob_sha256) DO NOTHING;

-- name: ListWelcomes :many
SELECT mls_welcomes.welcome_id, mls_welcomes.device_id, mls_welcomes.group_id, mls_welcomes.epoch,
       mls_welcomes.commit_seq, mls_welcomes.blob_sha256, mls_welcomes.created,
       mls_welcomes.expires, mls_welcomes.delivered_at, mls_welcome_payloads.blob,
       mls_epoch_trees.ratchet_tree, mls_epoch_trees.tree_hash
FROM mls_welcomes
JOIN mls_welcome_payloads ON mls_welcome_payloads.blob_sha256 = mls_welcomes.blob_sha256
LEFT JOIN mls_epoch_trees ON mls_epoch_trees.group_id = mls_welcomes.group_id
                         AND mls_epoch_trees.epoch = mls_welcomes.epoch
WHERE mls_welcomes.device_id = $1 AND mls_welcomes.delivered_at IS NULL
      AND mls_welcomes.welcome_id > $2
ORDER BY mls_welcomes.welcome_id LIMIT sqlc.arg(max_rows)::bigint;

-- name: DeleteWelcome :exec
UPDATE mls_welcomes SET delivered_at = $1 WHERE device_id = $2 AND welcome_id = $3;

-- name: PruneWelcomes :execrows
DELETE FROM mls_welcomes WHERE expires < $1;

-- name: PutForkReport :exec
INSERT INTO fork_reports (group_id, seq, reporter_device, epoch, reason, created)
VALUES ($1, $2, $3, $4, $5, $6)
ON CONFLICT (group_id, seq, reporter_device) DO NOTHING;

-- name: CountForkReporters :one
SELECT count(*) FROM fork_reports WHERE group_id = $1 AND seq = $2;

-- name: QuarantineDevice :exec
UPDATE devices SET quarantined_at = $1, quarantine_reason = $2 WHERE id = $3;
