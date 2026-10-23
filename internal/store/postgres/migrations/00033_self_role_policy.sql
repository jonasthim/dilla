-- +goose Up
CREATE TABLE self_role_policy (
  community_id BYTEA NOT NULL CHECK(octet_length(community_id)=16) REFERENCES communities(id) ON DELETE CASCADE,
  role_id BYTEA NOT NULL CHECK(octet_length(role_id)=16) REFERENCES roles(id) ON DELETE CASCADE,
  approved_by BYTEA NOT NULL CHECK(octet_length(approved_by)=16) REFERENCES users(id),
  approved_at BIGINT NOT NULL,
  PRIMARY KEY(community_id, role_id)
);

-- +goose Down
DROP TABLE self_role_policy;
