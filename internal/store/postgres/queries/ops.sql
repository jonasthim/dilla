-- name: PutReport :exec
INSERT INTO reports (id, reporter, group_id, seq, revealed_envelope, k_f, franking_key_id, verification_result, status, created)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10);

-- name: GetReport :one
SELECT * FROM reports WHERE id = $1;

-- name: UpdateReportStatus :exec
UPDATE reports SET status = $1, verification_result = $2 WHERE id = $3;

-- name: InsertAudit :exec
INSERT INTO audit_log (actor, action, target, detail, at) VALUES ($1, $2, $3, $4, $5);

-- name: ListAudit :many
SELECT * FROM audit_log WHERE at >= $1 ORDER BY id DESC LIMIT sqlc.arg(max_rows)::bigint;
