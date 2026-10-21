-- +goose Up
-- The body of this section is internal/store/postgres/schema/021_device_labels.sql, verbatim.
-- internal/store/schema_test.go asserts that, because sqlc reads the schema directory and
-- goose reads this file: if they drift, sqlc generates against a schema the database does
-- not have.

-- 021_device_labels.sql: the owner's own name for a device (EOD E7), migration
-- 00023_device_labels.sql. NULL is no name; the client then shows the first eight characters
-- of the device id. The label is not part of the signed device list: the server stores it
-- readable, like a display name, and could change it.
ALTER TABLE devices ADD COLUMN label TEXT CHECK (label IS NULL OR (char_length(label) BETWEEN 1 AND 64));

-- +goose Down
ALTER TABLE devices DROP COLUMN label;
