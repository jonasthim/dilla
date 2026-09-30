-- +goose Up
-- The body of this section is internal/store/sqlite/schema/007_readable.sql, verbatim.
-- internal/store/schema_test.go asserts that, because sqlc reads the schema directory and
-- goose reads this file: if they drift, sqlc generates against a schema the database does
-- not have.

-- 007_readable.sql: server-readable channel content and its FTS5 index (Plan 2 task 8), migration
-- 00009_readable.sql. The goose StatementBegin/StatementEnd comments around each trigger are part
-- of this file on purpose: every schema file appears verbatim inside its migration
-- (internal/store/schema_test.go), and a trigger body carries semicolons that goose would
-- otherwise split on (`incomplete input`, gap-69 §2.9). sqlc reads them as comments.
--
-- readable_messages has an EXPLICIT INTEGER PRIMARY KEY: plain VACUUM renumbers implicit rowids
-- and silently orphans an external-content FTS index, and integrity-check does not catch it
-- (gap-69 §2.3, measured on SQLite 3.53.4).
--
-- channel_hex is the 32-char lowercase hex of channel_id, written in Go at insert time (P2-D1):
-- FTS5 reads indexed columns back from the content table, so the column the MATCH filters on must
-- exist there. envelope is the deterministic CBOR envelope, never JSON text (P2-D27). body is the
-- only indexed text and is '' once the message is deleted, which takes the row out of the index
-- through the _au trigger while the franking tuple (franking_tag, franking_key_id) survives for
-- the report path. franking_key_id names the instance franking key the tag was made under, so a
-- report verifies after the key rotates.
CREATE TABLE readable_messages (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id      BLOB    NOT NULL CHECK (length(channel_id) = 16)
                          REFERENCES channels(id) ON DELETE CASCADE,
  channel_hex     TEXT    NOT NULL,
  seq             INTEGER NOT NULL,
  sender          BLOB    NOT NULL CHECK (length(sender) = 16),
  envelope        BLOB    NOT NULL,
  body            TEXT    NOT NULL,
  franking_tag    BLOB    NOT NULL CHECK (length(franking_tag) = 32),
  franking_key_id BLOB    NOT NULL CHECK (length(franking_key_id) = 16),
  mention_count   INTEGER NOT NULL DEFAULT 0,
  created         INTEGER NOT NULL,
  edited          INTEGER,
  deleted         INTEGER,
  UNIQUE (channel_id, seq)
) STRICT;
CREATE INDEX readable_messages_by_channel ON readable_messages(channel_id, seq);
-- The slowmode gate's read: this user's latest message in this channel.
CREATE INDEX readable_messages_by_sender ON readable_messages(channel_id, sender, created);

CREATE VIRTUAL TABLE readable_messages_fts USING fts5(
  body,
  channel_hex,
  content='readable_messages',
  content_rowid='id',
  tokenize='unicode61 remove_diacritics 2'
);

-- +goose StatementBegin
CREATE TRIGGER readable_messages_ai AFTER INSERT ON readable_messages BEGIN
  INSERT INTO readable_messages_fts(rowid, body, channel_hex)
  VALUES (new.id, new.body, new.channel_hex);
END;
-- +goose StatementEnd
-- +goose StatementBegin
CREATE TRIGGER readable_messages_ad AFTER DELETE ON readable_messages BEGIN
  INSERT INTO readable_messages_fts(readable_messages_fts, rowid, body, channel_hex)
  VALUES ('delete', old.id, old.body, old.channel_hex);
END;
-- +goose StatementEnd
-- +goose StatementBegin
CREATE TRIGGER readable_messages_au AFTER UPDATE ON readable_messages BEGIN
  INSERT INTO readable_messages_fts(readable_messages_fts, rowid, body, channel_hex)
  VALUES ('delete', old.id, old.body, old.channel_hex);
  INSERT INTO readable_messages_fts(rowid, body, channel_hex)
  VALUES (new.id, new.body, new.channel_hex);
END;
-- +goose StatementEnd

-- read_state is one user's read position in one channel. It only ever moves forward: a stale tab
-- must not un-read a channel.
CREATE TABLE read_state (
  user_id       BLOB    NOT NULL CHECK (length(user_id) = 16)
                        REFERENCES users(id) ON DELETE CASCADE,
  channel_id    BLOB    NOT NULL CHECK (length(channel_id) = 16)
                        REFERENCES channels(id) ON DELETE CASCADE,
  last_read_seq INTEGER NOT NULL,
  PRIMARY KEY (user_id, channel_id)
) STRICT;

-- +goose Down
DROP TABLE read_state;
DROP TRIGGER readable_messages_au;
DROP TRIGGER readable_messages_ad;
DROP TRIGGER readable_messages_ai;
DROP TABLE readable_messages_fts;
DROP INDEX readable_messages_by_sender;
DROP INDEX readable_messages_by_channel;
DROP TABLE readable_messages;
