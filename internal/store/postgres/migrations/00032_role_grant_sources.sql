-- +goose Up
-- A role can be granted by multiple independent mechanisms while permissions
-- continue to read the effective member_roles relation.
CREATE TABLE member_role_grant_sources (
  community_id BYTEA NOT NULL CHECK (octet_length(community_id) = 16),
  user_id      BYTEA NOT NULL CHECK (octet_length(user_id) = 16),
  role_id      BYTEA NOT NULL CHECK (octet_length(role_id) = 16),
  source       TEXT NOT NULL CHECK (source IN ('manual', 'self', 'reaction')),
  PRIMARY KEY (community_id, user_id, role_id, source),
  FOREIGN KEY (community_id, user_id, role_id)
    REFERENCES member_roles(community_id, user_id, role_id) ON DELETE CASCADE
);

INSERT INTO member_role_grant_sources(community_id, user_id, role_id, source)
SELECT community_id, user_id, role_id, 'manual' FROM member_roles;
-- +goose Down
DROP TABLE member_role_grant_sources;
