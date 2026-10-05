//! Browser and desktop client engine: Rust decides and persists; the caller transports.
//! Every structured value crossing the boundary is one deterministic CBOR item. Every state
//! change runs inside exactly one `DillaStorage::unit`.

mod error;
mod groups;
mod identity;
mod messages;
mod schema;
mod sync;
mod wire;

pub use error::ClientError;
pub use identity::session_preimage;
pub use schema::{HANDSHAKE_TAIL, migrate_app};

use crate::cbor::decode_strict;
use crate::identity::CredentialIdentity;
use crate::mls::{CIPHERSUITE, ConnHandle, DillaGroup, DillaProvider, StorageError, UnitScope};
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

    fn take_group(&mut self, group_id: &[u8; 16]) -> Result<Option<DillaGroup>, ClientError> {
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
        schema::migrate_app(provider.storage())?;
        let schema = provider
            .storage()
            .unit(|u| u.with_conn(|c| schema::meta_get(c, schema::SCHEMA)))
            .map_err(|e| match e {
                crate::mls::TxError::RolledBack(e) => e.into(),
                other => ClientError::new(E_CORE_STORAGE, other.to_string()),
            })?;
        let version = schema
            .and_then(|b| decode_strict(&b, |d| d.uint()).ok())
            .ok_or_else(|| ClientError::new(E_CORE_STORAGE, "app_meta schema is malformed"))?;
        if version > 1 {
            return Err(ClientError::new(
                E_CORE_STATE,
                format!("app schema {version} is newer than this build"),
            ));
        }
        let (identity, signup) = provider
            .storage()
            .unit(|u| u.with_conn(identity::load_phase))
            .map_err(|e| match e {
                crate::mls::TxError::RolledBack(e) => e.into(),
                other => ClientError::new(E_CORE_STORAGE, other.to_string()),
            })?;
        let phase = identity::decode_phase(identity, signup)?;
        let dsk_pub = match &phase {
            identity::Phase::None => None,
            identity::Phase::Pending(rec) => Some(rec.dsk_pub()),
            identity::Phase::Ready(rec) => Some(rec.dsk_pub),
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
