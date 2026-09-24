//! dilla's own `StorageProvider` over rusqlite.
//!
//! `openmls_sqlite_storage 0.3.0` is a reference, not a dependency: it pins rusqlite 0.37 and its
//! crate documentation states it does not support `wasm32`. The schema below is the same shape as
//! its `V1__initial.sql`, so its table layout can be read across.
//!
//! Every method takes `&self`, so the connection lives behind a `Mutex` natively and a `RefCell`
//! on `wasm32`. There is no transaction hook on the trait: dilla wraps `BEGIN IMMEDIATE` around
//! the OpenMLS call from outside, in `DillaStorage::transaction` (see `tx.rs`).

use super::{CborCodec, DillaCodec, StorageError};
use openmls_traits::storage::{CURRENT_VERSION, StorageProvider, traits};
use serde::{Serialize, de::DeserializeOwned};

// These two cfgs are exactly the two dependency sections that declare `rusqlite` (task 1 step 5,
// rule 1): native, and wasm32 with `target_os = "unknown"`. A bare `#[cfg(target_arch = "wasm32")]`
// is also true on `wasm32-wasip1`, where `target_os = "wasi"` and **no** `rusqlite` is in the graph
// — it would expand to `Rc<RefCell<rusqlite::Connection>>` and fail with
// `error[E0433]: failed to resolve: use of undeclared crate or module rusqlite`. The whole SQLite
// half of `mls` is compiled out on wasi; see `mls/mod.rs`.
//
// **Ownership invariant — read before cloning one of these.** A SQLite transaction is a property
// of the *connection*, not of the statement that opened it, but `DillaStorage` takes and releases
// the lock once per method call, not for the length of a transaction. So: exactly one
// `DillaStorage` may use a given `ConnHandle`, and while that storage has a transaction open
// (`DillaStorage::transaction`) nothing else may touch the handle. A second writer that slips in
// between `BEGIN IMMEDIATE` and `COMMIT` has its writes silently enrolled in — and, if the
// transaction fails, silently rolled back with — someone else's transaction. `DillaStorage` guards
// against a second `transaction()` on *itself* (`TxError::AlreadyOpen`); it cannot see a second
// `DillaStorage` built over a clone of the same handle, and that is the caller's job not to do.
// `DillaProvider::new` takes the handle by value for this reason: hand the clone to the provider
// and keep no copy.
#[cfg(not(target_arch = "wasm32"))]
pub type ConnHandle = std::sync::Arc<std::sync::Mutex<rusqlite::Connection>>;
#[cfg(all(target_arch = "wasm32", target_os = "unknown"))]
pub type ConnHandle = std::rc::Rc<core::cell::RefCell<rusqlite::Connection>>;

const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS openmls_group_data (
    provider_version INTEGER NOT NULL,
    group_id BLOB NOT NULL,
    data_type TEXT NOT NULL CHECK (data_type IN (
        'join_group_config','tree','interim_transcript_hash','context','confirmation_tag',
        'group_state','message_secrets','resumption_psk_store','own_leaf_index',
        'group_epoch_secrets')),
    group_data BLOB NOT NULL,
    PRIMARY KEY (group_id, data_type)
);
CREATE TABLE IF NOT EXISTS openmls_proposals (
    provider_version INTEGER NOT NULL,
    group_id BLOB NOT NULL, proposal_ref BLOB NOT NULL, proposal BLOB NOT NULL,
    PRIMARY KEY (group_id, proposal_ref)
);
CREATE TABLE IF NOT EXISTS openmls_own_leaf_nodes (
    provider_version INTEGER NOT NULL,
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    group_id BLOB NOT NULL, leaf_node BLOB NOT NULL
);
CREATE TABLE IF NOT EXISTS openmls_epoch_key_pairs (
    provider_version INTEGER NOT NULL,
    group_id BLOB NOT NULL, epoch_id BLOB NOT NULL, leaf_index INTEGER NOT NULL,
    key_pairs BLOB NOT NULL,
    PRIMARY KEY (group_id, epoch_id, leaf_index)
);
CREATE TABLE IF NOT EXISTS openmls_signature_keys (
    provider_version INTEGER NOT NULL, public_key BLOB PRIMARY KEY, signature_key BLOB NOT NULL
);
CREATE TABLE IF NOT EXISTS openmls_encryption_keys (
    provider_version INTEGER NOT NULL, public_key BLOB PRIMARY KEY, key_pair BLOB NOT NULL
);
CREATE TABLE IF NOT EXISTS openmls_key_packages (
    provider_version INTEGER NOT NULL, key_package_ref BLOB PRIMARY KEY, key_package BLOB NOT NULL
);
CREATE TABLE IF NOT EXISTS openmls_psks (
    provider_version INTEGER NOT NULL, psk_id BLOB PRIMARY KEY, psk_bundle BLOB NOT NULL
);
CREATE TABLE IF NOT EXISTS storage_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
";

pub struct DillaStorage {
    conn: ConnHandle,
    /// Set for the length of a `DillaStorage::transaction`, so a second (nested or concurrent)
    /// `transaction()` on this storage is refused with `TxError::AlreadyOpen` instead of falling
    /// through to SQLite's "cannot start a transaction within a transaction". See the ownership
    /// invariant on `ConnHandle` for what this flag cannot see.
    in_tx: core::sync::atomic::AtomicBool,
}

impl From<rusqlite::Error> for StorageError {
    fn from(e: rusqlite::Error) -> Self {
        StorageError::Sqlite(e.to_string())
    }
}

#[cfg(not(target_arch = "wasm32"))]
fn with_conn<T>(
    handle: &ConnHandle,
    f: impl FnOnce(&rusqlite::Connection) -> Result<T, StorageError>,
) -> Result<T, StorageError> {
    let guard = handle.lock().map_err(|_| StorageError::Poisoned)?;
    f(&guard)
}

