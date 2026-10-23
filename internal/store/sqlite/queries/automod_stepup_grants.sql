-- name: CreateBotAutoModerationGrant :exec
INSERT INTO automod_stepup_grants(token_hash, community_id, installation_id, group_id, request_id, actor_user, actor_device, expected_revision, request_expires, config_hash, expires)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);

-- name: GetBotAutoModerationGrant :one
SELECT * FROM automod_stepup_grants WHERE token_hash = ?;

-- name: AcceptBotAutoModerationGrant :execrows
UPDATE automod_stepup_grants
SET consumed_at = ?, accepted_request_hash = ?, receipt = ?
WHERE token_hash = ? AND community_id = ? AND installation_id = ? AND group_id = ? AND request_id = ?
  AND actor_user = ? AND actor_device = ? AND expected_revision = ? AND request_expires = ? AND config_hash = ?
  AND expires > ? AND consumed_at IS NULL;
