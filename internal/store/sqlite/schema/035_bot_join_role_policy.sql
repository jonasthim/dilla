CREATE UNIQUE INDEX bot_installations_id_community ON bot_installations(id, community_id);
CREATE TABLE bot_join_role_policy (
  installation_id BLOB NOT NULL CHECK(length(installation_id)=16),
  community_id BLOB NOT NULL CHECK(length(community_id)=16),
  role_id BLOB NOT NULL CHECK(length(role_id)=16),
  approved_by BLOB NOT NULL CHECK(length(approved_by)=16) REFERENCES users(id),
  approved_at INTEGER NOT NULL,
  PRIMARY KEY(installation_id),
  FOREIGN KEY(installation_id,community_id) REFERENCES bot_installations(id,community_id) ON DELETE CASCADE,
  FOREIGN KEY(role_id,community_id) REFERENCES roles(id,community_id) ON DELETE CASCADE
) STRICT;