#[cfg(all(target_arch = "wasm32", target_os = "unknown"))]
fn with_conn<T>(
    handle: &ConnHandle,
    f: impl FnOnce(&rusqlite::Connection) -> Result<T, StorageError>,
) -> Result<T, StorageError> {
    let guard = handle.try_borrow().map_err(|_| StorageError::Poisoned)?;
    f(&guard)
}

impl DillaStorage {
    pub fn new(conn: ConnHandle) -> Self {
        Self {
            conn,
            in_tx: core::sync::atomic::AtomicBool::new(false),
        }
    }

    /// Claims this storage's transaction slot, or returns `false` if one is already open. Paired
    /// with `leave_tx`, which `tx.rs`'s RAII guard calls on every exit path including an unwind.
    pub(crate) fn try_enter_tx(&self) -> bool {
        use core::sync::atomic::Ordering;
        self.in_tx
            .compare_exchange(false, true, Ordering::Acquire, Ordering::Relaxed)
            .is_ok()
    }

    pub(crate) fn leave_tx(&self) {
        self.in_tx
            .store(false, core::sync::atomic::Ordering::Release);
    }

    pub fn conn(&self) -> &ConnHandle {
        &self.conn
    }

    /// The `storage_provider_version` this build writes and can read.
    pub const PROVIDER_VERSION: &'static str = "1";
    /// The serde codec this build's `StorageProvider` blobs are encoded with (`CborCodec`).
    pub const CODEC: &'static str = "cbor";

    /// Creates every table if absent, seeds `storage_meta`, and then **checks it**. Idempotent.
    ///
    /// The seed is `INSERT OR IGNORE`, so a file written by another build keeps its own
    /// `storage_provider_version` and `codec` and the seed says nothing. Reading the values back
    /// afterwards is what turns that into a refusal: every `openmls_*` blob is shaped by the
    /// provider version and encoded by the codec, so continuing would decode another build's
    /// bytes with this build's expectations - which a self-describing codec reports as a `Codec`
    /// error somewhere deep in a later reload (gap-6 section 2.3), or, worse, does not report at
    /// all. `openmls_version` is deliberately *not* checked: it is a provenance note, and OpenMLS
    /// patch releases do not change the blob layout the way this provider's own version would.
    pub fn migrate(&self) -> Result<(), StorageError> {
        with_conn(&self.conn, |c| {
            c.execute_batch(SCHEMA)?;
            let mut stmt =
                c.prepare("INSERT OR IGNORE INTO storage_meta (key, value) VALUES (?1, ?2)")?;
            stmt.execute(rusqlite::params!["openmls_version", "0.9.0"])?;
            stmt.execute(rusqlite::params![
                "storage_provider_version",
                Self::PROVIDER_VERSION
            ])?;
            stmt.execute(rusqlite::params!["codec", Self::CODEC])?;
            drop(stmt);

            let mut read = c.prepare("SELECT value FROM storage_meta WHERE key = ?1")?;
            let mut get = |key: &str| -> Result<String, StorageError> {
                let mut rows = read.query(rusqlite::params![key])?;
                match rows.next()? {
                    // An absent row cannot happen right after the seed above, but it is a
                    // mismatch rather than a default: the alternative is treating a file whose
                    // meta row someone deleted as if it were ours.
                    None => Ok(String::new()),
                    Some(row) => Ok(row.get::<_, String>(0)?),
                }
            };
            let version = get("storage_provider_version")?;
            let codec = get("codec")?;
            if version != Self::PROVIDER_VERSION || codec != Self::CODEC {
                return Err(StorageError::UnsupportedStorage { version, codec });
            }
            Ok(())
        })
    }

    pub fn storage_meta(&self, key: &str) -> Result<Option<String>, StorageError> {
        with_conn(&self.conn, |c| {
            let mut stmt = c.prepare("SELECT value FROM storage_meta WHERE key = ?1")?;
            let mut rows = stmt.query(rusqlite::params![key])?;
            match rows.next()? {
                Some(row) => Ok(Some(row.get::<_, String>(0)?)),
                None => Ok(None),
            }
        })
    }

    /// Runs one statement batch outside any helper. Used by `tx.rs` for `BEGIN IMMEDIATE`,
    /// `COMMIT` and `ROLLBACK`, which are not expressible through the entity helpers.
    pub(crate) fn exec(&self, sql: &str) -> Result<(), StorageError> {
        with_conn(&self.conn, |c| {
            c.execute_batch(sql)?;
            Ok(())
        })
    }

    fn enc<T: Serialize>(value: &T) -> Result<Vec<u8>, StorageError> {
        CborCodec::to_vec(value).map_err(|e| StorageError::Codec(e.to_string()))
    }

    fn dec<T: DeserializeOwned>(bytes: &[u8]) -> Result<T, StorageError> {
        CborCodec::from_slice(bytes).map_err(|e| StorageError::Codec(e.to_string()))
    }

    fn put_group_data<K: Serialize, V: Serialize>(
        &self,
        group_id: &K,
        data_type: &str,
        value: &V,
    ) -> Result<(), StorageError> {
        let (g, v) = (Self::enc(group_id)?, Self::enc(value)?);
        with_conn(&self.conn, |c| {
            c.execute(
                "INSERT INTO openmls_group_data (provider_version, group_id, data_type, group_data)
                 VALUES (1, ?1, ?2, ?3)
                 ON CONFLICT (group_id, data_type) DO UPDATE SET group_data = excluded.group_data",
                rusqlite::params![g, data_type, v],
            )?;
            Ok(())
        })
    }

