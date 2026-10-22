CREATE TABLE community_member_episodes (
  community_id BYTEA NOT NULL CHECK (octet_length(community_id) = 16),
  user_id BYTEA NOT NULL CHECK (octet_length(user_id) = 16),
  episode_id BYTEA NOT NULL UNIQUE CHECK (octet_length(episode_id) = 16),
  PRIMARY KEY (community_id, user_id),
  FOREIGN KEY (community_id, user_id) REFERENCES members(community_id, user_id) ON DELETE CASCADE
);
