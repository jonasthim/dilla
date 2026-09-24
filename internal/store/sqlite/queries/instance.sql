-- name: CreateInstance :exec
INSERT INTO instances (instance_id, external_sender_key_id, key_history, franking_key_id, generation, policy_version, created)
VALUES (?, ?, ?, ?, ?, ?, ?);

-- name: GetInstance :one
SELECT instance_id, external_sender_key_id, key_history, franking_key_id, generation, policy_version, created
FROM instances LIMIT 1;

-- name: BumpGeneration :one
UPDATE instances SET generation = generation + 1 RETURNING generation;

-- name: GetSetting :one
SELECT value FROM instance_settings WHERE key = ?;

-- name: PutSetting :exec
INSERT INTO instance_settings (key, value, updated) VALUES (?, ?, ?)
ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated = excluded.updated;
