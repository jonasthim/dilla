CREATE TABLE moderation_removal_heads (
  group_id BYTEA NOT NULL CHECK (octet_length(group_id) = 16) REFERENCES mls_groups(group_id) ON DELETE CASCADE,
  revision BIGINT NOT NULL CHECK (revision >= 0),
  PRIMARY KEY (group_id)
);

CREATE TABLE moderation_removals (
  request_id BYTEA NOT NULL CHECK (octet_length(request_id) = 16),
  action_id BYTEA NOT NULL CHECK (octet_length(action_id) = 16),
  community_id BYTEA NOT NULL CHECK (octet_length(community_id) = 16) REFERENCES communities(id) ON DELETE CASCADE,
  group_id BYTEA NOT NULL CHECK (octet_length(group_id) = 16),
  target_seq BIGINT NOT NULL CHECK (target_seq > 0),
  revision BIGINT NOT NULL CHECK (revision > 0),
  proof BYTEA NOT NULL CHECK (octet_length(proof) BETWEEN 1 AND 105),
  signature BYTEA NOT NULL CHECK (octet_length(signature) = 64),
  accepted_at BIGINT NOT NULL CHECK (accepted_at >= 0),
  PRIMARY KEY (request_id),
  UNIQUE (group_id, revision),
  UNIQUE (group_id, target_seq),
  FOREIGN KEY (group_id) REFERENCES mls_groups(group_id) ON DELETE CASCADE
);
CREATE INDEX moderation_removals_feed ON moderation_removals(group_id, revision);
