//! The instance-signed account-kind attestation (protocol/03 § Account kind attestation, Task S1
//! part 2).
//!
//! A leaf credential's `kind` is signed by its own user's SSK, so it is the user's claim. The
//! instance states each account's kind in an attestation signed with its external-sender key,
//! which this client pinned (`schema::INSTANCE_SIGNER_KEY`, or `BOT_INSTANCE_KEY` for a managed
//! Bot):
//!
//! ```text
//! message     = "dilla account kind v1" || CBOR([1, instance_id(16), user_id(16), umk_pub(32), kind])
//! attestation = CBOR([1, key_id(16), kind, sig(64)])
//! ```
//!
//! `account_kind_ingest` stores an attestation (one row per user) and records that this client
//! has seen one from its instance. `leaf_kind_verdict`, called from `trust::leaf_verdict`, judges
//! every leaf: with a stored attestation the signature must verify over the leaf's own UMK and the
//! credential's kind must be the attested kind; without one, a client that has seen an attestation
//! leaves the leaf pending (`E_DEVICE_LIST_STALE`) and a client that has not keeps the earlier rule
//! (the transition window `protocol/07` describes).

use super::error::{E_CORE_INPUT, E_CORE_STATE, E_CREDENTIAL, E_DEVICE_LIST_STALE};
use super::{ClientCore, ClientError, schema};
use crate::identity::CredentialIdentity;
pub use crate::identity::{AccountKindAttestation, account_kind_message};
use crate::mls::StorageError;
use ed25519_dalek::{Signature, VerifyingKey};
use rusqlite::{OptionalExtension, params};

/// `app_meta` key: this client has stored an attestation from its instance (the per-instance
/// "attestation seen" flag; a store holds one instance's identity).
pub(super) const ACCOUNT_KIND_SEEN: &str = "account_kind_seen";

pub(super) const ACCOUNT_KINDS_SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS app_account_kinds (
  user_id BLOB PRIMARY KEY CHECK(length(user_id)=16),
  kind INTEGER NOT NULL CHECK(kind IN (0,1)),
  key_id BLOB NOT NULL CHECK(length(key_id)=16),
  signature BLOB NOT NULL CHECK(length(signature)=64),
  instance_key BLOB NOT NULL CHECK(length(instance_key)=32),
  instance_id BLOB NOT NULL CHECK(length(instance_id)=16)
);
";

/// The pinned instance key and the store's instance id.
type PinnedInstance = ([u8; 32], [u8; 16]);
/// A stored attestation row: kind, signature, instance key, instance id.
type StoredAttestation = (i64, Vec<u8>, Vec<u8>, Vec<u8>);

/// The pinned instance key and this store's instance id, or `None` before either exists.
fn pinned_instance(c: &rusqlite::Connection) -> Result<Option<PinnedInstance>, StorageError> {
    let key = match schema::meta_get(c, schema::INSTANCE_SIGNER_KEY)? {
        Some(k) => Some(k),
        None => schema::meta_get(c, schema::BOT_INSTANCE_KEY)?,
    };
    let Some(key) = key else { return Ok(None) };
    let key: [u8; 32] = key
        .try_into()
        .map_err(|_| StorageError::Codec("malformed pinned instance key".into()))?;
    let Some(identity) = schema::meta_get(c, schema::IDENTITY)? else {
        return Ok(None);
    };
    let record = super::identity::IdentityRecord::decode(&identity)
        .map_err(|_| StorageError::Codec("app_meta identity is malformed".into()))?;
    Ok(Some((key, record.instance_id)))
}

