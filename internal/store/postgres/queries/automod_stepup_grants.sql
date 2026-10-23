-- name: CreateBotAutoModerationGrant :exec
INSERT INTO automod_stepup_grants(token_hash, community_id, installation_id, group_id, request_id, actor_user, actor_device, expected_revision, request_expires, config_hash, expires)
VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11);

-- name: GetBotAutoModerationGrant :one
SELECT * FROM automod_stepup_grants WHERE token_hash = $1;

-- name: AcceptBotAutoModerationGrant :execrows
UPDATE automod_stepup_grants
SET consumed_at = $1, accepted_request_hash = $2, receipt = $3
WHERE token_hash = $4 AND community_id = $5 AND installation_id = $6 AND group_id = $7 AND request_id = $8
  AND actor_user = $9 AND actor_device = $10 AND expected_revision = $11 AND request_expires = $12 AND config_hash = $13
  AND expires > $14 AND consumed_at IS NULL;
