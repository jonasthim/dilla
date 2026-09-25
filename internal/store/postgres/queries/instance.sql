-- name: CreateInstance :exec
INSERT INTO instances (instance_id, external_sender_key_id, key_history, franking_key_id, generation, policy_version, created)
VALUES ($1, $2, $3, $4, $5, $6, $7);

-- name: GetInstance :one
SELECT instance_id, external_sender_key_id, key_history, franking_key_id, generation, policy_version, created
FROM instances LIMIT 1;

-- name: BumpGeneration :one
UPDATE instances SET generation = generation + 1 RETURNING generation;

-- name: SetGeneration :exec
-- Invariant 11's restore half, and MONOTONE. `dillad restore` names the generation it read out of
-- the backup's manifest; a backup taken before an earlier restore would otherwise walk the number
-- BACKWARDS, and the generation is exactly what invalidates outstanding resume tokens, so a
-- backwards step would revive every token the last restore killed. GREATEST() keeps the one
-- promise every client depends on: the generation only ever grows.
UPDATE instances SET generation = GREATEST(generation, sqlc.arg(generation)::bigint);

-- name: GetSetting :one
SELECT value FROM instance_settings WHERE key = $1;

-- name: PutSetting :exec
INSERT INTO instance_settings (key, value, updated) VALUES ($1, $2, $3)
ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated = excluded.updated;
