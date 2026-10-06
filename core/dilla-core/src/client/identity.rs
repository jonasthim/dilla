//! Browser-rooted identity, signup, session and KeyPackage operations.

use super::error::{E_CORE_INPUT, E_CORE_MLS, E_CORE_NO_IDENTITY, E_CORE_STATE, E_CORE_STORAGE};
use super::{ClientCore, ClientError, schema, wire};
use crate::cbor::{Encoder, decode_strict};
use crate::identity::{
    CredentialIdentity, DeviceEntry, DeviceList, DeviceListUnsigned, Kind, SignerTier, SskSigner,
    Tier, UmkSigner, k_backup, k_header, recovery_key_base32,
};
use crate::ids::{DeviceId, UserId};
use crate::mls::{CIPHERSUITE, DillaProvider, StorageError, build_key_package};
use aes_gcm::aead::{Aead, Payload};
use aes_gcm::{Aes256Gcm, KeyInit, Nonce};
use openmls::prelude::{BasicCredential, CredentialWithKey, MlsMessageOut};
use openmls_basic_credential::SignatureKeyPair;
use openmls_traits::OpenMlsProvider;
use openmls_traits::random::OpenMlsRand;
use openmls_traits::signatures::Signer;
use tls_codec::Serialize;
use zeroize::Zeroizing;

const SESSION_DOMAIN: &[u8; 16] = b"dilla session v1";
const AAD_ROOT: &[u8] = b"dilla root v1";
const AAD_STATE: &[u8] = b"dilla state v1";
const ROOT_SEALED_LEN: usize = 103;
const MAX_KEY_PACKAGES: u32 = 32;
const MAX_TOKEN_BYTES: usize = 256;

/// The protocol/02 Device sessions preimage, also in `protocol/vectors/identity.json`.
/// A `Vec` keeps its 81-byte length observable, including the final purpose byte.
pub fn session_preimage(
    instance: &[u8; 16],
    device: &[u8; 16],
    nonce: &[u8; 32],
    purpose: u8,
) -> Vec<u8> {
    let mut out = Vec::with_capacity(81);
    out.extend_from_slice(SESSION_DOMAIN);
    out.extend_from_slice(instance);
    out.extend_from_slice(device);
    out.extend_from_slice(nonce);
    out.push(purpose);
    out
}

fn malformed(key: &str) -> ClientError {
    ClientError::new(E_CORE_STORAGE, format!("app_meta {key} is malformed"))
}
fn shape() -> crate::cbor::CborError {
    crate::cbor::CborError::TypeMismatch {
        expected: "record",
        offset: 0,
    }
}

pub(super) struct SignupRecord {
    instance_id: [u8; 16],
    device_id: [u8; 16],
    dsk_pub: [u8; 32],
    umk_pub: [u8; 32],
    ssk_pub: [u8; 32],
    sig_umk_ssk: [u8; 64],
    sig_ssk_dev: [u8; 64],
    ssk_priv: Zeroizing<[u8; 32]>,
    k_backup: Zeroizing<[u8; 32]>,
}
impl core::fmt::Debug for SignupRecord {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.write_str("SignupRecord { instance_id, device_id, dsk_pub, umk_pub, ssk_pub, sig_umk_ssk, sig_ssk_dev, ssk_priv, k_backup }")
    }
}
impl SignupRecord {
    pub(super) fn dsk_pub(&self) -> [u8; 32] {
        self.dsk_pub
    }
    fn encode(&self) -> Zeroizing<Vec<u8>> {
        let mut e = Encoder::new();
        e.array(10)
            .uint(1)
            .bytes(&self.instance_id)
            .bytes(&self.device_id)
            .bytes(&self.dsk_pub)
            .bytes(&self.umk_pub)
            .bytes(&self.ssk_pub)
            .bytes(&self.sig_umk_ssk)
            .bytes(&self.sig_ssk_dev)
            .bytes(&*self.ssk_priv)
            .bytes(&*self.k_backup);
        Zeroizing::new(e.into_vec())
    }
    fn decode(bytes: &[u8]) -> Result<Self, ClientError> {
        decode_strict(bytes, |d| {
            d.array(10)?;
            if d.uint()? != 1 {
                return Err(shape());
            }
            Ok(Self {
                instance_id: d.bytes_exact()?,
                device_id: d.bytes_exact()?,
                dsk_pub: d.bytes_exact()?,
                umk_pub: d.bytes_exact()?,
                ssk_pub: d.bytes_exact()?,
                sig_umk_ssk: d.bytes_exact()?,
                sig_ssk_dev: d.bytes_exact()?,
                ssk_priv: Zeroizing::new(d.bytes_exact()?),
                k_backup: Zeroizing::new(d.bytes_exact()?),
            })
        })
        .map_err(|_| malformed(schema::SIGNUP))
    }
}

