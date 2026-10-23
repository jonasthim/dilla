-- +goose Up
ALTER TABLE role_panels
  ADD COLUMN send_operation_id BLOB NOT NULL
    DEFAULT X'00000000000000000000000000000000'
    CHECK (length(send_operation_id) = 16);

-- +goose Down
ALTER TABLE role_panels DROP COLUMN send_operation_id;