    fn get_group_data<K: Serialize, V: DeserializeOwned>(
        &self,
        group_id: &K,
        data_type: &str,
    ) -> Result<Option<V>, StorageError> {
        let g = Self::enc(group_id)?;
        let raw: Option<Vec<u8>> = with_conn(&self.conn, |c| {
            let mut stmt = c.prepare(
                "SELECT group_data FROM openmls_group_data WHERE group_id = ?1 AND data_type = ?2",
            )?;
            let mut rows = stmt.query(rusqlite::params![g, data_type])?;
            match rows.next()? {
                Some(row) => Ok(Some(row.get::<_, Vec<u8>>(0)?)),
                None => Ok(None),
            }
        })?;
        raw.map(|b| Self::dec(&b)).transpose()
    }

    fn del_group_data<K: Serialize>(
        &self,
        group_id: &K,
        data_type: &str,
    ) -> Result<(), StorageError> {
        let g = Self::enc(group_id)?;
        with_conn(&self.conn, |c| {
            c.execute(
                "DELETE FROM openmls_group_data WHERE group_id = ?1 AND data_type = ?2",
                rusqlite::params![g, data_type],
            )?;
            Ok(())
        })
    }

    fn put_keyed<K: Serialize, V: Serialize>(
        &self,
        sql: &str,
        key: &K,
        value: &V,
    ) -> Result<(), StorageError> {
        let (k, v) = (Self::enc(key)?, Self::enc(value)?);
        with_conn(&self.conn, |c| {
            c.execute(sql, rusqlite::params![k, v])?;
            Ok(())
        })
    }

    fn get_keyed<K: Serialize, V: DeserializeOwned>(
        &self,
        sql: &str,
        key: &K,
    ) -> Result<Option<V>, StorageError> {
        let k = Self::enc(key)?;
        let raw: Option<Vec<u8>> = with_conn(&self.conn, |c| {
            let mut stmt = c.prepare(sql)?;
            let mut rows = stmt.query(rusqlite::params![k])?;
            match rows.next()? {
                Some(row) => Ok(Some(row.get::<_, Vec<u8>>(0)?)),
                None => Ok(None),
            }
        })?;
        raw.map(|b| Self::dec(&b)).transpose()
    }

    fn del_keyed<K: Serialize>(&self, sql: &str, key: &K) -> Result<(), StorageError> {
        let k = Self::enc(key)?;
        with_conn(&self.conn, |c| {
            c.execute(sql, rusqlite::params![k])?;
            Ok(())
        })
    }
}

/// Generates the write/read/delete triple for one `openmls_group_data` discriminant.
///
/// The first two tokens are the **order of the write's and of the read's generic parameters**,
/// which rustc matches positionally: writing a pair the other way round than the trait declares it
/// is `error[E0276]: impl has stricter requirements than trait`, not a name mismatch. Both orders
/// are taken from `openmls_traits 0.6.0`'s `src/storage.rs` (step 1 of the task brief), not from
/// the shape of the neighbouring methods: `write_group_state` and `group_state` are the two slots
/// that declare `<GroupState, GroupId>` while every other slot is GroupId-first.
macro_rules! group_data_slot {
    ($worder:ident, $rorder:ident, $write:ident, $read:ident, $delete:ident, $entity:ident, $tag:literal) => {
        group_data_slot!(@write $worder, $write, $entity, $tag);
        group_data_slot!(@read $rorder, $read, $entity, $tag);
        group_data_slot!(@delete $delete, $tag);
    };

    (@write key_first, $write:ident, $entity:ident, $tag:literal) => {
        fn $write<
            GroupId: traits::GroupId<CURRENT_VERSION>,
            $entity: traits::$entity<CURRENT_VERSION>,
        >(
            &self,
            group_id: &GroupId,
            value: &$entity,
        ) -> Result<(), Self::Error> {
            self.put_group_data(group_id, $tag, value)
        }
    };

    (@write value_first, $write:ident, $entity:ident, $tag:literal) => {
        fn $write<
            $entity: traits::$entity<CURRENT_VERSION>,
            GroupId: traits::GroupId<CURRENT_VERSION>,
        >(
            &self,
            group_id: &GroupId,
            value: &$entity,
        ) -> Result<(), Self::Error> {
            self.put_group_data(group_id, $tag, value)
        }
    };

    (@read key_first, $read:ident, $entity:ident, $tag:literal) => {
        fn $read<
            GroupId: traits::GroupId<CURRENT_VERSION>,
            $entity: traits::$entity<CURRENT_VERSION>,
        >(
            &self,
            group_id: &GroupId,
        ) -> Result<Option<$entity>, Self::Error> {
            self.get_group_data(group_id, $tag)
        }
    };

    (@read value_first, $read:ident, $entity:ident, $tag:literal) => {
        fn $read<
            $entity: traits::$entity<CURRENT_VERSION>,
            GroupId: traits::GroupId<CURRENT_VERSION>,
        >(
            &self,
            group_id: &GroupId,
        ) -> Result<Option<$entity>, Self::Error> {
            self.get_group_data(group_id, $tag)
        }
    };

    (@delete $delete:ident, $tag:literal) => {
        fn $delete<GroupId: traits::GroupId<CURRENT_VERSION>>(
            &self,
            group_id: &GroupId,
        ) -> Result<(), Self::Error> {
            self.del_group_data(group_id, $tag)
        }
    };
}

impl StorageProvider<CURRENT_VERSION> for DillaStorage {
    type Error = StorageError;