pub(super) struct IdentityRecord {
    pub(super) instance_id: [u8; 16],
    pub(super) user_id: [u8; 16],
    pub(super) device_id: [u8; 16],
    pub(super) dsk_pub: [u8; 32],
    pub(super) umk_pub: [u8; 32],
    pub(super) ssk_pub: [u8; 32],
    pub(super) username: String,
    pub(super) credential: Vec<u8>,
    pub(super) device_list_body: Vec<u8>,
    pub(super) list_published: bool,
}
impl core::fmt::Debug for IdentityRecord {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.write_str("IdentityRecord { instance_id, user_id, device_id, dsk_pub, umk_pub, ssk_pub, username, credential, device_list_body, list_published }")
    }
}
impl IdentityRecord {
    fn encode(&self) -> Vec<u8> {
        let mut e = Encoder::new();
        e.array(11)
            .uint(1)
            .bytes(&self.instance_id)
            .bytes(&self.user_id)
            .bytes(&self.device_id)
            .bytes(&self.dsk_pub)
            .bytes(&self.umk_pub)
            .bytes(&self.ssk_pub)
            .text(&self.username)
            .bytes(&self.credential)
            .bytes(&self.device_list_body)
            .uint(u64::from(self.list_published));
        e.into_vec()
    }
    pub(super) fn decode(bytes: &[u8]) -> Result<Self, ClientError> {
        decode_strict(bytes, |d| {
            d.array(11)?;
            if d.uint()? != 1 {
                return Err(shape());
            }
            let instance_id = d.bytes_exact()?;
            let user_id = d.bytes_exact()?;
            let device_id = d.bytes_exact()?;
            let dsk_pub = d.bytes_exact()?;
            let umk_pub = d.bytes_exact()?;
            let ssk_pub = d.bytes_exact()?;
            let username = d.text()?.to_owned();
            let credential = d.bytes()?.to_vec();
            let device_list_body = d.bytes()?.to_vec();
            let list_published = match d.uint()? {
                0 => false,
                1 => true,
                _ => return Err(shape()),
            };
            Ok(Self {
                instance_id,
                user_id,
                device_id,
                dsk_pub,
                umk_pub,
                ssk_pub,
                username,
                credential,
                device_list_body,
                list_published,
            })
        })
        .map_err(|_| malformed(schema::IDENTITY))
    }
}

struct SessionRecord {
    token: String,
    expires: u64,
    idle_expires: u64,
}
impl core::fmt::Debug for SessionRecord {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.write_str("SessionRecord { token, expires, idle_expires }")
    }
}
impl SessionRecord {
    fn encode(&self) -> Vec<u8> {
        wire::session_value(Some((&self.token, self.expires, self.idle_expires)))
    }
    fn decode(bytes: &[u8]) -> Result<Self, ClientError> {
        decode_strict(bytes, |d| {
            d.array(3)?;
            Ok(Self {
                token: d.text()?.to_owned(),
                expires: d.uint()?,
                idle_expires: d.uint()?,
            })
        })
        .map_err(|_| malformed(schema::SESSION))
    }
}

