-- name: CreateGroup :exec
INSERT INTO mls_groups (group_id, binding, kind, community_id, target_id, call_id, ciphersuite,
                        epoch, seq, group_info_blob, tree_hash, public_group_state,
                        external_sender_key_id, e2ee_version, media_version, policy_version,
                        epoch_unknown, heal_deadline, created, closed_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);

-- name: GetGroup :one
SELECT * FROM mls_groups WHERE group_id = ?;

-- name: ListOpenGroups :many
SELECT * FROM mls_groups WHERE closed_at IS NULL AND group_id > ?
ORDER BY group_id LIMIT sqlc.arg(max_rows);

-- name: CloseGroup :exec
UPDATE mls_groups SET closed_at = ? WHERE group_id = ?;

-- name: BumpGroupSeq :one
UPDATE mls_groups SET seq = seq + 1 WHERE group_id = ? RETURNING seq;

-- name: PutGroupState :exec
UPDATE mls_groups
SET epoch = ?, public_group_state = ?, group_info_blob = ?, tree_hash = ?, epoch_unknown = 0
WHERE group_id = ?;

-- name: SetGroupHealing :exec
UPDATE mls_groups SET epoch_unknown = ?, heal_deadline = ? WHERE group_id = ?;

-- name: AppendHandshake :exec
INSERT INTO mls_handshakes (group_id, seq, epoch, kind, sender_leaf, sender_device, blob, created)
VALUES (?, ?, ?, ?, ?, ?, ?, ?);

-- name: ListHandshakes :many
SELECT * FROM mls_handshakes WHERE group_id = ? AND seq >= ?
ORDER BY seq LIMIT sqlc.arg(max_rows);

-- name: OldestHandshakeSeq :one
SELECT seq FROM mls_handshakes WHERE group_id = ? ORDER BY seq LIMIT 1;

-- name: GetCommitAtEpoch :one
SELECT * FROM mls_handshakes
WHERE group_id = ? AND epoch = ? AND kind IN (1, 2)
ORDER BY seq LIMIT 1;

-- name: PruneHandshakes :execrows
DELETE FROM mls_handshakes WHERE created < ?;

-- name: PutProposal :exec
INSERT INTO mls_pending_proposals (group_id, ref, epoch, kind, target_leaf, target_device,
                                   key_package, origin, action_id, issued_at, ttl, void_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);

-- name: GetProposal :one
SELECT * FROM mls_pending_proposals WHERE group_id = ? AND ref = ?;

-- name: ListLiveProposals :many
SELECT * FROM mls_pending_proposals WHERE group_id = ? AND epoch = ? AND void_at IS NULL
ORDER BY issued_at, ref;

-- name: ListAllProposals :many
SELECT * FROM mls_pending_proposals WHERE group_id = ? AND epoch = ?
ORDER BY issued_at, ref;

-- name: VoidProposal :exec
UPDATE mls_pending_proposals SET void_at = ? WHERE group_id = ? AND ref = ?;

-- name: DeleteProposal :exec
DELETE FROM mls_pending_proposals WHERE group_id = ? AND ref = ?;

-- name: DeleteMembers :exec
DELETE FROM mls_members WHERE group_id = ?;

-- name: PutMemberLeaf :exec
INSERT INTO mls_members (group_id, leaf_index, user_id, device_id, signature_key, added_epoch,
                         removed_epoch)
VALUES (?, ?, ?, ?, ?, ?, ?);

-- name: ListMembers :many
SELECT * FROM mls_members WHERE group_id = ? AND removed_epoch IS NULL ORDER BY leaf_index;

-- name: GroupsForDevice :many
SELECT DISTINCT group_id FROM mls_members WHERE device_id = ? AND removed_epoch IS NULL
ORDER BY group_id;

-- name: PutKeyPackage :exec
INSERT INTO key_packages (device_id, kp_ref, blob, last_resort, expires, created, consumed_at)
VALUES (?, ?, ?, ?, ?, ?, ?)
ON CONFLICT (device_id, kp_ref) DO NOTHING;

-- name: TakeKeyPackage :one
UPDATE key_packages SET consumed_at = sqlc.arg(now)
WHERE key_packages.device_id = sqlc.arg(device_id) AND key_packages.kp_ref = (
  SELECT kp.kp_ref FROM key_packages kp
  WHERE kp.device_id = sqlc.arg(device_id) AND kp.consumed_at IS NULL AND kp.last_resort = 0
        AND kp.expires > sqlc.arg(now)
  ORDER BY kp.expires, kp.kp_ref LIMIT 1)
RETURNING *;

-- name: GetLastResortKeyPackage :one
SELECT * FROM key_packages
WHERE device_id = ? AND consumed_at IS NULL AND last_resort = 1 AND expires > ?
ORDER BY expires DESC, kp_ref LIMIT 1;

-- name: CountKeyPackages :one
SELECT count(*) FROM key_packages
WHERE device_id = ? AND consumed_at IS NULL AND last_resort = 0 AND expires > ?;

-- name: PurgeKeyPackagesKeepingLastResort :execrows
DELETE FROM key_packages WHERE last_resort = 0;

-- name: PurgeAllKeyPackages :execrows
DELETE FROM key_packages;

-- name: PutWelcomePayload :exec
INSERT INTO mls_welcome_payloads (blob_sha256, group_id, epoch, blob, created)
VALUES (?, ?, ?, ?, ?)
ON CONFLICT (blob_sha256) DO NOTHING;

-- name: PutEpochTree :exec
INSERT INTO mls_epoch_trees (group_id, epoch, ratchet_tree, tree_hash, created)
VALUES (?, ?, ?, ?, ?)
ON CONFLICT (group_id, epoch) DO NOTHING;

-- name: PutWelcome :exec
INSERT INTO mls_welcomes (device_id, group_id, epoch, commit_seq, blob_sha256, created, expires,
                          delivered_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT (device_id, blob_sha256) DO NOTHING;

-- name: ListWelcomes :many
SELECT mls_welcomes.welcome_id, mls_welcomes.device_id, mls_welcomes.group_id, mls_welcomes.epoch,
       mls_welcomes.commit_seq, mls_welcomes.blob_sha256, mls_welcomes.created,
       mls_welcomes.expires, mls_welcomes.delivered_at, mls_welcome_payloads.blob
FROM mls_welcomes
JOIN mls_welcome_payloads ON mls_welcome_payloads.blob_sha256 = mls_welcomes.blob_sha256
WHERE mls_welcomes.device_id = ? AND mls_welcomes.delivered_at IS NULL
      AND mls_welcomes.welcome_id > ?
ORDER BY mls_welcomes.welcome_id LIMIT sqlc.arg(max_rows);

-- name: DeleteWelcome :exec
UPDATE mls_welcomes SET delivered_at = ? WHERE device_id = ? AND welcome_id = ?;

-- name: PruneWelcomes :execrows
DELETE FROM mls_welcomes WHERE expires < ?;

-- name: PutForkReport :exec
INSERT INTO fork_reports (group_id, seq, reporter_device, epoch, reason, created)
VALUES (?, ?, ?, ?, ?, ?)
ON CONFLICT (group_id, seq, reporter_device) DO NOTHING;

-- name: CountForkReporters :one
SELECT count(*) FROM fork_reports WHERE group_id = ? AND seq = ?;

-- name: QuarantineDevice :exec
UPDATE devices SET quarantined_at = ?, quarantine_reason = ? WHERE id = ?;