    // 30 of the 53: ten single-value slots in openmls_group_data. The first two tokens of each
    // line are the write's and the read's generic-parameter order, read out of the vendored
    // `openmls_traits 0.6.0` source; `group_state` is the only slot where both are value-first.
    group_data_slot!(
        key_first,
        key_first,
        write_mls_join_config,
        mls_group_join_config,
        delete_group_config,
        MlsGroupJoinConfig,
        "join_group_config"
    );
    group_data_slot!(
        key_first,
        key_first,
        write_tree,
        tree,
        delete_tree,
        TreeSync,
        "tree"
    );
    group_data_slot!(
        key_first,
        key_first,
        write_interim_transcript_hash,
        interim_transcript_hash,
        delete_interim_transcript_hash,
        InterimTranscriptHash,
        "interim_transcript_hash"
    );
    group_data_slot!(
        key_first,
        key_first,
        write_context,
        group_context,
        delete_context,
        GroupContext,
        "context"
    );
    group_data_slot!(
        key_first,
        key_first,
        write_confirmation_tag,
        confirmation_tag,
        delete_confirmation_tag,
        ConfirmationTag,
        "confirmation_tag"
    );
    group_data_slot!(
        value_first,
        value_first,
        write_group_state,
        group_state,
        delete_group_state,
        GroupState,
        "group_state"
    );
    group_data_slot!(
        key_first,
        key_first,
        write_message_secrets,
        message_secrets,
        delete_message_secrets,
        MessageSecrets,
        "message_secrets"
    );
    group_data_slot!(
        key_first,
        key_first,
        write_resumption_psk_store,
        resumption_psk_store,
        delete_all_resumption_psk_secrets,
        ResumptionPskStore,
        "resumption_psk_store"
    );
    group_data_slot!(
        key_first,
        key_first,
        write_own_leaf_index,
        own_leaf_index,
        delete_own_leaf_index,
        LeafNodeIndex,
        "own_leaf_index"
    );
    group_data_slot!(
        key_first,
        key_first,
        write_group_epoch_secrets,
        group_epoch_secrets,
        delete_group_epoch_secrets,
        GroupEpochSecrets,
        "group_epoch_secrets"
    );

    // 3: the append-only own-leaf-node log.
    fn append_own_leaf_node<
        GroupId: traits::GroupId<CURRENT_VERSION>,
        LeafNode: traits::LeafNode<CURRENT_VERSION>,
    >(
        &self,
        group_id: &GroupId,
        leaf_node: &LeafNode,
    ) -> Result<(), Self::Error> {
        let (g, n) = (Self::enc(group_id)?, Self::enc(leaf_node)?);
        with_conn(&self.conn, |c| {
            c.execute(
                "INSERT INTO openmls_own_leaf_nodes (provider_version, group_id, leaf_node)
                 VALUES (1, ?1, ?2)",
                rusqlite::params![g, n],
            )?;
            Ok(())
        })
    }

    fn own_leaf_nodes<
        GroupId: traits::GroupId<CURRENT_VERSION>,
        LeafNode: traits::LeafNode<CURRENT_VERSION>,
    >(
        &self,
        group_id: &GroupId,
    ) -> Result<Vec<LeafNode>, Self::Error> {
        let g = Self::enc(group_id)?;
        let raws: Vec<Vec<u8>> = with_conn(&self.conn, |c| {
            let mut stmt = c.prepare(
                "SELECT leaf_node FROM openmls_own_leaf_nodes WHERE group_id = ?1 ORDER BY id ASC",
            )?;
            let rows = stmt.query_map(rusqlite::params![g], |row| row.get::<_, Vec<u8>>(0))?;
            let mut out = Vec::new();
            for row in rows {
                out.push(row?);
            }
            Ok(out)
        })?;
        raws.iter().map(|b| Self::dec(b)).collect()
    }

    fn delete_own_leaf_nodes<GroupId: traits::GroupId<CURRENT_VERSION>>(
        &self,
        group_id: &GroupId,
    ) -> Result<(), Self::Error> {
        self.del_keyed(
            "DELETE FROM openmls_own_leaf_nodes WHERE group_id = ?1",
            group_id,
        )
    }

    // 5: the proposal queue.
    fn queue_proposal<
        GroupId: traits::GroupId<CURRENT_VERSION>,
        ProposalRef: traits::ProposalRef<CURRENT_VERSION>,
        QueuedProposal: traits::QueuedProposal<CURRENT_VERSION>,
    >(
        &self,
        group_id: &GroupId,
        proposal_ref: &ProposalRef,
        proposal: &QueuedProposal,
    ) -> Result<(), Self::Error> {
        let (g, r, p) = (
            Self::enc(group_id)?,
            Self::enc(proposal_ref)?,
            Self::enc(proposal)?,
        );
        with_conn(&self.conn, |c| {
            c.execute(
                "INSERT INTO openmls_proposals (provider_version, group_id, proposal_ref, proposal)
                 VALUES (1, ?1, ?2, ?3)
                 ON CONFLICT (group_id, proposal_ref) DO UPDATE SET proposal = excluded.proposal",
                rusqlite::params![g, r, p],
            )?;
            Ok(())
        })
    }

    fn queued_proposal_refs<
        GroupId: traits::GroupId<CURRENT_VERSION>,
        ProposalRef: traits::ProposalRef<CURRENT_VERSION>,
    >(
        &self,
        group_id: &GroupId,
    ) -> Result<Vec<ProposalRef>, Self::Error> {
        let g = Self::enc(group_id)?;
        let raws: Vec<Vec<u8>> = with_conn(&self.conn, |c| {
            let mut stmt = c.prepare(
                "SELECT proposal_ref FROM openmls_proposals WHERE group_id = ?1 ORDER BY rowid ASC",
            )?;
            let rows = stmt.query_map(rusqlite::params![g], |row| row.get::<_, Vec<u8>>(0))?;
            let mut out = Vec::new();
            for row in rows {
                out.push(row?);
            }
            Ok(out)
        })?;
        raws.iter().map(|b| Self::dec(b)).collect()
    }

