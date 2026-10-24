-- +goose Up
CREATE UNIQUE INDEX role_panel_options_grant_source_uq
  ON role_panel_options(channel_id,message_seq,emoji,role_id);

CREATE TABLE reaction_role_grant_sources (
  community_id BYTEA NOT NULL CHECK(octet_length(community_id)=16),
  user_id BYTEA NOT NULL CHECK(octet_length(user_id)=16),
  role_id BYTEA NOT NULL CHECK(octet_length(role_id)=16),
  channel_id BYTEA NOT NULL CHECK(octet_length(channel_id)=16),
  message_seq BIGINT NOT NULL CHECK(message_seq>0),
  reaction TEXT NOT NULL CHECK(octet_length(reaction)>0 AND octet_length(reaction)<=32),
  PRIMARY KEY(community_id,user_id,role_id,channel_id,message_seq,reaction),
  FOREIGN KEY(community_id,user_id,role_id)
    REFERENCES member_roles(community_id,user_id,role_id) ON DELETE CASCADE
  -- Panel and option rows require explicit transactional source cleanup.
);

-- +goose Down
DROP TABLE reaction_role_grant_sources;
DROP INDEX role_panel_options_grant_source_uq;
