-- 016_message_class.sql: the upload class of an application message (dilla web3.7 SB1), migration
-- 00018_message_class.sql. 0 is a post (envelope type 0), 1 anything else (types 1-6); NULL is a
-- legacy two-element upload, accepted in web3.7 only: checked for send_messages, never slowed
-- (protocol/02 § Upload class).
ALTER TABLE mls_app_messages ADD COLUMN class INTEGER CHECK (class IS NULL OR class IN (0, 1));
-- slowmode_marks is slow mode's durable mark for end-to-end encrypted posts (web3.7 SB1 fix round
-- 1): the time of a user's last accepted class-0 upload into any text group of a community
-- channel, upserted in the upload's own transaction. Retention never prunes it, so a post the
-- cursor floor deleted still holds the wait; it goes with the channel or the user, as read_state
-- does.
CREATE TABLE slowmode_marks (
  channel_id   BLOB    NOT NULL CHECK (length(channel_id) = 16)
                       REFERENCES channels(id) ON DELETE CASCADE,
  user_id      BLOB    NOT NULL CHECK (length(user_id) = 16)
                       REFERENCES users(id) ON DELETE CASCADE,
  last_post_at INTEGER NOT NULL,
  PRIMARY KEY (channel_id, user_id)
) STRICT;
