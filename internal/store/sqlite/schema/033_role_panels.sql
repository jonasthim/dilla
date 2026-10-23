CREATE TABLE role_panels (
  community_id BLOB NOT NULL CHECK(length(community_id)=16) REFERENCES communities(id) ON DELETE CASCADE,
  channel_id BLOB NOT NULL CHECK(length(channel_id)=16) REFERENCES channels(id) ON DELETE CASCADE,
  message_seq INTEGER NOT NULL CHECK(message_seq>0),
  author_id BLOB NOT NULL CHECK(length(author_id)=16) REFERENCES users(id),
  installation_id BLOB NOT NULL CHECK(length(installation_id)=16) REFERENCES bot_installations(id) ON DELETE CASCADE,
  PRIMARY KEY(channel_id,message_seq), UNIQUE(community_id,channel_id,message_seq)
) STRICT;
CREATE TABLE role_panel_options (
  channel_id BLOB NOT NULL,
  message_seq INTEGER NOT NULL,
  emoji TEXT NOT NULL CHECK(length(CAST(emoji AS BLOB))>0 AND length(CAST(emoji AS BLOB))<=32),
  role_id BLOB NOT NULL CHECK(length(role_id)=16) REFERENCES roles(id) ON DELETE CASCADE,
  PRIMARY KEY(channel_id,message_seq,emoji),
  FOREIGN KEY(channel_id,message_seq) REFERENCES role_panels(channel_id,message_seq) ON DELETE CASCADE
) STRICT;
