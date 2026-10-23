-- +goose Up
CREATE TABLE dj_role_policy (
  installation_id BYTEA NOT NULL CHECK(octet_length(installation_id)=16) REFERENCES bot_installations(id) ON DELETE CASCADE,
  role_id BYTEA NOT NULL CHECK(octet_length(role_id)=16) REFERENCES roles(id) ON DELETE CASCADE,
  approved_by BYTEA NOT NULL CHECK(octet_length(approved_by)=16) REFERENCES users(id),
  approved_at BIGINT NOT NULL,
  PRIMARY KEY(installation_id, role_id)
);

-- +goose Down
DROP TABLE dj_role_policy;
