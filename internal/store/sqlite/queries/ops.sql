-- name: PutReport :exec
INSERT INTO reports (id, reporter, group_id, seq, revealed_envelope, k_f, franking_key_id, verification_result, status, created)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?);

-- name: GetReport :one
SELECT * FROM reports WHERE id = ?;

-- name: ListReports :many
-- GET /v1/reports (Plan 2 task 17): the queue, newest first, ties broken by id.
SELECT * FROM reports ORDER BY created DESC, id DESC LIMIT sqlc.arg(max_rows);

-- name: UpdateReportStatus :exec
UPDATE reports SET status = ?, verification_result = ? WHERE id = ?;

-- name: InsertAudit :exec
INSERT INTO audit_log (actor, action, target, detail, at) VALUES (?, ?, ?, ?, ?);

-- name: ListAudit :many
SELECT * FROM audit_log WHERE at >= ? ORDER BY id DESC LIMIT sqlc.arg(max_rows);
