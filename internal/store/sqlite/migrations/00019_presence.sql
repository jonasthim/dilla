-- +goose Up
-- 017_presence.sql: persisted account-wide presence choice. 1 online, 2 idle, 3 dnd, 4 invisible.
CREATE TABLE user_presence (
  user_id BLOB NOT NULL CHECK (length(user_id) = 16) REFERENCES users(id) ON DELETE CASCADE PRIMARY KEY,
  choice INTEGER NOT NULL CHECK (choice IN (1, 2, 3, 4))
) STRICT;

-- +goose Down
DROP TABLE user_presence;