    fn queued_proposals<
        GroupId: traits::GroupId<CURRENT_VERSION>,
        ProposalRef: traits::ProposalRef<CURRENT_VERSION>,
        QueuedProposal: traits::QueuedProposal<CURRENT_VERSION>,
    >(
        &self,
        group_id: &GroupId,
    ) -> Result<Vec<(ProposalRef, QueuedProposal)>, Self::Error> {
        let g = Self::enc(group_id)?;
        let raws: Vec<(Vec<u8>, Vec<u8>)> = with_conn(&self.conn, |c| {
            let mut stmt = c.prepare(
                "SELECT proposal_ref, proposal FROM openmls_proposals
                 WHERE group_id = ?1 ORDER BY rowid ASC",
            )?;
            let rows = stmt.query_map(rusqlite::params![g], |row| {
                Ok((row.get::<_, Vec<u8>>(0)?, row.get::<_, Vec<u8>>(1)?))
            })?;
            let mut out = Vec::new();
            for row in rows {
                out.push(row?);
            }
            Ok(out)
        })?;
        raws.iter()
            .map(|(r, p)| Ok((Self::dec(r)?, Self::dec(p)?)))
            .collect()
    }

    fn remove_proposal<
        GroupId: traits::GroupId<CURRENT_VERSION>,
        ProposalRef: traits::ProposalRef<CURRENT_VERSION>,
    >(
        &self,
        group_id: &GroupId,
        proposal_ref: &ProposalRef,
    ) -> Result<(), Self::Error> {
        let (g, r) = (Self::enc(group_id)?, Self::enc(proposal_ref)?);
        with_conn(&self.conn, |c| {
            c.execute(
                "DELETE FROM openmls_proposals WHERE group_id = ?1 AND proposal_ref = ?2",
                rusqlite::params![g, r],
            )?;
            Ok(())
        })
    }

    /// Both type parameters are unconstrained by the arguments, so every call site turbofishes
    /// them; the body ignores both (gap-1 section 2.5).
    fn clear_proposal_queue<
        GroupId: traits::GroupId<CURRENT_VERSION>,
        ProposalRef: traits::ProposalRef<CURRENT_VERSION>,
    >(
        &self,
        group_id: &GroupId,
    ) -> Result<(), Self::Error> {
        self.del_keyed(
            "DELETE FROM openmls_proposals WHERE group_id = ?1",
            group_id,
        )
    }

    // 12: the four single-key tables.
    fn write_signature_key_pair<
        SignaturePublicKey: traits::SignaturePublicKey<CURRENT_VERSION>,
        SignatureKeyPair: traits::SignatureKeyPair<CURRENT_VERSION>,
    >(
        &self,
        public_key: &SignaturePublicKey,
        signature_key_pair: &SignatureKeyPair,
    ) -> Result<(), Self::Error> {
        self.put_keyed(
            "INSERT INTO openmls_signature_keys (provider_version, public_key, signature_key)
             VALUES (1, ?1, ?2)
             ON CONFLICT (public_key) DO UPDATE SET signature_key = excluded.signature_key",
            public_key,
            signature_key_pair,
        )
    }

    fn signature_key_pair<
        SignaturePublicKey: traits::SignaturePublicKey<CURRENT_VERSION>,
        SignatureKeyPair: traits::SignatureKeyPair<CURRENT_VERSION>,
    >(
        &self,
        public_key: &SignaturePublicKey,
    ) -> Result<Option<SignatureKeyPair>, Self::Error> {
        self.get_keyed(
            "SELECT signature_key FROM openmls_signature_keys WHERE public_key = ?1",
            public_key,
        )
    }

    fn delete_signature_key_pair<
        SignaturePublicKey: traits::SignaturePublicKey<CURRENT_VERSION>,
    >(
        &self,
        public_key: &SignaturePublicKey,
    ) -> Result<(), Self::Error> {
        self.del_keyed(
            "DELETE FROM openmls_signature_keys WHERE public_key = ?1",
            public_key,
        )
    }

    fn write_encryption_key_pair<
        EncryptionKey: traits::EncryptionKey<CURRENT_VERSION>,
        HpkeKeyPair: traits::HpkeKeyPair<CURRENT_VERSION>,
    >(
        &self,
        public_key: &EncryptionKey,
        key_pair: &HpkeKeyPair,
    ) -> Result<(), Self::Error> {
        self.put_keyed(
            "INSERT INTO openmls_encryption_keys (provider_version, public_key, key_pair)
             VALUES (1, ?1, ?2)
             ON CONFLICT (public_key) DO UPDATE SET key_pair = excluded.key_pair",
            public_key,
            key_pair,
        )
    }

    // Value type first: the trait declares this read as `<HpkeKeyPair, EncryptionKey>`, and the
    // order is positional. Same for `psk` and `group_state`.
    fn encryption_key_pair<
        HpkeKeyPair: traits::HpkeKeyPair<CURRENT_VERSION>,
        EncryptionKey: traits::EncryptionKey<CURRENT_VERSION>,
    >(
        &self,
        public_key: &EncryptionKey,
    ) -> Result<Option<HpkeKeyPair>, Self::Error> {
        self.get_keyed(
            "SELECT key_pair FROM openmls_encryption_keys WHERE public_key = ?1",
            public_key,
        )
    }

    fn delete_encryption_key_pair<EncryptionKey: traits::EncryptionKey<CURRENT_VERSION>>(
        &self,
        public_key: &EncryptionKey,
    ) -> Result<(), Self::Error> {
        self.del_keyed(
            "DELETE FROM openmls_encryption_keys WHERE public_key = ?1",
            public_key,
        )
    }

    fn write_key_package<
        HashReference: traits::HashReference<CURRENT_VERSION>,
        KeyPackage: traits::KeyPackage<CURRENT_VERSION>,
    >(
        &self,
        hash_ref: &HashReference,
        key_package: &KeyPackage,
    ) -> Result<(), Self::Error> {
        self.put_keyed(
            "INSERT INTO openmls_key_packages (provider_version, key_package_ref, key_package)
             VALUES (1, ?1, ?2)
             ON CONFLICT (key_package_ref) DO UPDATE SET key_package = excluded.key_package",
            hash_ref,
            key_package,
        )
    }

