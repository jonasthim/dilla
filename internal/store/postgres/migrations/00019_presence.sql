-- +goose Up
-- Persisted account-wide presence choice. 1 online, 2 idle, 3 dnd, 4 invisible.
CREATE TABLE user_presence (
  user_id BYTEA NOT NULL CHECK (octet_length(user_id) = 16) REFERENCES users(id) ON DELETE CASCADE PRIMARY KEY,
  choice SMALLINT NOT NULL CHECK (choice IN (1, 2, 3, 4))
);

-- +goose Down
DROP TABLE user_presence;
