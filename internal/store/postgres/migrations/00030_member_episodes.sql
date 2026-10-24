-- +goose Up
-- One row binds the live members row to the stable id used by its join/leave
-- event pair. Legacy memberships receive a durable opaque id here; no history
-- event is fabricated for a membership that predates the event stream.
CREATE TABLE community_member_episodes (
  community_id BYTEA NOT NULL CHECK (octet_length(community_id) = 16),
  user_id BYTEA NOT NULL CHECK (octet_length(user_id) = 16),
  episode_id BYTEA NOT NULL UNIQUE CHECK (octet_length(episode_id) = 16),
  PRIMARY KEY (community_id, user_id),
  FOREIGN KEY (community_id, user_id) REFERENCES members(community_id, user_id) ON DELETE CASCADE
);

-- Deterministic opaque ids make a re-run against the same legacy membership
-- set yield the same pairing without requiring an extension such as pgcrypto.
INSERT INTO community_member_episodes(community_id,user_id,episode_id)
SELECT community_id,user_id,decode(md5(encode(community_id,'hex') || encode(user_id,'hex')), 'hex') FROM members;

-- +goose Down
DROP TABLE community_member_episodes;
