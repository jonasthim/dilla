-- 010_reports.sql: the franking columns a report is verified against (Plan 2 task 17, P2-D21),
-- migration 00012_reports.sql. The reports table itself is 009_ops.sql's and shipped in
-- 00001_init.sql; 005_messages.sql and 007_readable.sql are already verbatim in their own
-- migrations, so the columns land here as ALTERs and sqlc reads them after the CREATEs (the name
-- sorts after 009_ops.sql).
--
-- mls_app_messages.franking_key_id names the instance franking key the tag was made under, so a
-- report still verifies after the key rotates. The all-zero default marks a row franked before the
-- column existed; the verifier then tries every retained key, current first.
--
-- readable_messages already records its key id (007_readable.sql). It gains the other two fields of
-- protocol/04's stored tuple that it lacked: uploader_device (sender is a user id, but T binds the
-- uploading device) and commitment_c (C, which the report's first equation is checked against).
-- A row written before this migration has the all-zero device and a NULL commitment.
ALTER TABLE mls_app_messages ADD COLUMN franking_key_id BLOB NOT NULL
  DEFAULT x'00000000000000000000000000000000' CHECK (length(franking_key_id) = 16);
ALTER TABLE readable_messages ADD COLUMN uploader_device BLOB NOT NULL
  DEFAULT x'00000000000000000000000000000000' CHECK (length(uploader_device) = 16);
ALTER TABLE readable_messages ADD COLUMN commitment_c BLOB
  CHECK (commitment_c IS NULL OR length(commitment_c) = 32);
-- GET /v1/reports: the queue, newest first.
CREATE INDEX reports_by_created ON reports(created, id);
