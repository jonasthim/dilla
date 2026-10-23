CREATE TABLE community_member_episodes (
  community_id BLOB NOT NULL CHECK (length(community_id) = 16),
  user_id BLOB NOT NULL CHECK (length(user_id) = 16),
  episode_id BLOB NOT NULL UNIQUE CHECK (length(episode_id) = 16),
  PRIMARY KEY (community_id, user_id),
  FOREIGN KEY (community_id, user_id) REFERENCES members(community_id, user_id) ON DELETE CASCADE
) STRICT;