    fn key_package<
        HashReference: traits::HashReference<CURRENT_VERSION>,
        KeyPackage: traits::KeyPackage<CURRENT_VERSION>,
    >(
        &self,
        hash_ref: &HashReference,
    ) -> Result<Option<KeyPackage>, Self::Error> {
        self.get_keyed(
            "SELECT key_package FROM openmls_key_packages WHERE key_package_ref = ?1",
            hash_ref,
        )
    }

    fn delete_key_package<HashReference: traits::HashReference<CURRENT_VERSION>>(
        &self,
        hash_ref: &HashReference,
    ) -> Result<(), Self::Error> {
        self.del_keyed(
            "DELETE FROM openmls_key_packages WHERE key_package_ref = ?1",
            hash_ref,
        )
    }

    fn write_psk<
        PskId: traits::PskId<CURRENT_VERSION>,
        PskBundle: traits::PskBundle<CURRENT_VERSION>,
    >(
        &self,
        psk_id: &PskId,
        psk: &PskBundle,
    ) -> Result<(), Self::Error> {
        self.put_keyed(
            "INSERT INTO openmls_psks (provider_version, psk_id, psk_bundle) VALUES (1, ?1, ?2)
             ON CONFLICT (psk_id) DO UPDATE SET psk_bundle = excluded.psk_bundle",
            psk_id,
            psk,
        )
    }

    fn psk<PskBundle: traits::PskBundle<CURRENT_VERSION>, PskId: traits::PskId<CURRENT_VERSION>>(
        &self,
        psk_id: &PskId,
    ) -> Result<Option<PskBundle>, Self::Error> {
        self.get_keyed(
            "SELECT psk_bundle FROM openmls_psks WHERE psk_id = ?1",
            psk_id,
        )
    }

    fn delete_psk<PskId: traits::PskId<CURRENT_VERSION>>(
        &self,
        psk_id: &PskId,
    ) -> Result<(), Self::Error> {
        self.del_keyed("DELETE FROM openmls_psks WHERE psk_id = ?1", psk_id)
    }

    // 3: per-epoch HPKE key pairs, keyed by (group, epoch, leaf).
    fn write_encryption_epoch_key_pairs<
        GroupId: traits::GroupId<CURRENT_VERSION>,
        EpochKey: traits::EpochKey<CURRENT_VERSION>,
        HpkeKeyPair: traits::HpkeKeyPair<CURRENT_VERSION>,
    >(
        &self,
        group_id: &GroupId,
        epoch: &EpochKey,
        leaf_index: u32,
        key_pairs: &[HpkeKeyPair],
    ) -> Result<(), Self::Error> {
        // `&key_pairs.to_vec()` would need `HpkeKeyPair: Clone`, which the bound does not give
        // (E0277). A slice reference serialises directly: `&[T]: Serialize` when `T: Serialize`,
        // and the outer `&` keeps the generic argument `Sized`. The wire shape is the same
        // sequence the read below decodes into `Vec<HpkeKeyPair>`.
        let (g, e, v) = (
            Self::enc(group_id)?,
            Self::enc(epoch)?,
            Self::enc(&key_pairs)?,
        );
        with_conn(&self.conn, |c| {
            c.execute(
                "INSERT INTO openmls_epoch_key_pairs
                     (provider_version, group_id, epoch_id, leaf_index, key_pairs)
                 VALUES (1, ?1, ?2, ?3, ?4)
                 ON CONFLICT (group_id, epoch_id, leaf_index)
                 DO UPDATE SET key_pairs = excluded.key_pairs",
                rusqlite::params![g, e, leaf_index, v],
            )?;
            Ok(())
        })
    }

    fn encryption_epoch_key_pairs<
        GroupId: traits::GroupId<CURRENT_VERSION>,
        EpochKey: traits::EpochKey<CURRENT_VERSION>,
        HpkeKeyPair: traits::HpkeKeyPair<CURRENT_VERSION>,
    >(
        &self,
        group_id: &GroupId,
        epoch: &EpochKey,
        leaf_index: u32,
    ) -> Result<Vec<HpkeKeyPair>, Self::Error> {
        let (g, e) = (Self::enc(group_id)?, Self::enc(epoch)?);
        let raw: Option<Vec<u8>> = with_conn(&self.conn, |c| {
            let mut stmt = c.prepare(
                "SELECT key_pairs FROM openmls_epoch_key_pairs
                 WHERE group_id = ?1 AND epoch_id = ?2 AND leaf_index = ?3",
            )?;
            let mut rows = stmt.query(rusqlite::params![g, e, leaf_index])?;
            match rows.next()? {
                Some(row) => Ok(Some(row.get::<_, Vec<u8>>(0)?)),
                None => Ok(None),
            }
        })?;
        match raw {
            Some(b) => Self::dec(&b),
            None => Ok(Vec::new()),
        }
    }

    fn delete_encryption_epoch_key_pairs<
        GroupId: traits::GroupId<CURRENT_VERSION>,
        EpochKey: traits::EpochKey<CURRENT_VERSION>,
    >(
        &self,
        group_id: &GroupId,
        epoch: &EpochKey,
        leaf_index: u32,
    ) -> Result<(), Self::Error> {
        let (g, e) = (Self::enc(group_id)?, Self::enc(epoch)?);
        with_conn(&self.conn, |c| {
            c.execute(
                "DELETE FROM openmls_epoch_key_pairs
                 WHERE group_id = ?1 AND epoch_id = ?2 AND leaf_index = ?3",
                rusqlite::params![g, e, leaf_index],
            )?;
            Ok(())
        })
    }
}

#[cfg(not(target_arch = "wasm32"))]
#[cfg(test)]
mod tests {
    use super::*;
    use crate::mls::test_entities::{TKey, TVal};
    // `StorageProvider` is already in scope through `use super::*`; importing it again here is
    // an `unused_imports` warning, and the crate builds under `-D warnings`.
    use std::sync::{Arc, Mutex};

