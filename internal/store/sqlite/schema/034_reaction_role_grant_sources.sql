-- +goose Up
CREATE UNIQUE INDEX role_panel_options_grant_source_uq
  ON role_panel_options(channel_id,message_seq,emoji,role_id);

CREATE TABLE reaction_role_grant_sources (
  community_id BLOB NOT NULL CHECK(length(community_id)=16),
  user_id BLOB NOT NULL CHECK(length(user_id)=16),
  role_id BLOB NOT NULL CHECK(length(role_id)=16),
  channel_id BLOB NOT NULL CHECK(length(channel_id)=16),
  message_seq INTEGER NOT NULL CHECK(message_seq>0),
  reaction TEXT NOT NULL CHECK(length(CAST(reaction AS BLOB))>0 AND length(CAST(reaction AS BLOB))<=32),
  PRIMARY KEY(community_id,user_id,role_id,channel_id,message_seq,reaction),
  FOREIGN KEY(community_id,user_id,role_id)
    REFERENCES member_roles(community_id,user_id,role_id) ON DELETE CASCADE
  -- Panel and option rows are replaced transactionally; their mutations must
  -- explicitly revoke sources and recompute member_roles, never cascade here.
) STRICT;

-- +goose Down
DROP TABLE reaction_role_grant_sources;
DROP INDEX role_panel_options_grant_source_uq;
