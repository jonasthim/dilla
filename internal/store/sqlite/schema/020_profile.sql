-- 020_profile.sql: a status message and a bio on the account (EOD E6), migration 00022_profile.sql.
-- Both are stored readable by the server, like the display name (R4); '' is none. The limits count
-- characters, not bytes: 190 for the status message, 500 for the bio.
ALTER TABLE users ADD COLUMN status_msg TEXT NOT NULL DEFAULT '' CHECK (length(status_msg) <= 190);
ALTER TABLE users ADD COLUMN bio TEXT NOT NULL DEFAULT '' CHECK (length(bio) <= 500);
