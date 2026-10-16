-- 016_message_class.sql: the upload class of an application message (dilla web3.7 SB1), migration
-- 00018_message_class.sql. 0 is a post (envelope type 0), 1 anything else (types 1-6); NULL is a
-- legacy two-element upload, accepted in web3.7 only: checked for send_messages, never slowed
-- (protocol/02 § Upload class).
ALTER TABLE mls_app_messages ADD COLUMN class INTEGER CHECK (class IS NULL OR class IN (0, 1));
CREATE INDEX mls_app_messages_by_class ON mls_app_messages(group_id, class, uploader_device, created);
