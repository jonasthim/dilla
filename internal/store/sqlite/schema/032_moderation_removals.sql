CREATE TABLE moderation_removal_heads (
  group_id BLOB NOT NULL CHECK (length(group_id) = 16) REFERENCES mls_groups(group_id) ON DELETE CASCADE,
  revision INTEGER NOT NULL CHECK (revision >= 0),
  PRIMARY KEY (group_id)
) STRICT;

CREATE TABLE moderation_removals (
  request_id BLOB NOT NULL CHECK (length(request_id) = 16),
  action_id BLOB NOT NULL CHECK (length(action_id) = 16),
  community_id BLOB NOT NULL CHECK (length(community_id) = 16) REFERENCES communities(id) ON DELETE CASCADE,
  group_id BLOB NOT NULL CHECK (length(group_id) = 16),
  target_seq INTEGER NOT NULL CHECK (target_seq > 0),
  revision INTEGER NOT NULL CHECK (revision > 0),
  proof BLOB NOT NULL CHECK (length(proof) BETWEEN 1 AND 105),
  signature BLOB NOT NULL CHECK (length(signature) = 64),
  accepted_at INTEGER NOT NULL CHECK (accepted_at >= 0),
  PRIMARY KEY (request_id),
  UNIQUE (group_id, revision),
  UNIQUE (group_id, target_seq),
  FOREIGN KEY (group_id) REFERENCES mls_groups(group_id) ON DELETE CASCADE
) STRICT;
CREATE INDEX moderation_removals_feed ON moderation_removals(group_id, revision);