pub(super) enum Phase {
    None,
    Pending(SignupRecord),
    Ready(IdentityRecord),
}
#[allow(clippy::type_complexity)] // L-CORE-06 fixes this public-to-sibling signature.
pub(super) fn load_phase(
    c: &rusqlite::Connection,
) -> Result<(Option<Vec<u8>>, Option<Zeroizing<Vec<u8>>>), StorageError> {
    Ok((
        schema::meta_get(c, schema::IDENTITY)?,
        schema::meta_get(c, schema::SIGNUP)?.map(Zeroizing::new),
    ))
}
pub(super) fn decode_phase(
    identity: Option<Vec<u8>>,
    signup: Option<Zeroizing<Vec<u8>>>,
) -> Result<Phase, ClientError> {
    match (identity, signup) {
        (Some(_), Some(_)) => Err(ClientError::new(
            E_CORE_STATE,
            "identity and signup records both present",
        )),
        (Some(b), None) => Ok(Phase::Ready(IdentityRecord::decode(&b)?)),
        (None, Some(b)) => Ok(Phase::Pending(SignupRecord::decode(&b)?)),
        (None, None) => Ok(Phase::None),
    }
}

fn random<const N: usize>(provider: &DillaProvider) -> Result<Zeroizing<[u8; N]>, ClientError> {
    provider
        .rand()
        .random_array::<N>()
        .map(Zeroizing::new)
        .map_err(|e| ClientError::new(E_CORE_MLS, format!("rng: {e}")))
}
fn seal(
    provider: &DillaProvider,
    key: &[u8; 32],
    aad: &[u8],
    plaintext: &[u8],
) -> Result<Vec<u8>, ClientError> {
    let nonce = random::<12>(provider)?;
    let aead = Aes256Gcm::new_from_slice(key)
        .map_err(|_| ClientError::new(E_CORE_MLS, "seal: aead failure"))?;
    let ciphertext = aead
        .encrypt(
            Nonce::from_slice(&*nonce),
            Payload {
                msg: plaintext,
                aad,
            },
        )
        .map_err(|_| ClientError::new(E_CORE_MLS, "seal: aead failure"))?;
    let mut e = Encoder::new();
    e.array(3).uint(1).bytes(&*nonce).bytes(&ciphertext);
    Ok(e.into_vec())
}
fn credential(rec: &SignupRecord, user_id: [u8; 16]) -> CredentialIdentity {
    CredentialIdentity {
        v: 1,
        umk_pub: rec.umk_pub,
        user_id: UserId::from_bytes(user_id),
        device_id: DeviceId::from_bytes(rec.device_id),
        kind: Kind::User,
        tier: Tier::Browser,
        signer_tier: SignerTier::Browser,
        ssk_pub: rec.ssk_pub,
        sig_umk_ssk: rec.sig_umk_ssk,
        sig_ssk_dev: rec.sig_ssk_dev,
    }
}
fn pending(phase: Phase) -> Result<SignupRecord, ClientError> {
    match phase {
        Phase::Pending(rec) => Ok(rec),
        Phase::None => Err(ClientError::new(E_CORE_STATE, "no signup is pending")),
        Phase::Ready(_) => Err(ClientError::new(E_CORE_STATE, "the identity is complete")),
    }
}
fn ready(phase: Phase) -> Result<IdentityRecord, ClientError> {
    match phase {
        Phase::Ready(rec) => Ok(rec),
        _ => Err(ClientError::new(E_CORE_NO_IDENTITY, "")),
    }
}

