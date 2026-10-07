//! Browser and desktop client engine: Rust decides and persists; the caller transports.
//! Every structured value crossing the boundary is one deterministic CBOR item. Every state
//! change runs inside exactly one `DillaStorage::unit`.

mod error;
mod groups;
mod identity;
mod messages;
mod schema;
mod settings;
mod sync;
mod wire;

pub use error::ClientError;
pub use identity::{recovery_key_check, session_preimage};
pub use messages::mentions_me;
pub use schema::{HANDSHAKE_TAIL, migrate_app};

use crate::identity::CredentialIdentity;
use crate::mls::{
    CIPHERSUITE, ConnHandle, DillaGroup, DillaProvider, DillaStorage, StorageError, UnitScope,
};
use error::{E_CORE_NO_IDENTITY, E_CORE_RELOAD, E_CORE_STATE, E_CORE_STORAGE};
use openmls::prelude::GroupId;
use openmls_basic_credential::SignatureKeyPair;
use rusqlite::OptionalExtension;
use std::collections::BTreeMap;

pub struct ClientCore {
    provider: DillaProvider,
    signer: Option<SignatureKeyPair>,
    groups: BTreeMap<[u8; 16], DillaGroup>,
}

struct Ctx<'a> {
    provider: &'a DillaProvider,
    signer: Option<&'a SignatureKeyPair>,
}

struct Own {
    instance_id: [u8; 16],
    user_id: [u8; 16],
    device_id: [u8; 16],
    dsk_pub: [u8; 32],
    credential: Vec<u8>,
    kind: u8,
    tier: u8,
}

impl ClientCore {
    fn own(&self) -> Result<Own, ClientError> {
        let raw: Option<Vec<u8>> = self.read(|c| {
            c.query_row("SELECT v FROM app_meta WHERE k = 'identity'", [], |r| {
                r.get(0)
            })
            .optional()
            .map_err(StorageError::from)
        })?;
        let raw = raw.ok_or_else(|| ClientError::new(E_CORE_NO_IDENTITY, ""))?;
        let record = identity::IdentityRecord::decode(&raw)?;
        let credential = CredentialIdentity::decode(&record.credential).map_err(|_| {
            ClientError::new(
                E_CORE_STORAGE,
                "identity record: credential does not decode",
            )
        })?;
        Ok(Own {
            instance_id: record.instance_id,
            user_id: record.user_id,
            device_id: record.device_id,
            dsk_pub: record.dsk_pub,
            credential: record.credential,
            kind: credential.kind.as_u8(),
            tier: credential.tier.as_u8(),
        })
    }

    fn signer(&self) -> Result<&SignatureKeyPair, ClientError> {
        self.signer
            .as_ref()
            .ok_or_else(|| ClientError::new(E_CORE_NO_IDENTITY, ""))
    }

    /// The group, from the cache or loaded from the store. A loaded group must be the one its
    /// row describes: its MLS group id and its binding's community, target and kind equal the
    /// row's. Otherwise `E_CORE_STATE` and nothing is cached; the caller repairs the row with a
    /// resync (`group_join_external`, states 2 and 3), which replaces the stored group. The cache
    /// only ever holds a group that passed this check or that a join of this core wrote.
    fn take_group(&mut self, group_id: &[u8; 16]) -> Result<Option<DillaGroup>, ClientError> {
        if let Some(group) = self.groups.remove(group_id) {
            return Ok(Some(group));
        }
        let Some(group) = self.take_group_unchecked(group_id)? else {
            return Ok(None);
        };
        let row = self.read(|c| groups::group_row(c, group_id))?;
        if let Some(row) = row {
            let binding = group.binding();
            let matches = group.group_id().as_slice() == group_id
                && row.kind == 0
                && binding.kind == crate::mls::GroupKind::Text
                && binding.target_id.as_slice() == row.target_id.as_slice()
                && binding
                    .community_id
                    .as_ref()
                    .map(|c| c.as_bytes().as_slice())
                    == row.community_id.as_deref();
            if !matches {
                return Err(ClientError::new(
                    E_CORE_STATE,
                    "the stored group does not match its row; resync the group",
                ));
            }
        }
        Ok(Some(group))
    }

