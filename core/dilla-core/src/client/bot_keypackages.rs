//! Durable identity-scoped native Bot KeyPackage publication intents.

use super::error::{E_CORE_INPUT, E_CORE_STATE, E_CORE_STORAGE};
use super::{ClientCore, ClientError, bot_identity, identity, schema, wire};
use crate::bot::keypackage::{Intent, IntentResult, Resolution};
use crate::cbor::{Encoder, decode_strict};
use crate::identity::{CredentialIdentity, sha256};
use crate::mls::{StorageError, UnitScope, build_key_package_with_expiry};
use openmls::prelude::{BasicCredential, CredentialWithKey, MlsMessageOut};
use openmls_traits::OpenMlsProvider;
use rusqlite::{OptionalExtension, params};
use tls_codec::Serialize;

type PendingRow = (Vec<u8>, i64, Vec<u8>, Vec<u8>, i64, i64, Option<Vec<u8>>);
type ResolutionRow = (Vec<u8>, i64, Vec<u8>, i64, Option<Vec<u8>>);

fn malformed() -> ClientError {
    ClientError::new(E_CORE_INPUT, "bot KeyPackage intent is malformed")
}

fn conflict() -> ClientError {
    ClientError::new(
        E_CORE_STATE,
        "bot KeyPackage intent conflicts with an existing operation",
    )
}

fn storage_malformed() -> ClientError {
    ClientError::new(E_CORE_STORAGE, "native bot KeyPackage intent is malformed")
}

fn refs_encode(refs: &[[u8; 32]]) -> Vec<u8> {
    let mut e = Encoder::new();
    e.array(refs.len());
    for r in refs {
        e.bytes(r);
    }
    e.into_vec()
}

fn refs_decode(raw: &[u8]) -> Result<Vec<[u8; 32]>, ClientError> {
    decode_strict(raw, |d| {
        let n = d.array_len()?;
        if !(1..=33).contains(&n) {
            return Err(crate::cbor::CborError::WrongArrayLen {
                expected: 33,
                actual: n,
            });
        }
        let mut refs = Vec::with_capacity(n);
        for _ in 0..n {
            let r = d.bytes_exact::<32>()?;
            if refs.contains(&r) {
                return Err(crate::cbor::CborError::TypeMismatch {
                    expected: "distinct MLS KeyPackage refs",
                    offset: d.position(),
                });
            }
            refs.push(r);
        }
        Ok(refs)
    })
    .map_err(|_| storage_malformed())
}

fn intent_hash(intent: &Intent) -> [u8; 32] {
    let mut e = Encoder::new();
    e.array(3)
        .uint(intent.count)
        .uint(intent.last_resort)
        .uint(intent.expected_generation);
    sha256(&e.into_vec())
}

fn resolution_hash(resolution: &Resolution) -> [u8; 32] {
    let mut e = Encoder::new();
    e.array(2).uint(resolution.outcome);
    e.array(resolution.package_refs.len());
    for r in &resolution.package_refs {
        e.bytes(r);
    }
    sha256(&e.into_vec())
}

fn identity_and_binding(
    u: &UnitScope<'_>,
    instance_id: &[u8; 16],
    community_id: &[u8; 16],
    installation_id: &[u8; 16],
) -> Result<identity::IdentityRecord, ClientError> {
    let (identity_raw, signup, enrol) = u.with_conn(identity::load_phase)?;
    let record = match identity::decode_phase(identity_raw, signup, enrol)? {
        identity::Phase::Ready(rec) => rec,
        _ => {
            return Err(ClientError::new(
                E_CORE_STATE,
                "fully enrolled native Bot required",
            ));
        }
    };
    let credential = CredentialIdentity::decode(&record.credential)
        .map_err(|_| ClientError::new(E_CORE_STORAGE, "identity credential is malformed"))?;
    let raw = u
        .with_conn(|c| schema::meta_get(c, schema::BOT_BINDING))?
        .ok_or_else(|| ClientError::new(E_CORE_STATE, "native Bot binding required"))?;
    let binding = bot_identity::decode_binding(&raw)?;
    if credential.kind.as_u8() != 1
        || credential.tier.as_u8() != 0
        || credential.signer_tier.as_u8() != 0
        || record.instance_id != *instance_id
        || binding.instance_id != *instance_id
        || binding.community_id != *community_id
        || binding.installation_id != *installation_id
        || !bot_identity::nonzero_ids(&binding)
    {
        return Err(ClientError::new(
            E_CORE_STATE,
            "native Bot installation binding mismatch",
        ));
    }
    bot_identity::validate_ready(&record)?;
    Ok(record)
}

