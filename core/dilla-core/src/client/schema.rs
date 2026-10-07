//! App schema and metadata operations.

use crate::cbor::decode_strict;
use crate::mls::{DillaStorage, StorageError, TxError};
use rusqlite::OptionalExtension;

/// Rows of `app_handshake_tail` kept per group; the oldest are deleted in the inserting unit.
pub const HANDSHAKE_TAIL: usize = 64;

pub(crate) const SCHEMA: &str = "schema";
pub(crate) const SIGNUP: &str = "signup";
pub(crate) const IDENTITY: &str = "identity";
pub(crate) const ENROL: &str = "enrol";
pub(crate) const SESSION: &str = "session";
pub(crate) const ROOT_SEALED: &str = "root_sealed";
pub(crate) const STATE_SEALED: &str = "state_sealed";
/// The version of the device list inside `state_sealed`, as a CBOR uint, written with it
/// (BACKUPS-RECOVERY-03): the browser cannot open its own state object to read it back.
pub(crate) const STATE_LIST: &str = "state_list";

/// App schema v2 column meanings (L-SQL-10, L-SQL-20):
///
/// - `app_groups.state`: 0 registering, 1 joining, 2 active, 3 needs_resync, 4 gone.
/// - `app_groups.next_seq`: every delivery-service seq below it is applied or skipped.
/// - `app_groups.resync`: 1 while a state-1 row is joining over a local group that was in state 2 or 3.
/// - `app_groups.was_gone`: 1 while a state-1 row is joining over a row that was gone (state 4);
///   `group_discard` returns such a row to state 4 with its history. A state-1 row with both 0 was
///   created by its join, and discard deletes it.
/// - `app_groups.max_epoch`: the highest epoch this device has held for the group id, only ever
///   raised, and written when the epoch is reached: by every commit merged in `group_apply` and
///   `commit_confirm` (the new epoch), by `group_joined` (the epoch the accepted external commit
///   opened) and by `welcomes_apply` (the joined epoch, which must equal the served label). These
///   are every epoch change of a stored group, so deleting a group (removal, resync, discard)
///   needs no write of its own. Over an existing row a Welcome into an epoch at or below the floor
///   (`max(max_epoch, stored group's epoch)`) is refused, and so is a GroupInfo below it (its join
///   would land at or below it); `E_CORE_INPUT`.
/// - `app_groups.epoch`: the MLS epoch of the stored group, 0 when none is stored, written by
///   every writer of L-CORE-21 in the unit that changes it (a join that is not yet accepted
///   writes it, unlike `max_epoch`).
/// - `app_groups.pending_commit`: 1 while this device holds a commit it built and has neither
///   confirmed, merged nor cleared, else 0.
/// - `app_messages.status`: 0 ok, 1 cannot_decrypt, 2 deleted.
/// - `app_messages.sender_user` (and `sender_leaf`, `sender_kind`, `sender_tier`, `msg_id`,
///   `type`): set on a status-0 row (`sender_leaf` NULL when `send_confirm` found no stored group);
///   NULL on a status-1 row. A status-2 row keeps the values of
///   the row it cleared (set if that row was status 0), or, inserted by rule 2 for a seq not
///   stored before, has them NULL, except the deleted marker of this device's own upload adopted
///   from the outbox, which carries this device's identity, `msg_id` and `type`.
/// - `app_messages.sender_device`: status 0, and a status-2 row that cleared one: the MLS
///   credential's device; otherwise the DS uploader_device.
/// - `app_messages.envelope`: the envelope CBOR (with k_f) of an ok row; NULL otherwise.
/// - `app_messages.mention`: 1 on a status-0 type-0 row from another user (by `sender_user`,
///   ruling 29: the own user's other devices are excluded too) whose body `mentions_me`, else 0.
/// - `app_outbox.state`: 0 queued, 1 in_flight, 2 failed.
/// - `app_outbox.epoch`: the epoch send_encrypt framed the message in; read by send_confirm.
/// - `app_read_state`: the device-local read marker of a group, never lowered.
/// - `app_settings`: device-local settings.
///
/// The three v2 columns carry no CHECK (Rust writes only 0 and 1 to `pending_commit` and
/// `mention`), so a fresh v2 store and one migrated from v1 have the same columns. `APP_SCHEMA`
/// runs on a v1 store before `MIGRATE_V1_TO_V2`, so it creates no index that names a v2 column.
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
  was_gone     INTEGER NOT NULL DEFAULT 0 CHECK (was_gone IN (0, 1)),
  max_epoch    INTEGER NOT NULL DEFAULT 0,
  epoch          INTEGER NOT NULL DEFAULT 0,
  pending_commit INTEGER NOT NULL DEFAULT 0
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
  mention       INTEGER NOT NULL DEFAULT 0,
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
CREATE TABLE IF NOT EXISTS app_read_state (
  group_id      BLOB    PRIMARY KEY CHECK (length(group_id) = 16),
  last_read_seq INTEGER NOT NULL DEFAULT 0,
  last_read_at  INTEGER NOT NULL DEFAULT 0
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS app_settings (k TEXT PRIMARY KEY, v TEXT NOT NULL) WITHOUT ROWID;
INSERT OR IGNORE INTO app_meta (k, v) VALUES ('schema', x'02');
";

/// L-SQL-20, run on a v1 store only, after `APP_SCHEMA`; the backfill follows in the same unit.
const MIGRATE_V1_TO_V2: &str = "
ALTER TABLE app_groups   ADD COLUMN epoch          INTEGER NOT NULL DEFAULT 0;
ALTER TABLE app_groups   ADD COLUMN pending_commit INTEGER NOT NULL DEFAULT 0;
ALTER TABLE app_messages ADD COLUMN mention        INTEGER NOT NULL DEFAULT 0;
CREATE TABLE IF NOT EXISTS app_read_state (
  group_id      BLOB    PRIMARY KEY CHECK (length(group_id) = 16),
  last_read_seq INTEGER NOT NULL DEFAULT 0,
  last_read_at  INTEGER NOT NULL DEFAULT 0
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS app_settings (k TEXT PRIMARY KEY, v TEXT NOT NULL) WITHOUT ROWID;
UPDATE app_meta SET v = x'02' WHERE k = 'schema';
";

/// Runs `APP_SCHEMA`, reads app_meta `schema`, and when it is 1 runs `MIGRATE_V1_TO_V2`. Returns
/// the value it found (before migrating). The caller's unit runs the backfill after a 1.
pub(crate) fn migrate_conn(c: &rusqlite::Connection) -> Result<u64, StorageError> {
    c.execute_batch(APP_SCHEMA)?;
    let bytes = meta_get(c, SCHEMA)?
        .ok_or_else(|| StorageError::Codec("app_meta schema is malformed".into()))?;
    let found = decode_strict(&bytes, |d| d.uint())
        .map_err(|_| StorageError::Codec("app_meta schema is malformed".into()))?;
    if found == 1 {
        c.execute_batch(MIGRATE_V1_TO_V2)?;
    }
    Ok(found)
}

/// Runs APP_SCHEMA, reads app_meta `schema`, and when it is 1 runs MIGRATE_V1_TO_V2 and the
/// backfill in the same unit. Returns the value it found: 1 (migrated now), 2 (current; a fresh
/// store reads 2), or a value above 2, returned unchanged and not migrated.
///
/// The backfill runs here as in `ClientCore::open` (pre-flight ruling (a)): a v1 store must never
/// end at schema 2 with a v1 identity record, which `open` would then refuse for ever. It loads
/// the stored groups through `storage` itself. `open` does not call this (units do not nest).
pub fn migrate_app(storage: &DillaStorage) -> Result<u64, StorageError> {
    storage
        .unit(|u| {
            let found = u.with_conn(migrate_conn)?;
            if found == 1 {
                super::backfill(storage, u)?;
            }
            Ok(found)
        })
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
