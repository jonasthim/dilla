CREATE TABLE manual_warning_actions (
  community_id bytea NOT NULL CHECK(octet_length(community_id)=16) REFERENCES communities(id) ON DELETE CASCADE,
  request_id bytea NOT NULL CHECK(octet_length(request_id)=16 AND request_id <> decode(repeat('00',16),'hex')),
  action_id bytea NOT NULL CHECK(octet_length(action_id)=16 AND action_id <> decode(repeat('00',16),'hex')),
  actor_user_id bytea NOT NULL CHECK(octet_length(actor_user_id)=16) REFERENCES users(id) ON DELETE CASCADE,
  actor_device_id bytea NOT NULL CHECK(octet_length(actor_device_id)=16) REFERENCES devices(id) ON DELETE CASCADE,
  target_user_id bytea NOT NULL CHECK(octet_length(target_user_id)=16) REFERENCES users(id) ON DELETE CASCADE,
  revision bigint NOT NULL CHECK(revision>0),
  accepted_at bigint NOT NULL CHECK(accepted_at>0),
  PRIMARY KEY(community_id,request_id),
  UNIQUE(community_id,action_id)
);