impl ClientCore {
    /// Create or exactly retry a native KeyPackage publication intent. The helper passes its
    /// validated installation tuple and the shared typed Op5 intent codec.
    pub fn bot_keypackage_intent(
        &mut self,
        instance_id: &[u8; 16],
        community_id: &[u8; 16],
        installation_id: &[u8; 16],
        encoded_intent: &[u8],
    ) -> Result<Vec<u8>, ClientError> {
        let intent = Intent::decode(encoded_intent).map_err(|_| malformed())?;
        let input_hash = intent_hash(&intent);
        self.write(|ctx, u| {
            let record = identity_and_binding(u, instance_id, community_id, installation_id)?;
            let found: Option<PendingRow> = u.with_conn(|c| {
                c.query_row(
                    "SELECT operation_id,expected_generation,input_hash,package_refs,greatest_expiry,state,upload_body FROM app_bot_keypackage_intents WHERE instance_id=?1 AND community_id=?2 AND installation_id=?3 AND device_id=?4 AND state=0",
                    params![instance_id.as_slice(), community_id.as_slice(), installation_id.as_slice(), record.device_id.as_slice()],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?)),
                ).optional().map_err(Into::into)
            })?;
            if let Some((op, generation, hash, refs, expiry, _, body)) = found {
                if op.as_slice() == intent.operation_id.as_bytes()
                    && generation == intent.expected_generation as i64
                    && hash.as_slice() == input_hash
                {
                    let body = body.ok_or_else(storage_malformed)?;
                    let result = IntentResult {
                        upload_body: body,
                        package_refs: refs_decode(&refs)?,
                        greatest_expiry: u64::try_from(expiry).map_err(|_| storage_malformed())?,
                    };
                    return result.encode().map_err(|_| storage_malformed());
                }
                return Err(conflict());
            }

            let existing: Option<(Vec<u8>, i64, Vec<u8>)> = u.with_conn(|c| {
                c.query_row(
                    "SELECT input_hash,state,resolution_hash FROM app_bot_keypackage_intents WHERE operation_id=?1",
                    [intent.operation_id.as_bytes().as_slice()],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
                ).optional().map_err(Into::into)
            })?;
            if existing.is_some() {
                return Err(conflict());
            }

            let signer = ctx.signer.ok_or_else(|| ClientError::new(E_CORE_STATE, "the device key is not loaded"))?;
            let credential = CredentialWithKey {
                credential: BasicCredential::new(record.credential).into(),
                signature_key: signer.public().into(),
            };
            let mut packages = Vec::with_capacity(intent.count as usize);
            let mut refs = Vec::with_capacity(intent.count as usize + intent.last_resort as usize);
            let mut greatest_expiry = 0;
            for _ in 0..intent.count {
                let (bundle, expiry) = build_key_package_with_expiry(ctx.provider, signer, credential.clone(), false)?;
                let kp = bundle.key_package();
                let reference = kp.hash_ref(ctx.provider.crypto()).map_err(|e| ClientError::new(super::error::E_CORE_MLS, format!("KeyPackage ref: {e:?}")))?;
                let reference: [u8; 32] = reference.as_slice().try_into().map_err(|_| ClientError::new(E_CORE_STATE, "MLS KeyPackage ref is not 32 bytes"))?;
                refs.push(reference);
                greatest_expiry = greatest_expiry.max(expiry);
                packages.push(MlsMessageOut::from(kp.clone()).tls_serialize_detached().map_err(|e| ClientError::new(super::error::E_CORE_MLS, format!("serialize: {e:?}")))?);
            }
            let last = if intent.last_resort == 1 {
                let (bundle, expiry) = build_key_package_with_expiry(ctx.provider, signer, credential, true)?;
                let kp = bundle.key_package();
                let reference = kp.hash_ref(ctx.provider.crypto()).map_err(|e| ClientError::new(super::error::E_CORE_MLS, format!("KeyPackage ref: {e:?}")))?;
                refs.push(reference.as_slice().try_into().map_err(|_| ClientError::new(E_CORE_STATE, "MLS KeyPackage ref is not 32 bytes"))?);
                greatest_expiry = greatest_expiry.max(expiry);
                Some(MlsMessageOut::from(kp.clone()).tls_serialize_detached().map_err(|e| ClientError::new(super::error::E_CORE_MLS, format!("serialize: {e:?}")))?)
            } else { None };
            let upload_body = wire::key_packages_body(&packages, last.as_deref());
            let result = IntentResult { upload_body: upload_body.clone(), package_refs: refs.clone(), greatest_expiry };
            let encoded_result = result.encode().map_err(|_| ClientError::new(E_CORE_INPUT, "generated KeyPackages exceed publication limits"))?;
            let refs_blob = refs_encode(&refs);
            u.with_conn(|c| {
                c.execute(
                    "INSERT INTO app_bot_keypackage_intents(operation_id,instance_id,community_id,installation_id,device_id,input_hash,expected_generation,upload_body,package_refs,greatest_expiry,state,resolution_hash) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,0,NULL)",
                    params![intent.operation_id.as_bytes().as_slice(), instance_id.as_slice(), community_id.as_slice(), installation_id.as_slice(), record.device_id.as_slice(), input_hash.as_slice(), intent.expected_generation as i64, upload_body, refs_blob, greatest_expiry as i64],
                ).map_err(StorageError::from)?;
                Ok(())
            })?;
            Ok(encoded_result)
        })
    }

    /// Resolve a pending batch from the narrow outcome already validated by the trusted Go
    /// parent. The native helper checks the stored operation and complete ordered ref set, and
    /// enforces generation/expiry evidence for an obsolete outcome.
    pub fn bot_keypackage_resolve(
        &mut self,
        instance_id: &[u8; 16],
        community_id: &[u8; 16],
        installation_id: &[u8; 16],
        encoded_resolution: &[u8],
    ) -> Result<(), ClientError> {
        let resolution = Resolution::decode(encoded_resolution).map_err(|_| malformed())?;
        let desired_hash = resolution_hash(&resolution);
        self.write(|_, u| {
            let record = identity_and_binding(u, instance_id, community_id, installation_id)?;
            let row: Option<ResolutionRow> = u.with_conn(|c| {
                c.query_row(
                    "SELECT package_refs,expected_generation,input_hash,greatest_expiry,resolution_hash FROM app_bot_keypackage_intents WHERE operation_id=?1 AND instance_id=?2 AND community_id=?3 AND installation_id=?4 AND device_id=?5",
                    params![resolution.operation_id.as_bytes().as_slice(), instance_id.as_slice(), community_id.as_slice(), installation_id.as_slice(), record.device_id.as_slice()],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
                ).optional().map_err(Into::into)
            })?;
            let Some((stored_refs, generation, _, expiry, old_hash)) = row else { return Err(conflict()) };
            let refs = refs_decode(&stored_refs)?;
            if refs != resolution.package_refs { return Err(conflict()) }
            if let Some(old_hash) = old_hash {
                return if old_hash.as_slice() == desired_hash { Ok(()) } else { Err(conflict()) };
            }
            if resolution.outcome == 1
                && !(generation < resolution.current_generation as i64 || expiry <= resolution.now as i64)
            {
                return Err(ClientError::new(E_CORE_STATE, "KeyPackage batch is not proven obsolete"));
            }
            u.with_conn(|c| {
                let changed = c.execute(
                    "UPDATE app_bot_keypackage_intents SET state=?1,upload_body=NULL,resolution_hash=?2 WHERE operation_id=?3 AND state=0",
                    params![if resolution.outcome == 0 { 1 } else { 2 }, desired_hash.as_slice(), resolution.operation_id.as_bytes().as_slice()],
                ).map_err(StorageError::from)?;
                if changed != 1 { return Err(StorageError::Sqlite("KeyPackage intent changed during resolution".into())) }
                Ok(())
            })?;
            Ok(())
        })
    }
}
