-- +goose Up
CREATE TABLE community_member_timeouts (
  community_id BYTEA NOT NULL CHECK (octet_length(community_id) = 16),
  user_id BYTEA NOT NULL CHECK (octet_length(user_id) = 16),
  by_user BYTEA NOT NULL CHECK (octet_length(by_user) = 16),
  created BIGINT NOT NULL CHECK (created >= 0),
  expires BIGINT NOT NULL CHECK (expires > created),
  PRIMARY KEY (community_id, user_id),
  FOREIGN KEY (community_id, user_id) REFERENCES members(community_id, user_id) ON DELETE CASCADE,
  FOREIGN KEY (by_user) REFERENCES users(id) ON DELETE RESTRICT
);
-- +goose Down
DROP TABLE community_member_timeouts;
