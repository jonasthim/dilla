CREATE TABLE community_member_timeouts (
  community_id BLOB NOT NULL CHECK (length(community_id) = 16),
  user_id BLOB NOT NULL CHECK (length(user_id) = 16),
  by_user BLOB NOT NULL CHECK (length(by_user) = 16),
  created INTEGER NOT NULL CHECK (created >= 0),
  expires INTEGER NOT NULL CHECK (expires > created),
  PRIMARY KEY (community_id, user_id),
  FOREIGN KEY (community_id, user_id) REFERENCES members(community_id, user_id) ON DELETE CASCADE,
  FOREIGN KEY (by_user) REFERENCES users(id) ON DELETE RESTRICT
) STRICT;