    fn gid() -> TKey {
        TKey(b"group-1".to_vec())
    }

    fn open(path: &std::path::Path) -> DillaStorage {
        let conn = rusqlite::Connection::open(path).expect("open");
        let storage = DillaStorage::new(Arc::new(Mutex::new(conn)));
        storage.migrate().expect("migrate");
        storage
    }

    fn memory() -> DillaStorage {
        let conn = rusqlite::Connection::open_in_memory().expect("open");
        let storage = DillaStorage::new(Arc::new(Mutex::new(conn)));
        storage.migrate().expect("migrate");
        storage
    }

    #[test]
    fn migrate_seeds_storage_meta_and_is_idempotent() {
        let s = memory();
        assert_eq!(
            s.storage_meta("storage_provider_version")
                .unwrap()
                .as_deref(),
            Some("1")
        );
        assert_eq!(s.storage_meta("codec").unwrap().as_deref(), Some("cbor"));
        assert!(s.storage_meta("openmls_version").unwrap().is_some());
        assert!(s.storage_meta("nothing").unwrap().is_none());
        s.migrate().expect("second migrate");
        assert_eq!(s.storage_meta("codec").unwrap().as_deref(), Some("cbor"));
    }

    /// `storage_meta` is written on the first `migrate()` and thereafter only read, so a file
    /// written by a future build kept its own `storage_provider_version` and `codec` while
    /// `INSERT OR IGNORE` quietly left them alone. Every blob in that file is then decoded with
    /// *this* build's layout and codec: a self-describing codec turns the mismatch into a
    /// `Codec` error somewhere deep in a later reload (gap-6 section 2.3), or worse, decodes into
    /// something structurally valid and wrong. Refusing at open is the only honest answer.
    #[test]
    fn migrate_refuses_a_file_written_by_another_provider_version_or_codec() {
        fn seeded(version: &str, codec: &str) -> DillaStorage {
            let conn = rusqlite::Connection::open_in_memory().expect("open");
            conn.execute_batch(
                "CREATE TABLE IF NOT EXISTS storage_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);",
            )
            .expect("meta table");
            let mut stmt = conn
                .prepare("INSERT INTO storage_meta (key, value) VALUES (?1, ?2)")
                .expect("prepare");
            stmt.execute(rusqlite::params!["storage_provider_version", version])
                .expect("seed version");
            stmt.execute(rusqlite::params!["codec", codec])
                .expect("seed codec");
            drop(stmt);
            DillaStorage::new(Arc::new(Mutex::new(conn)))
        }

        let future = seeded("2", "cbor");
        assert!(
            matches!(
                future.migrate(),
                Err(StorageError::UnsupportedStorage { ref version, ref codec })
                    if version == "2" && codec == "cbor"
            ),
            "{:?}",
            future.migrate()
        );

        let other_codec = seeded("1", "postcard");
        assert!(
            matches!(
                other_codec.migrate(),
                Err(StorageError::UnsupportedStorage { ref version, ref codec })
                    if version == "1" && codec == "postcard"
            ),
            "{:?}",
            other_codec.migrate()
        );

        // A fresh file still opens, and re-opening the one this build wrote stays idempotent.
        let fresh = memory();
        fresh.migrate().expect("a file this build wrote reopens");
    }

