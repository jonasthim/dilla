-- +goose Up
ALTER TABLE bot_operations DROP CONSTRAINT bot_operations_operation_check;
ALTER TABLE bot_operations ADD CONSTRAINT bot_operations_operation_check CHECK (operation BETWEEN 1 AND 8);

-- +goose Down
DELETE FROM bot_operations WHERE operation = 8;
ALTER TABLE bot_operations DROP CONSTRAINT bot_operations_operation_check;
ALTER TABLE bot_operations ADD CONSTRAINT bot_operations_operation_check CHECK (operation BETWEEN 1 AND 7);
