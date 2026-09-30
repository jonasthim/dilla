-- 006c_bans.sql: bans (Plan 2 task 4), migration 00007_bans.sql. A file of its own for the
-- reason 006a_channels.sql gives: every schema file appears verbatim inside exactly one
-- migration. The name sorts after 006_structure.sql, so sqlc reads communities before the
-- table that references it.
--
-- One row is one user's ban from one community. expires is NULL for a ban that stands until
-- it is lifted; a row whose expires has passed stays (a moderator sees the history) but no
-- longer gates a join. by_user is the moderator and carries no foreign key, so the row
-- survives that account.
CREATE TABLE bans (
  community_id BLOB    NOT NULL CHECK (length(community_id) = 16)
                       REFERENCES communities(id) ON DELETE CASCADE,
  user_id      BLOB    NOT NULL CHECK (length(user_id) = 16)
                       REFERENCES users(id) ON DELETE CASCADE,
  reason       TEXT    NOT NULL DEFAULT '',
  by_user      BLOB    NOT NULL CHECK (length(by_user) = 16),
  created      INTEGER NOT NULL,
  expires      INTEGER,
  PRIMARY KEY (community_id, user_id)
) STRICT;
