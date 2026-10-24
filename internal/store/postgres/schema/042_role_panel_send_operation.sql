ALTER TABLE role_panels
  ADD COLUMN send_operation_id BYTEA NOT NULL
    DEFAULT decode('00000000000000000000000000000000', 'hex')
    CHECK (octet_length(send_operation_id) = 16);
