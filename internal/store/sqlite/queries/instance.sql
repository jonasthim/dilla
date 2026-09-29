-- name: CreateInstance :exec
INSERT INTO instances (instance_id, external_sender_key_id, key_history, franking_key_id, generation, policy_version, created)
VALUES (?, ?, ?, ?, ?, ?, ?);

-- name: GetInstance :one
SELECT instance_id, external_sender_key_id, key_history, franking_key_id, generation, policy_version, created
FROM instances LIMIT 1;

-- name: BumpGeneration :one
UPDATE instances SET generation = generation + 1 RETURNING generation;

-- name: SetGeneration :exec
-- Invariant 11's restore half, and MONOTONE. `dillad restore` names the generation it read out of
-- the backup's manifest; a backup taken before an earlier restore would otherwise walk the number
-- BACKWARDS, and the generation is exactly what invalidates outstanding resume tokens, so a
-- backwards step would revive every token the last restore killed. MAX() keeps the one promise
-- every client depends on: the generation only ever grows.
UPDATE instances SET generation = MAX(generation, CAST(sqlc.arg(generation) AS INTEGER));

-- name: GetSetting :one
SELECT value FROM instance_settings WHERE key = ?;

-- name: PutSetting :exec
INSERT INTO instance_settings (key, value, updated) VALUES (?, ?, ?)
ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated = excluded.updated;
