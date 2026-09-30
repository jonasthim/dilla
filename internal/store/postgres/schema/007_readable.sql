-- 007_readable.sql: the SQLite file with interfaces.md §4.2's substitutions (BLOB -> BYTEA with
-- octet_length, INTEGER -> BIGINT, no STRICT suffix) and §4.4 B's full-text divergence, migration
-- 00009_readable.sql.
--
-- The extensions and the configuration come first. dilla_simple is `simple` plus the unaccent
-- DICTIONARY: calling unaccent() in the generated column is refused as non-immutable (gap-69 §3.4),
-- and only the two-argument to_tsvector may appear there, because the one-argument form depends
-- on default_text_search_config. The token-type list is P2-D29: the simple parser emits asciiword,
-- not word, for unaccented ASCII, so §4.4 B's three types would leave most text unmapped. Both
-- extensions are trusted on 18.6 and a plain database owner installs them (gap-69 §3.7); a server
-- that refuses fails this migration loudly rather than degrading search.
--
-- body_tsv is the index's only input and is never selected; the composite GIN over
-- (channel_id, body_tsv) through btree_gin is 7x faster than a BitmapAnd over two indexes
-- (gap-69 §3.3). franking_key_id names the instance franking key the tag was made under.
CREATE EXTENSION IF NOT EXISTS unaccent;
CREATE EXTENSION IF NOT EXISTS btree_gin;
CREATE TEXT SEARCH CONFIGURATION dilla_simple (COPY = pg_catalog.simple);
ALTER TEXT SEARCH CONFIGURATION dilla_simple
  ALTER MAPPING FOR hword, hword_part, word, asciiword, asciihword, hword_asciipart,
                    numword, numhword, hword_numpart, email, url, url_path, host, file,
                    sfloat, float, int, uint, version
  WITH unaccent, simple;

CREATE TABLE readable_messages (
  id              BIGINT GENERATED ALWAYS AS IDENTITY,
  channel_id      BYTEA  NOT NULL CHECK (octet_length(channel_id) = 16)
                         REFERENCES channels(id) ON DELETE CASCADE,
  channel_hex     TEXT   NOT NULL,
  seq             BIGINT NOT NULL,
  sender          BYTEA  NOT NULL CHECK (octet_length(sender) = 16),
  envelope        BYTEA  NOT NULL,
  body            TEXT   NOT NULL,
  franking_tag    BYTEA  NOT NULL CHECK (octet_length(franking_tag) = 32),
  franking_key_id BYTEA  NOT NULL CHECK (octet_length(franking_key_id) = 16),
  mention_count   BIGINT NOT NULL DEFAULT 0,
  created         BIGINT NOT NULL,
  edited          BIGINT,
  deleted         BIGINT,
  body_tsv        TSVECTOR GENERATED ALWAYS AS (to_tsvector('dilla_simple', body)) STORED,
  PRIMARY KEY (id),
  UNIQUE (channel_id, seq)
);
CREATE INDEX readable_messages_by_channel ON readable_messages(channel_id, seq);
-- The slowmode gate's read: this user's latest message in this channel.
CREATE INDEX readable_messages_by_sender ON readable_messages(channel_id, sender, created);
CREATE INDEX readable_messages_fts ON readable_messages USING gin (channel_id, body_tsv);

-- read_state is one user's read position in one channel. It only ever moves forward: a stale tab
-- must not un-read a channel.
CREATE TABLE read_state (
  user_id       BYTEA  NOT NULL CHECK (octet_length(user_id) = 16)
                       REFERENCES users(id) ON DELETE CASCADE,
  channel_id    BYTEA  NOT NULL CHECK (octet_length(channel_id) = 16)
                       REFERENCES channels(id) ON DELETE CASCADE,
  last_read_seq BIGINT NOT NULL,
  PRIMARY KEY (user_id, channel_id)
);
