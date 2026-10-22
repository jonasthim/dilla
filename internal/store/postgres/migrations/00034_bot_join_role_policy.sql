-- +goose Up
CREATE UNIQUE INDEX bot_installations_id_community ON bot_installations(id, community_id);
CREATE TABLE bot_join_role_policy (
  installation_id BYTEA NOT NULL CHECK(octet_length(installation_id)=16),
  community_id BYTEA NOT NULL CHECK(octet_length(community_id)=16),
  role_id BYTEA NOT NULL CHECK(octet_length(role_id)=16),
  approved_by BYTEA NOT NULL CHECK(octet_length(approved_by)=16) REFERENCES users(id),
  approved_at BIGINT NOT NULL,
  PRIMARY KEY(installation_id),
  FOREIGN KEY(installation_id,community_id) REFERENCES bot_installations(id,community_id) ON DELETE CASCADE,
  FOREIGN KEY(role_id,community_id) REFERENCES roles(id,community_id) ON DELETE CASCADE
);

-- +goose Down
DROP TABLE bot_join_role_policy;
DROP INDEX bot_installations_id_community;
