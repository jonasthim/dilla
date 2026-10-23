-- +goose Up
CREATE TABLE self_role_policy (
  community_id BLOB NOT NULL CHECK(length(community_id)=16) REFERENCES communities(id) ON DELETE CASCADE,
  role_id BLOB NOT NULL CHECK(length(role_id)=16) REFERENCES roles(id) ON DELETE CASCADE,
  approved_by BLOB NOT NULL CHECK(length(approved_by)=16) REFERENCES users(id),
  approved_at INTEGER NOT NULL,
  PRIMARY KEY(community_id, role_id)
) STRICT;

-- +goose Down
DROP TABLE self_role_policy;
