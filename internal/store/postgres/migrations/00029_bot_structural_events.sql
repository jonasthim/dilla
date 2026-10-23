-- +goose Up
CREATE TABLE bot_event_streams (
  community_id BYTEA NOT NULL CHECK (octet_length(community_id) = 16) REFERENCES communities(id) ON DELETE CASCADE,
  high_water BIGINT NOT NULL CHECK (high_water >= 0),
  floor BIGINT NOT NULL CHECK (floor >= 0 AND floor <= high_water),
  PRIMARY KEY (community_id)
);

CREATE TABLE bot_structural_events (
  event_id BYTEA NOT NULL CHECK (octet_length(event_id) = 16),
  community_id BYTEA NOT NULL CHECK (octet_length(community_id) = 16),
  sequence BIGINT NOT NULL CHECK (sequence > 0),
  occurred_at BIGINT NOT NULL CHECK (occurred_at >= 0),
  body BYTEA NOT NULL CHECK (octet_length(body) BETWEEN 1 AND 4096),
  PRIMARY KEY (event_id),
  UNIQUE (community_id, sequence),
  FOREIGN KEY (community_id) REFERENCES bot_event_streams(community_id) ON DELETE CASCADE
);

CREATE TABLE bot_event_acks (
  installation_id BYTEA NOT NULL CHECK (octet_length(installation_id) = 16) REFERENCES bot_installations(id) ON DELETE CASCADE,
  community_id BYTEA NOT NULL CHECK (octet_length(community_id) = 16) REFERENCES bot_event_streams(community_id) ON DELETE CASCADE,
  through_sequence BIGINT NOT NULL CHECK (through_sequence >= 0),
  PRIMARY KEY (installation_id, community_id)
);

-- +goose Down
DROP TABLE bot_event_acks;
DROP TABLE bot_structural_events;
DROP TABLE bot_event_streams;