/// The leaf's account-kind verdict: `None` when it passes (or the transition window keeps the
/// earlier rule), else the code that refuses it. The leaf's UMK has already been checked against
/// the user's pin by the caller.
pub(super) fn leaf_kind_verdict(
    c: &rusqlite::Connection,
    leaf: &CredentialIdentity,
) -> Result<Option<&'static str>, StorageError> {
    let row: Option<StoredAttestation> = c
        .query_row(
            "SELECT kind,signature,instance_key,instance_id FROM app_account_kinds WHERE user_id=?1",
            [leaf.user_id.as_bytes().as_slice()],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .optional()?;
    let Some((kind, signature, key, instance)) = row else {
        // Missing: refused (pending) once this client has seen an attestation from its instance.
        return Ok(if schema::meta_get(c, ACCOUNT_KIND_SEEN)?.is_some() {
            Some(E_DEVICE_LIST_STALE)
        } else {
            None
        });
    };
    let (Ok(signature), Ok(key), Ok(instance)) = (
        <[u8; 64]>::try_from(signature.as_slice()),
        <[u8; 32]>::try_from(key.as_slice()),
        <[u8; 16]>::try_from(instance.as_slice()),
    ) else {
        return Ok(Some(E_DEVICE_LIST_STALE));
    };
    let Ok(kind) = u8::try_from(kind) else {
        return Ok(Some(E_DEVICE_LIST_STALE));
    };
    let message = account_kind_message(&instance, leaf.user_id.as_bytes(), &leaf.umk_pub, kind);
    let verifies = VerifyingKey::from_bytes(&key)
        .map(|k| {
            k.verify_strict(&message, &Signature::from_bytes(&signature))
                .is_ok()
        })
        .unwrap_or(false);
    if !verifies {
        // Not the instance's statement about this account and key: the leaf stays untrusted until
        // a valid attestation arrives (a server can withhold, never forge).
        return Ok(Some(E_DEVICE_LIST_STALE));
    }
    Ok(if kind == leaf.kind.as_u8() {
        None
    } else {
        Some(E_CREDENTIAL)
    })
}

impl ClientCore {
    /// Store the instance's account-kind attestation for `user_id` (the fifth element of a wire-4
    /// device-list head) before that user's signed history is ingested. Its signature is checked
    /// against each leaf's UMK when the leaf is judged; here only its shape and the pinned key are.
    /// Storing one records that this client has seen an attestation from its instance: from then
    /// on, a user without one is untrusted.
    pub fn account_kind_ingest(
        &mut self,
        user_id: &[u8; 16],
        attestation: &[u8],
    ) -> Result<(), ClientError> {
        if *user_id == [0; 16] {
            return Err(ClientError::new(E_CORE_INPUT, "user_id is all zero"));
        }
        let attestation = AccountKindAttestation::decode(attestation)
            .map_err(|_| ClientError::new(E_CREDENTIAL, "malformed account-kind attestation"))?;
        self.write(|_, u| {
            let (key, instance) = u.with_conn(pinned_instance)?.ok_or_else(|| {
                ClientError::new(E_CORE_STATE, "instance signing key is not pinned")
            })?;
            u.with_conn(|c| {
                c.execute(
                    "INSERT INTO app_account_kinds(user_id,kind,key_id,signature,instance_key,instance_id) \
                     VALUES(?1,?2,?3,?4,?5,?6) ON CONFLICT(user_id) DO UPDATE SET kind=excluded.kind, \
                     key_id=excluded.key_id,signature=excluded.signature,instance_key=excluded.instance_key, \
                     instance_id=excluded.instance_id",
                    params![
                        user_id.as_slice(),
                        i64::from(attestation.kind),
                        attestation.key_id.as_slice(),
                        attestation.signature.as_slice(),
                        key.as_slice(),
                        instance.as_slice()
                    ],
                )?;
                schema::meta_put(c, ACCOUNT_KIND_SEEN, &[1])?;
                super::trust::bump_generation(c)
            })?;
            Ok(())
        })
    }

    /// Whether this client has seen an account-kind attestation from its instance.
    pub fn account_kind_seen(&self) -> Result<bool, ClientError> {
        self.read(|c| Ok(schema::meta_get(c, ACCOUNT_KIND_SEEN)?.is_some()))
    }
}