    /// The self-describing-codec failure mode is invisible until a reload (gap-6 section 2.3), so
    /// this writes with one connection, drops it, and reads with a new one from the same file.
    #[test]
    fn group_data_survives_closing_and_reopening_the_connection() {
        let dir = std::env::temp_dir().join(format!("dilla-storage-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("tmp dir");
        let path = dir.join("reload.sqlite");
        let _ = std::fs::remove_file(&path);

        {
            let s = open(&path);
            s.write_tree(&gid(), &TVal(3)).expect("write_tree");
            s.write_context(&gid(), &TVal(7)).expect("write_context");
        }
        {
            let s = open(&path);
            let tree: Option<TVal> = s.tree(&gid()).expect("tree");
            assert_eq!(tree, Some(TVal(3)));
            let ctx: Option<TVal> = s.group_context(&gid()).expect("context");
            assert_eq!(ctx, Some(TVal(7)));
        }
        std::fs::remove_file(&path).expect("cleanup");
    }

    #[test]
    fn every_group_data_slot_round_trips_and_deletes() {
        let s = memory();
        let g = gid();
        s.write_tree(&g, &TVal(1)).unwrap();
        s.write_interim_transcript_hash(&g, &TVal(2)).unwrap();
        s.write_context(&g, &TVal(3)).unwrap();
        s.write_confirmation_tag(&g, &TVal(4)).unwrap();
        s.write_group_state(&g, &TVal(5)).unwrap();
        s.write_message_secrets(&g, &TVal(6)).unwrap();
        s.write_resumption_psk_store(&g, &TVal(7)).unwrap();
        s.write_own_leaf_index(&g, &TVal(8)).unwrap();
        s.write_group_epoch_secrets(&g, &TVal(9)).unwrap();
        s.write_mls_join_config(&g, &TVal(10)).unwrap();

        let tree: Option<TVal> = s.tree(&g).unwrap();
        assert_eq!(tree, Some(TVal(1)));
        let interim: Option<TVal> = s.interim_transcript_hash(&g).unwrap();
        assert_eq!(interim, Some(TVal(2)));
        let context: Option<TVal> = s.group_context(&g).unwrap();
        assert_eq!(context, Some(TVal(3)));
        let tag: Option<TVal> = s.confirmation_tag(&g).unwrap();
        assert_eq!(tag, Some(TVal(4)));
        let state: Option<TVal> = s.group_state(&g).unwrap();
        assert_eq!(state, Some(TVal(5)));
        let secrets: Option<TVal> = s.message_secrets(&g).unwrap();
        assert_eq!(secrets, Some(TVal(6)));
        let psks: Option<TVal> = s.resumption_psk_store(&g).unwrap();
        assert_eq!(psks, Some(TVal(7)));
        let leaf: Option<TVal> = s.own_leaf_index(&g).unwrap();
        assert_eq!(leaf, Some(TVal(8)));
        let epoch: Option<TVal> = s.group_epoch_secrets(&g).unwrap();
        assert_eq!(epoch, Some(TVal(9)));
        let config: Option<TVal> = s.mls_group_join_config(&g).unwrap();
        assert_eq!(config, Some(TVal(10)));

        s.delete_tree(&g).unwrap();
        s.delete_interim_transcript_hash(&g).unwrap();
        s.delete_context(&g).unwrap();
        s.delete_confirmation_tag(&g).unwrap();
        s.delete_group_state(&g).unwrap();
        s.delete_message_secrets(&g).unwrap();
        s.delete_all_resumption_psk_secrets(&g).unwrap();
        s.delete_own_leaf_index(&g).unwrap();
        s.delete_group_epoch_secrets(&g).unwrap();
        s.delete_group_config(&g).unwrap();

        let tree: Option<TVal> = s.tree(&g).unwrap();
        assert_eq!(tree, None);
        let config: Option<TVal> = s.mls_group_join_config(&g).unwrap();
        assert_eq!(config, None);
        // a delete on an absent row is not an error
        s.delete_tree(&g).unwrap();
    }

    #[test]
    fn the_proposal_queue_appends_lists_removes_and_clears() {
        let s = memory();
        let g = gid();
        let ref_a = TKey(b"ref-a".to_vec());
        let ref_b = TKey(b"ref-b".to_vec());
        s.queue_proposal(&g, &ref_a, &TVal(1)).unwrap();
        s.queue_proposal(&g, &ref_b, &TVal(2)).unwrap();

        let refs: Vec<TKey> = s.queued_proposal_refs(&g).unwrap();
        assert_eq!(refs.len(), 2);
        let all: Vec<(TKey, TVal)> = s.queued_proposals(&g).unwrap();
        assert_eq!(all.len(), 2);
        assert!(all.iter().any(|(_, p)| *p == TVal(1)));

        s.remove_proposal(&g, &ref_a).unwrap();
        let all: Vec<(TKey, TVal)> = s.queued_proposals(&g).unwrap();
        assert_eq!(all.len(), 1);

        // Both parameters are unconstrained by the arguments, so this call site must turbofish
        // (gap-1 section 2.5); the body ignores them.
        s.clear_proposal_queue::<TKey, TKey>(&g).unwrap();
        let all: Vec<(TKey, TVal)> = s.queued_proposals(&g).unwrap();
        assert!(all.is_empty());
    }

    #[test]
    fn own_leaf_nodes_append_in_order_and_delete_together() {
        let s = memory();
        let g = gid();
        s.append_own_leaf_node(&g, &TVal(1)).unwrap();
        s.append_own_leaf_node(&g, &TVal(2)).unwrap();
        let nodes: Vec<TVal> = s.own_leaf_nodes(&g).unwrap();
        assert_eq!(
            nodes,
            vec![TVal(1), TVal(2)],
            "insertion order, not rowid order by accident"
        );
        s.delete_own_leaf_nodes(&g).unwrap();
        let nodes: Vec<TVal> = s.own_leaf_nodes(&g).unwrap();
        assert!(nodes.is_empty());
    }

    #[test]
    fn the_five_keyed_tables_round_trip_and_delete() {
        let s = memory();
        let sig_pub = TKey(b"pub".to_vec());
        s.write_signature_key_pair(&sig_pub, &TVal(11)).unwrap();
        let got: Option<TVal> = s.signature_key_pair(&sig_pub).unwrap();
        assert_eq!(got, Some(TVal(11)));
        s.delete_signature_key_pair(&sig_pub).unwrap();
        let got: Option<TVal> = s.signature_key_pair(&sig_pub).unwrap();
        assert_eq!(got, None);

        let enc_pub = TKey(b"epub".to_vec());
        s.write_encryption_key_pair(&enc_pub, &TVal(12)).unwrap();
        let got: Option<TVal> = s.encryption_key_pair(&enc_pub).unwrap();
        assert_eq!(got, Some(TVal(12)));
        s.delete_encryption_key_pair(&enc_pub).unwrap();

        let kp_ref = TKey(b"kpref".to_vec());
        s.write_key_package(&kp_ref, &TVal(13)).unwrap();
        let got: Option<TVal> = s.key_package(&kp_ref).unwrap();
        assert_eq!(got, Some(TVal(13)));
        s.delete_key_package(&kp_ref).unwrap();

        let psk_id = TKey(b"pskid".to_vec());
        s.write_psk(&psk_id, &TVal(14)).unwrap();
        let got: Option<TVal> = s.psk(&psk_id).unwrap();
        assert_eq!(got, Some(TVal(14)));
        s.delete_psk(&psk_id).unwrap();

        let g = gid();
        let epoch = TKey(b"epoch-7".to_vec());
        s.write_encryption_epoch_key_pairs(&g, &epoch, 3, &[TVal(21), TVal(22)])
            .unwrap();
        let pairs: Vec<TVal> = s.encryption_epoch_key_pairs(&g, &epoch, 3).unwrap();
        assert_eq!(pairs, vec![TVal(21), TVal(22)]);
        // a different leaf index is a different row
        let none: Vec<TVal> = s.encryption_epoch_key_pairs(&g, &epoch, 4).unwrap();
        assert!(none.is_empty());
        s.delete_encryption_epoch_key_pairs(&g, &epoch, 3).unwrap();
        let none: Vec<TVal> = s.encryption_epoch_key_pairs(&g, &epoch, 3).unwrap();
        assert!(none.is_empty());
    }
}