    /// The group from the cache or the store without comparing it with its row: for the paths
    /// that delete it (joins over a stale group, discard).
    fn take_group_unchecked(
        &mut self,
        group_id: &[u8; 16],
    ) -> Result<Option<DillaGroup>, ClientError> {
        if let Some(group) = self.groups.remove(group_id) {
            return Ok(Some(group));
        }
        DillaGroup::load(&self.provider, &GroupId::from_slice(group_id)).map_err(Into::into)
    }

    fn keep_group(&mut self, group_id: [u8; 16], group: DillaGroup) {
        self.groups.insert(group_id, group);
    }

    fn retry_reload<T>(
        &mut self,
        group_id: &[u8; 16],
        mut f: impl FnMut(&mut Self) -> Result<T, ClientError>,
    ) -> Result<T, ClientError> {
        let first = f(self);
        if matches!(&first, Err(e) if e.code == E_CORE_RELOAD) {
            self.groups.remove(group_id);
            f(self)
        } else {
            first
        }
    }
    fn write<T>(
        &mut self,
        f: impl FnOnce(&Ctx<'_>, &UnitScope<'_>) -> Result<T, ClientError>,
    ) -> Result<T, ClientError> {
        let Self {
            provider,
            signer,
            groups,
        } = self;
        let result = provider
            .storage()
            .unit(|u| {
                f(
                    &Ctx {
                        provider,
                        signer: signer.as_ref(),
                    },
                    u,
                )
            })
            .map_err(ClientError::from);
        if result.is_err() {
            groups.clear();
        }
        result
    }

    fn read<T>(
        &self,
        f: impl FnOnce(&rusqlite::Connection) -> Result<T, StorageError>,
    ) -> Result<T, ClientError> {
        self.provider
            .storage()
            .unit(|u| u.with_conn(f))
            .map_err(|e| match e {
                crate::mls::TxError::RolledBack(e) => e.into(),
                other => ClientError::new(E_CORE_STORAGE, other.to_string()),
            })
    }

    pub fn open(conn: ConnHandle) -> Result<Self, ClientError> {
        let provider = DillaProvider::new(conn);
        provider.storage().exec("PRAGMA secure_delete = ON")?;
        provider.storage().migrate()?;
        let version = provider
            .storage()
            .unit(|u| -> Result<u64, ClientError> {
                let found = u.with_conn(schema::migrate_conn).map_err(schema_error)?;
                if found == 1 {
                    backfill(provider.storage(), u).map_err(schema_error)?;
                }
                Ok(found)
            })
            .map_err(ClientError::from)?;
        if version > 2 {
            return Err(ClientError::new(
                E_CORE_STATE,
                format!("app schema {version} is newer than this build"),
            ));
        }
        let (identity, signup, enrol) = provider
            .storage()
            .unit(|u| u.with_conn(identity::load_phase))
            .map_err(|e| match e {
                crate::mls::TxError::RolledBack(e) => e.into(),
                other => ClientError::new(E_CORE_STORAGE, other.to_string()),
            })?;
        let phase = identity::decode_phase(identity, signup, enrol)?;
        let dsk_pub = match &phase {
            identity::Phase::None => None,
            identity::Phase::Pending(rec) => Some(rec.dsk_pub()),
            identity::Phase::Ready(rec) => Some(rec.dsk_pub),
            identity::Phase::Enrolling(rec) => Some(rec.dsk_pub),
        };
        let signer = dsk_pub
            .map(|pubkey| {
                SignatureKeyPair::read(
                    provider.storage(),
                    &pubkey,
                    CIPHERSUITE.signature_algorithm(),
                )
                .ok_or_else(|| {
                    ClientError::new(E_CORE_STATE, "the device key is missing from the store")
                })
            })
            .transpose()?;
        Ok(Self {
            provider,
            signer,
            groups: BTreeMap::new(),
        })
    }

