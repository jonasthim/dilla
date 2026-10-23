-- +goose Up
-- One row binds the live members row to the stable id used by its join/leave
-- event pair. Legacy memberships receive a durable opaque id here; no history
-- event is fabricated for a membership that predates the event stream.
CREATE TABLE community_member_episodes (
  community_id BLOB NOT NULL CHECK (length(community_id) = 16),
  user_id BLOB NOT NULL CHECK (length(user_id) = 16),
  episode_id BLOB NOT NULL UNIQUE CHECK (length(episode_id) = 16),
  PRIMARY KEY (community_id, user_id),
  FOREIGN KEY (community_id, user_id) REFERENCES members(community_id, user_id) ON DELETE CASCADE
) STRICT;

INSERT INTO community_member_episodes(community_id,user_id,episode_id)
SELECT community_id,user_id,randomblob(16) FROM members;

-- +goose Down
DROP TABLE community_member_episodes;
