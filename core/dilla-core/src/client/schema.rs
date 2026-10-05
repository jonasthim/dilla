//! App schema and metadata operations.

use crate::mls::{DillaStorage, StorageError, TxError};
use rusqlite::OptionalExtension;

/// Rows of `app_handshake_tail` kept per group; the oldest are deleted in the inserting unit.
pub const HANDSHAKE_TAIL: usize = 64;

pub(crate) const SCHEMA: &str = "schema";
pub(crate) const SIGNUP: &str = "signup";
pub(crate) const IDENTITY: &str = "identity";
pub(crate) const SESSION: &str = "session";
pub(crate) const ROOT_SEALED: &str = "root_sealed";
pub(crate) const STATE_SEALED: &str = "state_sealed";

/// App schema v1 column meanings (L-SQL-10):
///
/// - `app_groups.state`: 0 registering, 1 joining, 2 active, 3 needs_resync, 4 gone.
/// - `app_groups.next_seq`: every delivery-service seq below it is applied or skipped.
/// - `app_groups.resync`: 1 while a state-1 row is joining over a local group that was in state 2 or 3.
/// - `app_groups.was_gone`: 1 while a state-1 row is joining over a row that was gone (state 4);
///   `group_discard` returns such a row to state 4 with its history. A state-1 row with both 0 was
///   created by its join, and discard deletes it.
/// - `app_messages.status`: 0 ok, 1 cannot_decrypt, 2 deleted.
/// - `app_messages.sender_user`: NULL unless status = 0.
/// - `app_messages.sender_device`: status 0: the MLS credential's device; else the DS uploader_device.
/// - `app_messages.envelope`: the envelope CBOR (with k_f) of an ok row; NULL otherwise.
/// - `app_outbox.state`: 0 queued, 1 in_flight, 2 failed.
/// - `app_outbox.epoch`: the epoch send_encrypt framed the message in; read by send_confirm.
const APP_SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS app_meta (k TEXT PRIMARY KEY, v BLOB NOT NULL) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS app_groups (
  group_id     BLOB    PRIMARY KEY CHECK (length(group_id) = 16),
  kind         INTEGER NOT NULL,
  community_id BLOB    CHECK (community_id IS NULL OR length(community_id) = 16),
  target_id    BLOB    NOT NULL CHECK (length(target_id) = 16),
  state        INTEGER NOT NULL,
  next_seq     INTEGER NOT NULL DEFAULT 1,
  acked_seq    INTEGER NOT NULL DEFAULT 0,
  acked_epoch  INTEGER NOT NULL DEFAULT 0,
  resync       INTEGER NOT NULL DEFAULT 0 CHECK (resync IN (0, 1)),
  was_gone     INTEGER NOT NULL DEFAULT 0 CHECK (was_gone IN (0, 1))
) WITHOUT ROWID;
CREATE UNIQUE INDEX IF NOT EXISTS app_groups_by_target ON app_groups (target_id, kind) WHERE state <> 4;
CREATE TABLE IF NOT EXISTS app_handshake_tail (
  group_id BLOB NOT NULL, seq INTEGER NOT NULL, epoch INTEGER NOT NULL, kind INTEGER NOT NULL,
  sender INTEGER, blob BLOB NOT NULL, PRIMARY KEY (group_id, seq)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS app_proposals (
  group_id BLOB NOT NULL, ref BLOB NOT NULL, epoch INTEGER NOT NULL, PRIMARY KEY (group_id, ref)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS app_messages (
  group_id      BLOB    NOT NULL,
  seq           INTEGER NOT NULL,
  epoch         INTEGER NOT NULL,
  recv_ts       INTEGER NOT NULL,
  status        INTEGER NOT NULL,
  reason        TEXT    NOT NULL DEFAULT '',
  sender_user   BLOB,
  sender_device BLOB    NOT NULL,
  sender_leaf   INTEGER,
  sender_kind   INTEGER,
  sender_tier   INTEGER,
  msg_id        BLOB,
  type          INTEGER,
  body          TEXT    NOT NULL DEFAULT '',
  envelope      BLOB,
  franking_tag  BLOB    NOT NULL,
  PRIMARY KEY (group_id, seq)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS app_messages_by_msg ON app_messages (group_id, msg_id);
CREATE TABLE IF NOT EXISTS app_outbox (
  msg_id   BLOB    PRIMARY KEY CHECK (length(msg_id) = 16),
  group_id BLOB    NOT NULL,
  envelope BLOB    NOT NULL,
  created  INTEGER NOT NULL,
  state    INTEGER NOT NULL,
  error    TEXT    NOT NULL DEFAULT '',
  epoch    INTEGER NOT NULL DEFAULT 0
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS app_outbox_by_group ON app_outbox (group_id, created, msg_id);
INSERT OR IGNORE INTO app_meta (k, v) VALUES ('schema', x'01');
";

pub fn migrate_app(storage: &DillaStorage) -> Result<(), StorageError> {
    storage
        .unit(|u| u.with_conn(|c| c.execute_batch(APP_SCHEMA).map_err(StorageError::from)))
        .map_err(|e| match e {
            TxError::RolledBack(e) => e,
            other => StorageError::Sqlite(other.to_string()),
        })
}

pub(crate) fn meta_get(c: &rusqlite::Connection, k: &str) -> Result<Option<Vec<u8>>, StorageError> {
    c.query_row("SELECT v FROM app_meta WHERE k = ?1", [k], |r| r.get(0))
        .optional()
        .map_err(Into::into)
}
pub(crate) fn meta_put(c: &rusqlite::Connection, k: &str, v: &[u8]) -> Result<(), StorageError> {
    c.execute(
        "INSERT INTO app_meta (k, v) VALUES (?1, ?2) ON CONFLICT (k) DO UPDATE SET v = excluded.v",
        rusqlite::params![k, v],
    )?;
    Ok(())
}
pub(crate) fn meta_del(c: &rusqlite::Connection, k: &str) -> Result<(), StorageError> {
    c.execute("DELETE FROM app_meta WHERE k = ?1", [k])?;
    Ok(())
}