    pub fn unload(&mut self) {
        self.groups.clear();
    }
}

/// `open`'s mapping of the migration unit's storage errors: a `Codec` error carries its own
/// detail ("app_meta schema is malformed", "app_meta identity is malformed"), every other one is
/// `ClientError::from`.
fn schema_error(e: StorageError) -> ClientError {
    match e {
        StorageError::Codec(m) => ClientError::new(E_CORE_STORAGE, m),
        other => other.into(),
    }
}

/// The v1 -> v2 backfill (L-CORE-20), inside the unit that ran `MIGRATE_V1_TO_V2`, so a failure
/// anywhere rolls the `ALTER TABLE`s back with it and the store stays v1 until the next open:
/// (a) the identity record, when present, is rewritten as v2; (b) `mention` is set on every
/// status-0 type-0 row from another user (by `sender_user`: the own user's other devices are
/// excluded too, ruling 29) whose body `mentions_me`; (c) `epoch` and `pending_commit` of every
/// row in states 0-3 are read from its stored MLS group.
///
/// A row with no stored MLS group (a discarded resync) keeps `0, 0`, which is what the writers
/// leave for it. Any other load error (storage, decode, binding) fails the migration: a store
/// this build cannot read now may read fine at the next open (a transient storage error), and
/// `take_group` compares only the id, kind, target and community, so a column backfilled as 0
/// for a group that does load would be wrong until its next merge, with nothing to report it.
/// The store is device-local and written only by this browser: only a store this build did not
/// write, or a failing disk, fails here.
///
/// Loads through `storage`, the unit's own: no second `DillaStorage` over the connection.
fn backfill(storage: &DillaStorage, u: &UnitScope<'_>) -> Result<(), StorageError> {
    let own_user =
        identity::upgrade_identity_record(u).map_err(|e| StorageError::Codec(e.detail))?;
    // (b) and the ids of (c), in one `with_conn`. The mention flag is `mentions_me` evaluated by
    // SQLite: the same three needles (`mention_needle`, "<@everyone>", "<@here>") and the same
    // byte match (`instr` compares the bytes of its two text arguments), in one statement, which
    // costs the browser build far less than a row loop calling `mentions_me`.
    // `a_v1_store_flags_mentions_as_mentions_me_does` pins the equivalence on mentions_me's own
    // vectors.
    let ids = u.with_conn(|c| {
        if let Some(user) = own_user {
            c.execute(
                "UPDATE app_messages SET mention = 1 \
                 WHERE status = 0 AND type = 0 AND sender_user <> ?1 \
                 AND (instr(body, CAST(?2 AS TEXT)) > 0 \
                 OR instr(body, '<@everyone>') > 0 OR instr(body, '<@here>') > 0)",
                rusqlite::params![user.as_slice(), messages::mention_needle(&user).as_slice()],
            )?;
        }
        let mut s = c.prepare(
            "SELECT group_id FROM app_groups WHERE state IN (0, 1, 2, 3) ORDER BY group_id",
        )?;
        let mut rows = s.query([])?;
        let mut ids: Vec<[u8; 16]> = Vec::new();
        while let Some(r) = rows.next()? {
            ids.push(r.get(0)?);
        }
        Ok(ids)
    })?;
    for id in ids {
        // Outside `with_conn`: the load reads through the storage, which takes the connection.
        match DillaGroup::load_stored(storage, &GroupId::from_slice(&id)) {
            Ok(Some(g)) => {
                let epoch = i64::try_from(g.epoch())
                    .map_err(|_| StorageError::Codec("epoch out of range".into()))?;
                u.with_conn(|c| groups::set_mls(c, &id, epoch, g.has_pending_commit()))?;
            }
            Ok(None) => {}
            Err(crate::mls::MlsError::Storage(e)) => return Err(e),
            Err(e) => return Err(StorageError::Codec(e.to_string())),
        }
    }
    Ok(())
}
