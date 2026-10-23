-- +goose Up
CREATE TABLE role_panels (
  community_id BYTEA NOT NULL CHECK(octet_length(community_id)=16) REFERENCES communities(id) ON DELETE CASCADE,
  channel_id BYTEA NOT NULL CHECK(octet_length(channel_id)=16) REFERENCES channels(id) ON DELETE CASCADE,
  message_seq BIGINT NOT NULL CHECK(message_seq>0),
  author_id BYTEA NOT NULL CHECK(octet_length(author_id)=16) REFERENCES users(id),
  installation_id BYTEA NOT NULL CHECK(octet_length(installation_id)=16) REFERENCES bot_installations(id) ON DELETE CASCADE,
  PRIMARY KEY(channel_id,message_seq), UNIQUE(community_id,channel_id,message_seq)
);
CREATE TABLE role_panel_options (
  channel_id BYTEA NOT NULL,
  message_seq BIGINT NOT NULL,
  emoji TEXT NOT NULL CHECK(octet_length(emoji)>0 AND octet_length(emoji)<=32),
  role_id BYTEA NOT NULL CHECK(octet_length(role_id)=16) REFERENCES roles(id) ON DELETE CASCADE,
  PRIMARY KEY(channel_id,message_seq,emoji),
  FOREIGN KEY(channel_id,message_seq) REFERENCES role_panels(channel_id,message_seq) ON DELETE CASCADE
);

-- +goose Down
DROP TABLE role_panel_options;
DROP TABLE role_panels;
