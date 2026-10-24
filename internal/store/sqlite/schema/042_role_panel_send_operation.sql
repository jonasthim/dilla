ALTER TABLE role_panels
  ADD COLUMN send_operation_id BLOB NOT NULL
    DEFAULT X'00000000000000000000000000000000'
    CHECK (length(send_operation_id) = 16);
