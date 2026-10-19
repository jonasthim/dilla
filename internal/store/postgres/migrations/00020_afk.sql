-- +goose Up
-- 018_afk.sql: optional per-community silent AFK voice destination.
CREATE TABLE community_afk (
  community_id BYTEA NOT NULL CHECK (octet_length(community_id) = 16)
                     REFERENCES communities(id) ON DELETE CASCADE PRIMARY KEY,
  channel_id BYTEA CHECK (channel_id IS NULL OR octet_length(channel_id) = 16)
               REFERENCES channels(id) ON DELETE SET NULL,
  timeout_seconds BIGINT NOT NULL DEFAULT 300
                  CHECK (timeout_seconds IN (60, 300, 900, 1800, 3600))
);

-- +goose Down
DROP TABLE community_afk;