impl ClientCore {
    fn phase(&self) -> Result<Phase, ClientError> {
        let (identity, signup) = self.read(load_phase)?;
        decode_phase(identity, signup)
    }
    pub fn identity(&self) -> Result<Vec<u8>, ClientError> {
        Ok(match self.phase()? {
            Phase::None => wire::identity_info(0, None, None, None, "", false),
            Phase::Pending(r) => {
                wire::identity_info(1, Some(&r.instance_id), None, Some(&r.device_id), "", false)
            }
            Phase::Ready(r) => wire::identity_info(
                2,
                Some(&r.instance_id),
                Some(&r.user_id),
                Some(&r.device_id),
                &r.username,
                r.list_published,
            ),
        })
    }
    pub fn signup_begin(&mut self, instance_id: &[u8; 16]) -> Result<String, ClientError> {
        match self.phase()? {
            Phase::None => {}
            Phase::Pending(_) => return Err(ClientError::new(E_CORE_STATE, "a signup is pending")),
            Phase::Ready(_) => return Err(ClientError::new(E_CORE_STATE, "an identity exists")),
        }
        let (signer, rk_text) = self.write(|ctx, u| {
            let umk_seed = random::<32>(ctx.provider)?;
            let ssk_seed = random::<32>(ctx.provider)?;
            let rk = random::<32>(ctx.provider)?;
            let device_id = random::<16>(ctx.provider)?;
            let signer = SignatureKeyPair::new(CIPHERSUITE.signature_algorithm())
                .map_err(|e| ClientError::new(E_CORE_MLS, format!("keygen: {e:?}")))?;
            signer.store(ctx.provider.storage())?;
            let dsk_pub: [u8; 32] = signer
                .public()
                .try_into()
                .map_err(|_| ClientError::new(E_CORE_STATE, "dsk is not 32 bytes"))?;
            let umk = UmkSigner::from_bytes(&umk_seed);
            let ssk = SskSigner::from_bytes(&ssk_seed);
            let rec = SignupRecord {
                instance_id: *instance_id,
                device_id: *device_id,
                dsk_pub,
                umk_pub: umk.public(),
                ssk_pub: ssk.public(),
                sig_umk_ssk: umk.sign_ssk(&ssk.public()),
                sig_ssk_dev: ssk.sign_device(
                    &DeviceId::from_bytes(*device_id),
                    &dsk_pub,
                    Kind::User,
                    Tier::Browser,
                    SignerTier::Browser,
                ),
                ssk_priv: ssk_seed,
                k_backup: Zeroizing::new(k_backup(&rk)),
            };
            credential(&rec, [0; 16]).verify_signatures(&dsk_pub)?;
            let mut p = Encoder::new();
            p.array(3).uint(1).bytes(&*umk_seed).bytes(&*rec.ssk_priv);
            let plaintext = Zeroizing::new(p.into_vec());
            let key = Zeroizing::new(k_header(&rk));
            let root = seal(ctx.provider, &key, AAD_ROOT, &plaintext)?;
            if root.len() != ROOT_SEALED_LEN {
                return Err(ClientError::new(
                    E_CORE_STATE,
                    format!("root object is {} bytes", root.len()),
                ));
            }
            u.with_conn(|c| {
                schema::meta_put(c, schema::ROOT_SEALED, &root)?;
                schema::meta_put(c, schema::SIGNUP, &rec.encode())
            })?;
            Ok((signer, recovery_key_base32(&rk)))
        })?;
        self.signer = Some(signer);
        Ok(rk_text)
    }
    pub fn signup_request(
        &self,
        invite: &str,
        username: &str,
        display: &str,
        password: Option<&str>,
    ) -> Result<Vec<u8>, ClientError> {
        let rec = pending(self.phase()?)?;
        Ok(wire::account_body(
            invite,
            username,
            display,
            &rec.umk_pub,
            &rec.ssk_pub,
            &rec.sig_umk_ssk,
            password,
            &rec.device_id,
            &rec.dsk_pub,
            &credential(&rec, [0; 16]).encode(),
        ))
    }
    pub fn signup_complete(
        &mut self,
        user_id: &[u8; 16],
        username: &str,
        now: u64,
    ) -> Result<Vec<u8>, ClientError> {
        if *user_id == [0; 16] {
            return Err(ClientError::new(E_CORE_INPUT, "user_id is all zero"));
        }
        self.write(|ctx, u| {
            let (identity, signup) = u.with_conn(load_phase)?;
            let rec = pending(decode_phase(identity, signup)?)?;
            let cred = credential(&rec, *user_id);
            cred.verify_signatures(&rec.dsk_pub)?;
            let unsigned = DeviceListUnsigned {
                v: 1,
                user_id: UserId::from_bytes(*user_id),
                version: 1,
                prev_hash: [0; 32],
                entries: vec![DeviceEntry {
                    device_id: DeviceId::from_bytes(rec.device_id),
                    dsk_pub: rec.dsk_pub,
                    tier: Tier::Browser,
                    added_at: now,
                    revoked_at: None,
                }],
            };
            let sig_ssk = SskSigner::from_bytes(&rec.ssk_priv).sign_device_list(&unsigned);
            let list = DeviceList { unsigned, sig_ssk };
            list.verify(&rec.ssk_pub)?;
            let put = wire::device_list_put_body(&list);
            let mut p = Encoder::new();
            p.array(3).uint(1).bytes(&list.encode()).array(0);
            let plaintext = Zeroizing::new(p.into_vec());
            let state = seal(ctx.provider, &rec.k_backup, AAD_STATE, &plaintext)?;
            let identity = IdentityRecord {
                instance_id: rec.instance_id,
                user_id: *user_id,
                device_id: rec.device_id,
                dsk_pub: rec.dsk_pub,
                umk_pub: rec.umk_pub,
                ssk_pub: rec.ssk_pub,
                username: username.to_owned(),
                credential: cred.encode(),
                device_list_body: put.clone(),
                list_published: false,
            };
            u.with_conn(|c| {
                schema::meta_put(c, schema::STATE_SEALED, &state)?;
                schema::meta_put(c, schema::IDENTITY, &identity.encode())?;
                schema::meta_del(c, schema::SIGNUP)
            })?;
            Ok(put)
        })
    }
    pub fn signup_reset(&mut self) -> Result<(), ClientError> {
        self.write(|ctx, u| {
            let ((identity, signup), session) =
                u.with_conn(|c| Ok((load_phase(c)?, schema::meta_get(c, schema::SESSION)?)))?;
            let rec = pending(decode_phase(identity, signup)?)?;
            if session.is_some() {
                return Err(ClientError::new(E_CORE_STATE, "the account is registered"));
            }
            SignatureKeyPair::delete(
                ctx.provider.storage(),
                &rec.dsk_pub,
                CIPHERSUITE.signature_algorithm(),
            )?;
            u.with_conn(|c| {
                schema::meta_del(c, schema::SIGNUP)?;
                schema::meta_del(c, schema::ROOT_SEALED)
            })?;
            Ok(())
        })?;
        self.signer = None;
        Ok(())
    }
    pub fn device_list_body(&self) -> Result<Vec<u8>, ClientError> {
        Ok(ready(self.phase()?)?.device_list_body)
    }
    pub fn device_list_published(&mut self) -> Result<(), ClientError> {
        self.write(|_, u| {
            let (identity, signup) = u.with_conn(load_phase)?;
            let mut rec = ready(decode_phase(identity, signup)?)?;
            rec.list_published = true;
            u.with_conn(|c| schema::meta_put(c, schema::IDENTITY, &rec.encode()))?;
            Ok(())
        })
    }
    pub fn session_sign(&self, nonce: &[u8; 32], purpose: u8) -> Result<Vec<u8>, ClientError> {
        if purpose > 1 {
            return Err(ClientError::new(E_CORE_INPUT, "purpose must be 0 or 1"));
        }
        let (instance, device) = match self.phase()? {
            Phase::None => return Err(ClientError::new(E_CORE_NO_IDENTITY, "")),
            Phase::Pending(r) => (r.instance_id, r.device_id),
            Phase::Ready(r) => (r.instance_id, r.device_id),
        };
        let signer = self
            .signer
            .as_ref()
            .ok_or_else(|| ClientError::new(E_CORE_STATE, "the device key is not loaded"))?;
        let sig = signer
            .sign(&session_preimage(&instance, &device, nonce, purpose))
            .map_err(|e| ClientError::new(E_CORE_MLS, format!("sign: {e:?}")))?;
        Ok(wire::session_body(nonce, purpose, &sig))
    }
    pub fn session_store(
        &mut self,
        token: &str,
        expires: u64,
        idle_expires: u64,
    ) -> Result<(), ClientError> {
        if !(1..=MAX_TOKEN_BYTES).contains(&token.len()) {
            return Err(ClientError::new(
                E_CORE_INPUT,
                "token must be 1..=256 bytes",
            ));
        }
        self.write(|_, u| {
            let (identity, signup) = u.with_conn(load_phase)?;
            if matches!(decode_phase(identity, signup)?, Phase::None) {
                return Err(ClientError::new(E_CORE_NO_IDENTITY, ""));
            }
            let rec = SessionRecord {
                token: token.to_owned(),
                expires,
                idle_expires,
            };
            u.with_conn(|c| schema::meta_put(c, schema::SESSION, &rec.encode()))?;
            Ok(())
        })
    }
    pub fn session(&self) -> Result<Vec<u8>, ClientError> {
        let raw = self.read(|c| schema::meta_get(c, schema::SESSION))?;
        Ok(match raw {
            Some(raw) => SessionRecord::decode(&raw)?.encode(),
            None => wire::session_value(None),
        })
    }
    pub fn session_clear(&mut self) -> Result<(), ClientError> {
        self.write(|_, u| {
            u.with_conn(|c| schema::meta_del(c, schema::SESSION))?;
            Ok(())
        })
    }
    pub fn key_packages(&mut self, count: u32, last_resort: bool) -> Result<Vec<u8>, ClientError> {
        if !(1..=MAX_KEY_PACKAGES).contains(&count) {
            return Err(ClientError::new(E_CORE_INPUT, "count must be 1..=32"));
        }
        self.write(|ctx, u| {
            let (identity, signup) = u.with_conn(load_phase)?;
            let rec = ready(decode_phase(identity, signup)?)?;
            let signer = ctx
                .signer
                .ok_or_else(|| ClientError::new(E_CORE_STATE, "the device key is not loaded"))?;
            let credential = CredentialWithKey {
                credential: BasicCredential::new(rec.credential).into(),
                signature_key: signer.public().into(),
            };
            let mut packages = Vec::new();
            for _ in 0..count {
                let kp = build_key_package(ctx.provider, signer, credential.clone(), false)?;
                packages.push(
                    MlsMessageOut::from(kp.key_package().clone())
                        .tls_serialize_detached()
                        .map_err(|e| ClientError::new(E_CORE_MLS, format!("serialize: {e:?}")))?,
                );
            }
            let last = if last_resort {
                let kp = build_key_package(ctx.provider, signer, credential, true)?;
                Some(
                    MlsMessageOut::from(kp.key_package().clone())
                        .tls_serialize_detached()
                        .map_err(|e| ClientError::new(E_CORE_MLS, format!("serialize: {e:?}")))?,
                )
            } else {
                None
            };
            Ok(wire::key_packages_body(&packages, last.as_deref()))
        })
    }
    pub fn sealed_objects(&self) -> Result<Vec<u8>, ClientError> {
        let (root, state) = self.read(|c| {
            Ok((
                schema::meta_get(c, schema::ROOT_SEALED)?,
                schema::meta_get(c, schema::STATE_SEALED)?,
            ))
        })?;
        Ok(wire::sealed_objects(root.as_deref(), state.as_deref()))
    }
}

