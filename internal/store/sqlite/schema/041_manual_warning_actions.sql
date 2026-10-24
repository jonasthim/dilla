CREATE TABLE manual_warning_actions (
  community_id BLOB NOT NULL CHECK(length(community_id)=16) REFERENCES communities(id) ON DELETE CASCADE,
  request_id BLOB NOT NULL CHECK(length(request_id)=16 AND request_id != zeroblob(16)),
  action_id BLOB NOT NULL CHECK(length(action_id)=16 AND action_id != zeroblob(16)),
  actor_user_id BLOB NOT NULL CHECK(length(actor_user_id)=16) REFERENCES users(id) ON DELETE CASCADE,
  actor_device_id BLOB NOT NULL CHECK(length(actor_device_id)=16) REFERENCES devices(id) ON DELETE CASCADE,
  target_user_id BLOB NOT NULL CHECK(length(target_user_id)=16) REFERENCES users(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL CHECK(revision>0),
  accepted_at INTEGER NOT NULL CHECK(accepted_at>0),
  PRIMARY KEY(community_id,request_id),
  UNIQUE(community_id,action_id)
) STRICT;
