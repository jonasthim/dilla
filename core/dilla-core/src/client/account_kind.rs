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

/// `app_account_kinds` holds one verified attestation per user (verified at ingest against the
/// pinned instance key and the user's validated UMK, and again per leaf). `app_account_kind_staged`
/// holds the one offered for a user this client has no pin for yet: `ingest_leaf` verifies it against
/// the UMK the history it validates establishes, in the same unit, before it judges the user's leaves.
pub(super) const ACCOUNT_KINDS_SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS app_account_kinds (
  user_id BLOB PRIMARY KEY CHECK(length(user_id)=16),
  kind INTEGER NOT NULL CHECK(kind IN (0,1)),
  key_id BLOB NOT NULL CHECK(length(key_id)=16),
  signature BLOB NOT NULL CHECK(length(signature)=64),
  instance_key BLOB NOT NULL CHECK(length(instance_key)=32),
  instance_id BLOB NOT NULL CHECK(length(instance_id)=16),
  umk_pub BLOB CHECK(umk_pub IS NULL OR length(umk_pub)=32)
);
CREATE TABLE IF NOT EXISTS app_account_kind_staged (
  user_id BLOB PRIMARY KEY CHECK(length(user_id)=16),
  attestation BLOB NOT NULL CHECK(length(attestation)>0)
);
";

/// The pinned instance key and the store's instance id.
type PinnedInstance = ([u8; 32], [u8; 16]);
/// A stored attestation row: kind, signature, instance key, instance id.
type StoredAttestation = (i64, Vec<u8>, Vec<u8>, Vec<u8>);
/// A stored row with the UMK its signature verified over (fix round 3).
type StoredRow = (i64, Vec<u8>, Vec<u8>, Vec<u8>, Option<Vec<u8>>);

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
    let user = leaf.user_id.as_bytes();
    let row: Option<StoredRow> = c
        .query_row(
            "SELECT kind,signature,instance_key,instance_id,umk_pub FROM app_account_kinds WHERE user_id=?1",
            [user.as_slice()],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
        )
        .optional()?;
    let judge = |kind: u8| {
        if kind == leaf.kind.as_u8() {
            None
        } else {
            Some(E_CREDENTIAL)
        }
    };
    // An attestation over the leaf's own UMK decides, whoever verified the key.
    let stored = row
        .as_ref()
        .map(|(kind, sig, key, instance, _)| (*kind, sig.clone(), key.clone(), instance.clone()));
    if let Some(kind) = stored
        .as_ref()
        .and_then(|s| stored_verifies(s, user, &leaf.umk_pub))
    {
        return Ok(judge(kind));
    }
    // Fix round 3 ("your verification wins"): a UMK this person verified needs no attestation
    // over it; the server cannot attest a key it never saw registered with proof. An account's kind
    // never changes, so an attestation the client verified over an earlier UMK of the same user
    // still states it: the credential's kind must match it. With none, the earlier rule holds for
    // this key (the core does not judge kind; the web still requires the server's member row of
    // account kind 1 before it shows a Bot).
    if person_verified(c, user, &leaf.umk_pub)? {
        let earlier = row.as_ref().and_then(|(.., umk)| {
            let umk = <[u8; 32]>::try_from(umk.as_deref()?).ok()?;
            stored.as_ref().and_then(|s| stored_verifies(s, user, &umk))
        });
        return Ok(earlier.and_then(judge));
    }
    if row.is_some() {
        // Not the instance's statement about this account and key, and not a key this person
        // verified: the leaf stays untrusted until a valid attestation arrives.
        return Ok(Some(E_DEVICE_LIST_STALE));
    }
    // Missing: refused (pending) once this client has seen an attestation from its instance.
    Ok(if schema::meta_get(c, ACCOUNT_KIND_SEEN)?.is_some() {
        Some(E_DEVICE_LIST_STALE)
    } else {
        None
    })
}

/// The UMK of `umks` over which `attestation` is the pinned instance's statement about `user`.
fn verifies(
    key: &[u8; 32],
    instance: &[u8; 16],
    user: &[u8; 16],
    umks: &[[u8; 32]],
    a: &AccountKindAttestation,
) -> Option<[u8; 32]> {
    let k = VerifyingKey::from_bytes(key).ok()?;
    let sig = Signature::from_bytes(&a.signature);
    umks.iter().copied().find(|umk| {
        k.verify_strict(&account_kind_message(instance, user, umk, a.kind), &sig)
            .is_ok()
    })
}

