CREATE TABLE dj_role_policy (
  installation_id BLOB NOT NULL CHECK(length(installation_id)=16) REFERENCES bot_installations(id) ON DELETE CASCADE,
  role_id BLOB NOT NULL CHECK(length(role_id)=16) REFERENCES roles(id) ON DELETE CASCADE,
  approved_by BLOB NOT NULL CHECK(length(approved_by)=16) REFERENCES users(id),
  approved_at INTEGER NOT NULL,
  PRIMARY KEY(installation_id, role_id)
) STRICT;
