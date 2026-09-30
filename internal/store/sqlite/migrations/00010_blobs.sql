-- +goose Up
-- The body of this section is internal/store/sqlite/schema/008_blobs.sql, verbatim.
-- internal/store/schema_test.go asserts that, because sqlc reads the schema directory and
-- goose reads this file: if they drift, sqlc generates against a schema the database does
-- not have.

-- 008_blobs.sql — the content-addressed store's bookkeeping (Plan 2 task 10), migration
-- 00010_blobs.sql. The name sorts after 007_readable.sql, so sqlc reads channels and users before
-- the tables that reference them.
--
-- The reference table is blob_refs; interfaces.md §4.3's `attachments` twin is not created
-- (P2-D2), because no store.Blobs method reads or writes it. A blob is named by the SHA-256 of
-- its ciphertext; storage_ref is derived from that name and the backend (gap-47 §9), never a
-- stored path. A channel never deletes a blob, only its reference; the row goes when the last
-- reference has been gone for blobs.gc_grace (unref_since), and ON DELETE RESTRICT makes the
-- database refuse to drop a row a reference still names.
CREATE TABLE blobs (
  blob_id     BLOB    NOT NULL CHECK (length(blob_id) = 32) PRIMARY KEY,
  size        INTEGER NOT NULL,          -- CIPHERTEXT bytes on disk
  storage_ref TEXT    NOT NULL,          -- derived: "<backend>:att/aa/bb/<hex>"
  created     INTEGER NOT NULL,
  unref_since INTEGER                    -- NULL while referenced
) STRICT;
CREATE INDEX blobs_unref ON blobs(unref_since) WHERE unref_since IS NOT NULL;

-- One row is one channel's publication of one blob. uploader_device carries no foreign key, so a
-- reference survives its device; the quota joins it to devices to find the uploading user.
CREATE TABLE blob_refs (
  blob_id         BLOB    NOT NULL CHECK (length(blob_id) = 32)
                          REFERENCES blobs(blob_id) ON DELETE RESTRICT,
  channel_id      BLOB    NOT NULL CHECK (length(channel_id) = 16)
                          REFERENCES channels(id) ON DELETE CASCADE,
  uploader_device BLOB    NOT NULL CHECK (length(uploader_device) = 16),
  mime            TEXT    NOT NULL DEFAULT '',
  created         INTEGER NOT NULL,
  PRIMARY KEY (blob_id, channel_id)
) STRICT;
CREATE INDEX blob_refs_by_channel ON blob_refs(channel_id, created);
CREATE INDEX blob_refs_by_uploader ON blob_refs(uploader_device);

-- An admin purge's record: a PUT of these bytes is refused 410 E_PRUNED, because content
-- addressing would otherwise hand the purged name straight back to anyone holding the ciphertext.
CREATE TABLE blob_tombstones (
  blob_id BLOB    NOT NULL CHECK (length(blob_id) = 32) PRIMARY KEY,
  reason  TEXT    NOT NULL DEFAULT '',
  by_user BLOB    NOT NULL CHECK (length(by_user) = 16),
  created INTEGER NOT NULL
) STRICT;

-- P2-D32: device_id is NOT NULL with the ALL-ZERO id meaning "not device
-- scoped", rather than §4.3's nullable column. A nullable column inside a
-- PRIMARY KEY behaves differently on the two engines and is wrong on both:
-- PostgreSQL implicitly forces every PK column NOT NULL, so a kind = 0 root
-- backup could not be inserted at all there, while SQLite permits the NULL in a
-- rowid table's PK and therefore does NOT enforce uniqueness, accepting duplicate
-- root rows. The sentinel keeps the composite key and makes both engines agree.
-- §4.5's `backups.device_id` pointer: true override is dropped in the same commit.
CREATE TABLE backups (
  user_id      BLOB    NOT NULL CHECK (length(user_id) = 16)
                       REFERENCES users(id) ON DELETE CASCADE,
  kind         INTEGER NOT NULL CHECK (kind IN (0, 1, 2)),
  device_id    BLOB    NOT NULL CHECK (length(device_id) = 16),
  chunk_seq    INTEGER NOT NULL,
  blob_id      BLOB    NOT NULL CHECK (length(blob_id) = 32),
  manifest_sig BLOB,
  created      INTEGER NOT NULL,
  -- kind 0 (root) and kind 1 (state) are not device scoped and carry the
  -- all-zero id; kind 2 (chunk) carries a real device id.
  CHECK (kind = 2 OR device_id = x'00000000000000000000000000000000'),
  PRIMARY KEY (user_id, kind, device_id, chunk_seq)
) STRICT;

-- +goose Down
-- Children before parents: blob_refs names blobs with ON DELETE RESTRICT.
DROP TABLE backups;
DROP TABLE blob_tombstones;
DROP TABLE blob_refs;
DROP TABLE blobs;