/// Whether `stored` (kind, signature, instance key, instance id) is the instance's statement about
/// `user` over `umk`.
fn stored_verifies(stored: &StoredAttestation, user: &[u8; 16], umk: &[u8; 32]) -> Option<u8> {
    let (kind, signature, key, instance) = stored;
    let signature = <[u8; 64]>::try_from(signature.as_slice()).ok()?;
    let key = <[u8; 32]>::try_from(key.as_slice()).ok()?;
    let instance = <[u8; 16]>::try_from(instance.as_slice()).ok()?;
    let kind = u8::try_from(*kind).ok()?;
    let message = account_kind_message(&instance, user, umk, kind);
    VerifyingKey::from_bytes(&key)
        .ok()?
        .verify_strict(&message, &Signature::from_bytes(&signature))
        .ok()
        .map(|()| kind)
}

/// Fix round 3 ("your verification wins"): the leaf's UMK is the user's pinned key, verified by
/// this person (`trust_verify`: exact-key verification, or approving a changed key) and with no
/// change pending.
fn person_verified(
    c: &rusqlite::Connection,
    user: &[u8; 16],
    umk: &[u8; 32],
) -> Result<bool, StorageError> {
    Ok(c
        .query_row(
            "SELECT 1 FROM app_trust_pins WHERE user_id=?1 AND umk_pub=?2 AND verified=1 AND changed_umk IS NULL",
            params![user.as_slice(), umk.as_slice()],
            |_| Ok(()),
        )
        .optional()?
        .is_some())
}

/// The outcome of offering an attestation for storage.
#[derive(Debug, PartialEq, Eq)]
pub(super) enum Promotion {
    /// Stored (or already stored): `changed` says the row or the "seen" flag changed.
    Stored { changed: bool },
    /// It does not verify: nothing stored, and a verifying row already held is kept.
    Refused,
}

