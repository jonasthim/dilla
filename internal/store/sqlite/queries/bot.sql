-- name: CreateBotRuntime :exec
INSERT INTO bot_runtimes(id, token_hash, created, rotated, revoked_at) VALUES (?, ?, ?, ?, ?);

-- name: GetBotRuntime :one
SELECT * FROM bot_runtimes WHERE id = ?;

-- name: GetBotRuntimeByHash :one
SELECT * FROM bot_runtimes WHERE token_hash = ?;

-- name: RotateBotRuntime :execrows
UPDATE bot_runtimes SET token_hash = ?, rotated = ? WHERE id = ? AND token_hash = ? AND revoked_at IS NULL;

-- name: RevokeBotRuntime :execrows
UPDATE bot_runtimes SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL;

-- name: ListBotRuntimes :many
SELECT * FROM bot_runtimes WHERE id > ? ORDER BY id LIMIT sqlc.arg(max_rows);

-- name: CreateBotInstallation :exec
INSERT INTO bot_installations(id, community_id, runtime_id, user_id, device_id, role_id, state, revision, capabilities, approved_by, approved_at, credential_verified_at, created, updated, removed_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);

-- name: GetBotInstallation :one
SELECT * FROM bot_installations WHERE id = ?;

-- name: GetActiveBotInstallationByCommunity :one
SELECT * FROM bot_installations WHERE community_id = ? AND removed_at IS NULL;

-- name: ListBotInstallationsAfter :many
SELECT * FROM bot_installations WHERE id > ? AND removed_at IS NULL ORDER BY id LIMIT sqlc.arg(max_rows);

-- name: ListBotInstallationsByDevice :many
SELECT * FROM bot_installations WHERE device_id = ? AND id > ? ORDER BY id LIMIT sqlc.arg(max_rows);

-- name: UpdateBotInstallation :execrows
UPDATE bot_installations SET runtime_id = ?, user_id = ?, device_id = ?, role_id = ?, state = ?, revision = ?, capabilities = ?, approved_by = ?, approved_at = ?, credential_verified_at = ?, updated = ?, removed_at = ?
WHERE id = ? AND revision = ? AND removed_at IS NULL;

-- name: LockBotInstallation :one
UPDATE bot_installations SET updated = updated WHERE id = ? RETURNING id;

-- name: LockBotCommunity :one
UPDATE communities SET name = name WHERE id = ? RETURNING id;

-- name: GetBotClaim :one
SELECT * FROM bot_claims WHERE installation_id = ?;

-- name: PutBotClaim :exec
INSERT INTO bot_claims(installation_id, runtime_id, claim_id, request_id, expires) VALUES (?, ?, ?, ?, ?);

-- name: DeleteBotClaim :execrows
DELETE FROM bot_claims WHERE installation_id = ?;

-- name: DeleteBotClaimsByRuntime :execrows
DELETE FROM bot_claims WHERE runtime_id = ?;

-- name: CreateBotOperation :exec
INSERT INTO bot_operations(community_id, request_id, installation_id, actor_kind, actor_id, actor_device, operation, payload_hash, result_cbor, created)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?);

-- name: GetBotOperation :one
SELECT * FROM bot_operations WHERE community_id = ? AND request_id = ?;

-- name: CreateBotSessionBinding :exec
INSERT INTO bot_session_bindings(token_hash, installation_id, user_id, device_id, created) VALUES (?, ?, ?, ?, ?);

-- name: GetBotSessionBinding :one
SELECT * FROM bot_session_bindings WHERE token_hash = ?;

-- name: DeleteBotSessionBindingsByInstallation :execrows
DELETE FROM bot_session_bindings WHERE installation_id = ?;

-- name: UpdateDeviceCredential :execrows
UPDATE devices SET credential_blob = ? WHERE id = ?;
