CREATE TABLE bot_join_role_grant_receipts (
  installation_id BLOB NOT NULL CHECK(length(installation_id)=16),
  request_id BLOB NOT NULL CHECK(length(request_id)=16),
  community_id BLOB NOT NULL CHECK(length(community_id)=16),
  user_id BLOB NOT NULL CHECK(length(user_id)=16),
  episode_id BLOB NOT NULL CHECK(length(episode_id)=16),
  role_id BLOB NOT NULL CHECK(length(role_id)=16),
  PRIMARY KEY(installation_id,user_id,episode_id),
  UNIQUE(installation_id,request_id)
) STRICT;
CREATE TABLE bot_join_role_grant_sources (
  installation_id BLOB NOT NULL CHECK(length(installation_id)=16),
  user_id BLOB NOT NULL CHECK(length(user_id)=16),
  episode_id BLOB NOT NULL CHECK(length(episode_id)=16),
  community_id BLOB NOT NULL CHECK(length(community_id)=16),
  role_id BLOB NOT NULL CHECK(length(role_id)=16),
  PRIMARY KEY(installation_id,user_id,episode_id),
  FOREIGN KEY(installation_id) REFERENCES bot_installations(id) ON DELETE CASCADE,
  FOREIGN KEY(installation_id,user_id,episode_id) REFERENCES bot_join_role_grant_receipts(installation_id,user_id,episode_id) ON DELETE CASCADE,
  FOREIGN KEY(community_id,user_id,role_id) REFERENCES member_roles(community_id,user_id,role_id) ON DELETE CASCADE
) STRICT;
