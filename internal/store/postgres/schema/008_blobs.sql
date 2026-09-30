-- 008_blobs.sql: the SQLite file with interfaces.md §4.2's substitutions (BLOB -> BYTEA with
-- octet_length, INTEGER -> BIGINT, an enum -> SMALLINT, no STRICT suffix), migration
-- 00010_blobs.sql (Plan 2 task 10).
--
-- The reference table is blob_refs; interfaces.md §4.3's `attachments` twin is not created
-- (P2-D2). storage_ref is derived from blob_id and the backend (gap-47 §9), never a stored path,
-- and ON DELETE RESTRICT makes the database refuse to drop a blob a reference still names.
CREATE TABLE blobs (
  blob_id     BYTEA  NOT NULL CHECK (octet_length(blob_id) = 32) PRIMARY KEY,
  size        BIGINT NOT NULL,           -- CIPHERTEXT bytes on disk
  storage_ref TEXT   NOT NULL,           -- derived: "<backend>:att/aa/bb/<hex>"
  created     BIGINT NOT NULL,
  unref_since BIGINT                     -- NULL while referenced
);
CREATE INDEX blobs_unref ON blobs(unref_since) WHERE unref_since IS NOT NULL;

-- One row is one channel's publication of one blob. uploader_device carries no foreign key, so a
-- reference survives its device; the quota joins it to devices to find the uploading user.
CREATE TABLE blob_refs (
  blob_id         BYTEA  NOT NULL CHECK (octet_length(blob_id) = 32)
                         REFERENCES blobs(blob_id) ON DELETE RESTRICT,
  channel_id      BYTEA  NOT NULL CHECK (octet_length(channel_id) = 16)
                         REFERENCES channels(id) ON DELETE CASCADE,
  uploader_device BYTEA  NOT NULL CHECK (octet_length(uploader_device) = 16),
  mime            TEXT   NOT NULL DEFAULT '',
  created         BIGINT NOT NULL,
  PRIMARY KEY (blob_id, channel_id)
);
CREATE INDEX blob_refs_by_channel ON blob_refs(channel_id, created);
CREATE INDEX blob_refs_by_uploader ON blob_refs(uploader_device);

-- An admin purge's record: a PUT of these bytes is refused 410 E_PRUNED.
CREATE TABLE blob_tombstones (
  blob_id BYTEA  NOT NULL CHECK (octet_length(blob_id) = 32) PRIMARY KEY,
  reason  TEXT   NOT NULL DEFAULT '',
  by_user BYTEA  NOT NULL CHECK (octet_length(by_user) = 16),
  created BIGINT NOT NULL
);

-- P2-D32: device_id is NOT NULL with the all-zero id meaning "not device scoped". PostgreSQL
-- forces every PRIMARY KEY column NOT NULL, so §4.3's nullable column would refuse every kind 0
-- root backup here; the sentinel keeps the composite key on both engines.
CREATE TABLE backups (
  user_id      BYTEA    NOT NULL CHECK (octet_length(user_id) = 16)
                        REFERENCES users(id) ON DELETE CASCADE,
  kind         SMALLINT NOT NULL CHECK (kind IN (0, 1, 2)),
  device_id    BYTEA    NOT NULL CHECK (octet_length(device_id) = 16),
  chunk_seq    BIGINT   NOT NULL,
  blob_id      BYTEA    NOT NULL CHECK (octet_length(blob_id) = 32),
  manifest_sig BYTEA,
  created      BIGINT   NOT NULL,
  -- kind 0 (root) and kind 1 (state) are not device scoped and carry the
  -- all-zero id; kind 2 (chunk) carries a real device id.
  CHECK (kind = 2 OR device_id = decode('00000000000000000000000000000000', 'hex')),
  PRIMARY KEY (user_id, kind, device_id, chunk_seq)
);
