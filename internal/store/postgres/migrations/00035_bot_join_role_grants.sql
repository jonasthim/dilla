-- +goose Up
-- Receipt IDs remain durable after membership, role, and installation removal.
CREATE TABLE bot_join_role_grant_receipts (
  installation_id BYTEA NOT NULL CHECK(octet_length(installation_id)=16),
  request_id BYTEA NOT NULL CHECK(octet_length(request_id)=16),
  community_id BYTEA NOT NULL CHECK(octet_length(community_id)=16),
  user_id BYTEA NOT NULL CHECK(octet_length(user_id)=16),
  episode_id BYTEA NOT NULL CHECK(octet_length(episode_id)=16),
  role_id BYTEA NOT NULL CHECK(octet_length(role_id)=16),
  PRIMARY KEY(installation_id,user_id,episode_id),
  UNIQUE(installation_id,request_id)
);
CREATE TABLE bot_join_role_grant_sources (
  installation_id BYTEA NOT NULL CHECK(octet_length(installation_id)=16),
  user_id BYTEA NOT NULL CHECK(octet_length(user_id)=16),
  episode_id BYTEA NOT NULL CHECK(octet_length(episode_id)=16),
  community_id BYTEA NOT NULL CHECK(octet_length(community_id)=16),
  role_id BYTEA NOT NULL CHECK(octet_length(role_id)=16),
  PRIMARY KEY(installation_id,user_id,episode_id),
  FOREIGN KEY(installation_id) REFERENCES bot_installations(id) ON DELETE CASCADE,
  FOREIGN KEY(installation_id,user_id,episode_id) REFERENCES bot_join_role_grant_receipts(installation_id,user_id,episode_id) ON DELETE CASCADE,
  FOREIGN KEY(community_id,user_id,role_id) REFERENCES member_roles(community_id,user_id,role_id) ON DELETE CASCADE
);
-- +goose Down
DROP TABLE bot_join_role_grant_sources;
DROP TABLE bot_join_role_grant_receipts;
