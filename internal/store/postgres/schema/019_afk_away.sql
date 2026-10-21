-- 019_afk_away.sql: the stored away roster, one row per (community, user) that is in the AFK
-- channel and so has no voice connection (afk-disconnect AW1, R-AW2, R-AW5). since is the unix
-- time the user went away; a second mark keeps the first (R-AW7), and 0 is op 55's "cleared", so
-- a stored row is always later. Leaving the community, a kick or a ban drop the row by cascade
-- from members (R-AW4). community_afk_away_by_user serves ClearAFKAwayUser, which the primary
-- key (community first) does not.
CREATE TABLE community_afk_away (
  community_id BYTEA NOT NULL CHECK (octet_length(community_id) = 16),
  user_id      BYTEA NOT NULL CHECK (octet_length(user_id) = 16),
  since        BIGINT NOT NULL CHECK (since > 0),
  PRIMARY KEY (community_id, user_id),
  FOREIGN KEY (community_id, user_id) REFERENCES members (community_id, user_id) ON DELETE CASCADE
);

CREATE INDEX community_afk_away_by_user ON community_afk_away (user_id, community_id);