/// Store `a` for `user` if it verifies under the pinned instance key over one of `umks`; set the
/// "seen" flag only then. A verifying row is never replaced by one that does not verify (a refused
/// one changes nothing), and an identical one is no write (I1: no generation bump).
pub(super) fn promote(
    c: &rusqlite::Connection,
    user: &[u8; 16],
    a: &AccountKindAttestation,
    umks: &[[u8; 32]],
) -> Result<Promotion, StorageError> {
    let Some((key, instance)) = pinned_instance(c)? else {
        return Ok(Promotion::Refused);
    };
    let Some(over) = verifies(&key, &instance, user, umks, a) else {
        return Ok(Promotion::Refused);
    };
    let held: Option<StoredAttestation> = c
        .query_row(
            "SELECT kind,signature,instance_key,instance_id FROM app_account_kinds WHERE user_id=?1",
            [user.as_slice()],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .optional()?;
    let same = held.is_some_and(|(kind, sig, k, i)| {
        kind == i64::from(a.kind) && sig == a.signature && k == key && i == instance
    });
    let mut changed = false;
    if !same {
        c.execute(
            "INSERT INTO app_account_kinds(user_id,kind,key_id,signature,instance_key,instance_id,umk_pub) \
             VALUES(?1,?2,?3,?4,?5,?6,?7) ON CONFLICT(user_id) DO UPDATE SET kind=excluded.kind, \
             key_id=excluded.key_id,signature=excluded.signature,instance_key=excluded.instance_key, \
             instance_id=excluded.instance_id,umk_pub=excluded.umk_pub",
            params![
                user.as_slice(),
                i64::from(a.kind),
                a.key_id.as_slice(),
                a.signature.as_slice(),
                key.as_slice(),
                instance.as_slice(),
                over.as_slice()
            ],
        )?;
        changed = true;
    }
    if schema::meta_get(c, ACCOUNT_KIND_SEEN)?.is_none() {
        schema::meta_put(c, ACCOUNT_KIND_SEEN, &[1])?;
        changed = true;
    }
    Ok(Promotion::Stored { changed })
}

/// The attestation staged for `user` (offered before this client held a pin for it), removed.
pub(super) fn take_staged(
    c: &rusqlite::Connection,
    user: &[u8; 16],
) -> Result<Option<AccountKindAttestation>, StorageError> {
    let raw: Option<Vec<u8>> = c
        .query_row(
            "SELECT attestation FROM app_account_kind_staged WHERE user_id=?1",
            [user.as_slice()],
            |r| r.get(0),
        )
        .optional()?;
    let Some(raw) = raw else { return Ok(None) };
    c.execute(
        "DELETE FROM app_account_kind_staged WHERE user_id=?1",
        [user.as_slice()],
    )?;
    // Every staged blob was decoded before it was staged, so one that does not decode now is a
    // corrupt store, not server input: an explicit storage error, never a silent drop.
    AccountKindAttestation::decode(&raw)
        .map(Some)
        .map_err(|_| StorageError::Codec("staged account-kind attestation is malformed".into()))
}

/// Stage `attestation` for `user`: the next step that validates the user's history and pins a UMK
/// (`ingest_leaf`), or the approval of a changed UMK (`trust_verify`), verifies it over that UMK.
fn stage(
    c: &rusqlite::Connection,
    user: &[u8; 16],
    attestation: &[u8],
) -> Result<(), StorageError> {
    c.execute(
        "INSERT INTO app_account_kind_staged(user_id,attestation) VALUES(?1,?2) \
         ON CONFLICT(user_id) DO UPDATE SET attestation=excluded.attestation",
        params![user.as_slice(), attestation],
    )?;
    Ok(())
}

impl ClientCore {
    /// Offer the instance's account-kind attestation for `user_id` (the fifth element of a wire-4
    /// device-list head) before that user's signed history is ingested. It is verified before it is
    /// stored (fix round 1, M1): against the pinned instance key and the user's pinned UMK (or a
    /// pending changed one) when this client holds a pin. Otherwise (no pin yet, or a UMK the
    /// client has not recorded: a key change) it is staged, and the step that validates the user's
    /// history and pins a UMK (`ingest_leaf`), or the approval of a changed UMK (`trust_verify`),
    /// verifies it over that UMK. A verified one sets the "attestation seen" flag; one that does not
    /// verify is never stored and never replaces one verified over the same UMK. Only a malformed
    /// attestation is refused (`E_CORE_INPUT`).
    pub fn account_kind_ingest(
        &mut self,
        user_id: &[u8; 16],
        attestation: &[u8],
    ) -> Result<(), ClientError> {
        if *user_id == [0; 16] {
            return Err(ClientError::new(E_CORE_INPUT, "user_id is all zero"));
        }
        // A malformed attestation is the server's input error (E_CORE_INPUT), never E_CREDENTIAL:
        // that code is the leaf verdict of a verified attestation of another kind, and a server must
        // not be able to steer a client into showing it.
        let decoded = AccountKindAttestation::decode(attestation)
            .map_err(|_| ClientError::new(E_CORE_INPUT, "malformed account-kind attestation"))?;
        self.write(|_, u| {
            if u.with_conn(pinned_instance)?.is_none() {
                return Err(ClientError::new(
                    E_CORE_STATE,
                    "instance signing key is not pinned",
                ));
            }
            let pin: Option<(Vec<u8>, Option<Vec<u8>>)> = u.with_conn(|c| {
                c.query_row(
                    "SELECT umk_pub,changed_umk FROM app_trust_pins WHERE user_id=?1",
                    [user_id.as_slice()],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .optional()
                .map_err(Into::into)
            })?;
            let Some((umk, changed)) = pin else {
                u.with_conn(|c| stage(c, user_id, attestation))?;
                return Ok(());
            };
            // A pin's UMKs are 32 bytes (the table's CHECK); anything else is a corrupt store.
            let mut umks = Vec::with_capacity(2);
            for key in [Some(umk), changed].into_iter().flatten() {
                umks.push(<[u8; 32]>::try_from(key.as_slice()).map_err(|_| {
                    ClientError::new(super::error::E_CORE_STORAGE, "a pinned UMK is not 32 bytes")
                })?);
            }
            match u.with_conn(|c| promote(c, user_id, &decoded, &umks))? {
                // Fix round 2: not over the pinned UMK or the pending change. The served list may be
                // under a new UMK this client has not recorded yet, so the attestation is staged, never
                // refused: the history ingest still runs, records the change (E_UMK_CHANGED) and
                // verifies the staged attestation over the UMK that history establishes.
                Promotion::Refused => {
                    u.with_conn(|c| stage(c, user_id, attestation))?;
                    Ok(())
                }
                Promotion::Stored { changed } => {
                    if changed {
                        u.with_conn(super::trust::bump_generation)?;
                    }
                    Ok(())
                }
            }
        })
    }

    /// Whether this client has seen an account-kind attestation from its instance.
    pub fn account_kind_seen(&self) -> Result<bool, ClientError> {
        self.read(|c| Ok(schema::meta_get(c, ACCOUNT_KIND_SEEN)?.is_some()))
    }
}