#[cfg(test)]
mod debug_tests {
    use super::{IdentityRecord, SessionRecord, SignupRecord};
    use zeroize::Zeroizing;

    #[test]
    fn record_debug_output_contains_field_names_without_secret_values() {
        let signup = SignupRecord {
            instance_id: [0; 16],
            device_id: [0; 16],
            dsk_pub: [0; 32],
            umk_pub: [0; 32],
            ssk_pub: [0; 32],
            sig_umk_ssk: [0; 64],
            sig_ssk_dev: [0; 64],
            ssk_priv: Zeroizing::new([0xa5; 32]),
            k_backup: Zeroizing::new([0xb6; 32]),
        };
        let identity = IdentityRecord {
            instance_id: [0; 16],
            user_id: [0; 16],
            device_id: [0; 16],
            dsk_pub: [0; 32],
            umk_pub: [0; 32],
            ssk_pub: [0; 32],
            username: "private-name-marker".into(),
            credential: vec![0xc7; 32],
            device_list_body: Vec::new(),
            list_published: false,
        };
        let session = SessionRecord {
            token: "private-token-marker".into(),
            expires: 1,
            idle_expires: 1,
        };
        let s = format!("{signup:?}");
        assert!(s.contains("ssk_priv") && s.contains("k_backup"));
        assert!(!s.contains("165") && !s.contains("182") && !s.contains("a5") && !s.contains("b6"));
        let i = format!("{identity:?}");
        assert!(i.contains("username") && i.contains("credential"));
        assert!(!i.contains("private-name-marker") && !i.contains("199"));
        let t = format!("{session:?}");
        assert!(t.contains("token"));
        assert!(!t.contains("private-token-marker"));
    }
}
