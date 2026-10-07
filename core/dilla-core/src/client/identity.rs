//! Browser-rooted identity, signup, session and KeyPackage operations.

use super::error::{
    E_CORE_INPUT, E_CORE_MLS, E_CORE_NO_IDENTITY, E_CORE_NOT_FOUND, E_CORE_STATE, E_CORE_STORAGE,
    E_RECOVERY_KEY,
};
use super::{ClientCore, ClientError, schema, wire};
use crate::ProtocolError;
use crate::cbor::{Encoder, decode_strict};
use crate::identity::{
    CredentialIdentity, DeviceEntry, DeviceList, DeviceListUnsigned, Kind, SignerTier, SskSigner,
    Tier, UmkSigner, k_backup, k_header, recovery_key_base32, recovery_key_from_base32,
    recovery_key_normalise,
};
use crate::ids::{DeviceId, UserId};
use crate::mls::{CIPHERSUITE, DillaProvider, StorageError, UnitScope, build_key_package};
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
    pub(super) device_list: Vec<u8>,
    pub(super) state_uploaded: bool,
}
impl core::fmt::Debug for IdentityRecord {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.write_str("IdentityRecord { instance_id, user_id, device_id, dsk_pub, umk_pub, ssk_pub, username, credential, device_list_body, list_published, device_list, state_uploaded }")
    }
}
impl IdentityRecord {
    fn encode(&self) -> Vec<u8> {
        let mut e = Encoder::new();
        e.array(13)
            .uint(2)
            .bytes(&self.instance_id)
            .bytes(&self.user_id)
            .bytes(&self.device_id)
            .bytes(&self.dsk_pub)
            .bytes(&self.umk_pub)
            .bytes(&self.ssk_pub)
            .text(&self.username)
            .bytes(&self.credential)
            .bytes(&self.device_list_body)
            .uint(u64::from(self.list_published))
            .bytes(&self.device_list)
            .uint(u64::from(self.state_uploaded));
        e.into_vec()
    }
    /// The v2 record (thirteen elements, element 0 = 2); anything else is
    /// `E_CORE_STORAGE` "app_meta identity is malformed".
    pub(super) fn decode(bytes: &[u8]) -> Result<Self, ClientError> {
        Self::decode_version(bytes, 2)
    }

    /// The web-1 record (eleven elements, element 0 = 1), read once by the v1 -> v2 migration:
    /// `device_list` is element 1 (the signed list) of its `device_list_body`
    /// `[version uint, blob bstr, ssk_signature b64, prev_hash b32]`, and `state_uploaded` is 0.
    pub(super) fn decode_v1(bytes: &[u8]) -> Result<Self, ClientError> {
        Self::decode_version(bytes, 1)
    }

    /// Both versions share one decoder: the first ten fields are the same, so the record costs
    /// one `decode_strict` instance in the browser build, not two.
    fn decode_version(bytes: &[u8], version: u64) -> Result<Self, ClientError> {
        decode_strict(bytes, |d| {
            d.array(if version == 2 { 13 } else { 11 })?;
            if d.uint()? != version {
                return Err(shape());
            }
            let flag = |d: &mut crate::cbor::Decoder<'_>| match d.uint()? {
                0 => Ok(false),
                1 => Ok(true),
                _ => Err(shape()),
            };
            let instance_id = d.bytes_exact()?;
            let user_id = d.bytes_exact()?;
            let device_id = d.bytes_exact()?;
            let dsk_pub = d.bytes_exact()?;
            let umk_pub = d.bytes_exact()?;
            let ssk_pub = d.bytes_exact()?;
            let username = d.text()?.to_owned();
            let credential = d.bytes()?.to_vec();
            let device_list_body = d.bytes()?.to_vec();
            let list_published = flag(d)?;
            let (device_list, state_uploaded) = if version == 2 {
                (d.bytes()?.to_vec(), flag(d)?)
            } else {
                // decode_strict's two steps, inline (one generic instance fewer).
                let mut l = crate::cbor::Decoder::new(&device_list_body);
                l.array(4)?;
                l.uint()?;
                let blob = l.bytes()?.to_vec();
                l.bytes_exact::<64>()?;
                l.bytes_exact::<32>()?;
                l.finish()?;
                (blob, false)
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
                device_list,
                state_uploaded,
            })
        })
        .map_err(|_| malformed(schema::IDENTITY))
    }
}

/// The backfill's step (a): the identity record, when present, is read as v1 and written back
/// as v2. Returns the record's `user_id` (the mention flag excludes by user, ruling 29).
/// Any decode failure is `E_CORE_STORAGE` "app_meta identity is malformed", which fails the
/// migration unit: the store stays v1.
pub(super) fn upgrade_identity_record(u: &UnitScope<'_>) -> Result<Option<[u8; 16]>, ClientError> {
    let Some(bytes) = u.with_conn(|c| schema::meta_get(c, schema::IDENTITY))? else {
        return Ok(None);
    };
    let rec = IdentityRecord::decode_v1(&bytes)?;
    u.with_conn(|c| schema::meta_put(c, schema::IDENTITY, &rec.encode()))?;
    Ok(Some(rec.user_id))
}

pub(super) struct EnrolRecord {
    pub(super) instance_id: [u8; 16],
    pub(super) device_id: [u8; 16],
    pub(super) dsk_pub: [u8; 32],
    pub(super) user_id: Option<[u8; 16]>,
}
impl EnrolRecord {
    pub(super) fn encode(&self) -> Vec<u8> {
        let mut e = Encoder::new();
        e.array(5)
            .uint(1)
            .bytes(&self.instance_id)
            .bytes(&self.device_id)
            .bytes(&self.dsk_pub);
        match self.user_id {
            Some(u) => {
                e.bytes(&u);
            }
            None => {
                e.null();
            }
        }
        e.into_vec()
    }
    pub(super) fn decode(bytes: &[u8]) -> Result<Self, ClientError> {
        decode_strict(bytes, |d| {
            d.array(5)?;
            if d.uint()? != 1 {
                return Err(shape());
            }
            Ok(Self {
                instance_id: d.bytes_exact()?,
                device_id: d.bytes_exact()?,
                dsk_pub: d.bytes_exact()?,
                user_id: d.opt_bytes_exact()?,
            })
        })
        .map_err(|_| malformed(schema::ENROL))
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
    Enrolling(EnrolRecord),
}
#[allow(clippy::type_complexity)] // L-CORE-06 fixes this public-to-sibling signature.
pub(super) fn load_phase(
    c: &rusqlite::Connection,
) -> Result<(Option<Vec<u8>>, Option<Zeroizing<Vec<u8>>>, Option<Vec<u8>>), StorageError> {
    Ok((
        schema::meta_get(c, schema::IDENTITY)?,
        schema::meta_get(c, schema::SIGNUP)?.map(Zeroizing::new),
        schema::meta_get(c, schema::ENROL)?,
    ))
}
pub(super) fn decode_phase(
    identity: Option<Vec<u8>>,
    signup: Option<Zeroizing<Vec<u8>>>,
    enrol: Option<Vec<u8>>,
) -> Result<Phase, ClientError> {
    match (identity, signup, enrol) {
        (Some(_), _, Some(_)) | (_, Some(_), Some(_)) => Err(ClientError::new(
            E_CORE_STATE,
            "enrol record beside another phase",
        )),
        (Some(_), Some(_), None) => Err(ClientError::new(
            E_CORE_STATE,
            "identity and signup records both present",
        )),
        (Some(b), None, None) => Ok(Phase::Ready(IdentityRecord::decode(&b)?)),
        (None, Some(b), None) => Ok(Phase::Pending(SignupRecord::decode(&b)?)),
        (None, None, Some(b)) => Ok(Phase::Enrolling(EnrolRecord::decode(&b)?)),
        (None, None, None) => Ok(Phase::None),
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

enum Unsealed {
    Malformed,
    Refused,
}

fn open_sealed(key: &[u8; 32], aad: &[u8], stored: &[u8]) -> Result<Zeroizing<Vec<u8>>, Unsealed> {
    let (nonce, ct) = decode_strict(stored, |d| {
        d.array(3)?;
        if d.uint()? != 1 {
            return Err(shape());
        }
        Ok((d.bytes_exact::<12>()?, d.bytes()?.to_vec()))
    })
    .map_err(|_| Unsealed::Malformed)?;
    let aead = Aes256Gcm::new_from_slice(key).map_err(|_| Unsealed::Refused)?;
    aead.decrypt(Nonce::from_slice(&nonce), Payload { msg: &ct, aad })
        .map(Zeroizing::new)
        .map_err(|_| Unsealed::Refused)
}

/// The recovery key as a person typed it: normalised, then the strict 52-character Crockford parse
/// (whose last character carries four zero bits). Any failure is E_RECOVERY_KEY with no detail.
fn recovery_key_parse(recovery_key: &str) -> Result<Zeroizing<[u8; 32]>, ClientError> {
    let normalised = Zeroizing::new(recovery_key_normalise(recovery_key));
    recovery_key_from_base32(&normalised)
        .map(Zeroizing::new)
        .map_err(|_| ClientError::new(E_RECOVERY_KEY, ""))
}

/// REGISTRATION-DEVICES-02: the sign-in ceremony checks the typed key's form before it registers a
/// device row, so a mistyped key costs no registration. Only the form is checked; whether the key
/// opens the account's root object is known only after the root is fetched.
pub fn recovery_key_check(recovery_key: &str) -> Result<(), ClientError> {
    recovery_key_parse(recovery_key).map(drop)
}

struct Recovered {
    umk_priv: Zeroizing<[u8; 32]>,
    ssk_priv: Zeroizing<[u8; 32]>,
    umk_pub: [u8; 32],
    ssk_pub: [u8; 32],
    k_backup: Zeroizing<[u8; 32]>,
    pins: Vec<u8>,
    state_list_version: Option<u64>,
    /// The base the next list is signed on: the served list, or the state object's own list when it
    /// is an interrupted publication of the served list's successor (BACKUPS-RECOVERY-02).
    list: DeviceList,
    /// Whether `list` came from the state object and the instance does not hold it yet.
    interrupted: bool,
}

fn recover(
    recovery_key: &str,
    root_sealed: &[u8],
    state_sealed: &[u8],
    list_body: &[u8],
    user_id: &[u8; 16],
    expect: Option<(&[u8; 32], &[u8; 32])>,
) -> Result<Recovered, ClientError> {
    let rk = recovery_key_parse(recovery_key)?;
    let k_header = Zeroizing::new(k_header(&rk));
    let plain = open_sealed(&k_header, AAD_ROOT, root_sealed).map_err(|e| match e {
        Unsealed::Malformed => ClientError::new(E_CORE_INPUT, "root_sealed is malformed"),
        Unsealed::Refused => ClientError::new(E_RECOVERY_KEY, ""),
    })?;
    let (umk_priv, ssk_priv) = decode_strict(&plain, |d| {
        d.array(3)?;
        if d.uint()? != 1 {
            return Err(shape());
        }
        Ok((
            Zeroizing::new(d.bytes_exact::<32>()?),
            Zeroizing::new(d.bytes_exact::<32>()?),
        ))
    })
    .map_err(|_| ClientError::new(E_CORE_INPUT, "root object is malformed"))?;
    let umk_pub = UmkSigner::from_bytes(&umk_priv).public();
    let ssk_pub = SskSigner::from_bytes(&ssk_priv).public();
    if let Some((expected_umk, expected_ssk)) = expect
        && (&umk_pub != expected_umk || &ssk_pub != expected_ssk)
    {
        return Err(ProtocolError::Credential.into());
    }
    let k_backup = Zeroizing::new(k_backup(&rk));
    let served = wire::decode_device_list_body(list_body)
        .map_err(|_| ClientError::new(E_CORE_INPUT, "list_body is malformed"))?;
    let list = DeviceList::decode(&served.blob)?;
    // First-sight rules, as own_device_list_update applies them: version 0 is no version, and only
    // version 1 chains from 32 zero bytes.
    list.accept(None, &ssk_pub)?;
    if list.unsigned.user_id != UserId::from_bytes(*user_id) {
        return Err(ProtocolError::Credential.into());
    }
    if served.version != list.unsigned.version
        || served.prev_hash != list.unsigned.prev_hash
        || served.ssk_signature != list.sig_ssk
    {
        return Err(ClientError::new(
            E_CORE_INPUT,
            "list_body elements disagree",
        ));
    }
    // The state object: [1, device_list, pins] under K_backup; its list must decode, as the floor
    // reads its version and an interrupted publication its whole list.
    let state = if state_sealed.is_empty() {
        Err("the backup state is missing")
    } else {
        open_sealed(&k_backup, AAD_STATE, state_sealed)
            .ok()
            .and_then(|plain| {
                decode_strict(&plain, |d| {
                    d.array(3)?;
                    if d.uint()? != 1 {
                        return Err(shape());
                    }
                    let inner = DeviceList::decode(d.bytes()?).map_err(|_| shape())?;
                    let pins = d.skip()?;
                    if pins.first().is_none_or(|b| b >> 5 != 4) {
                        return Err(shape());
                    }
                    Ok((inner, pins.to_vec()))
                })
                .ok()
            })
            .ok_or("the backup state could not be read")
    };
    let (state_list, pins) = match state {
        Ok((inner, pins)) => (Some(inner), pins),
        // Version 1 is exempt: the signup wrote list v1 with pins = [] (protocol/06 "Header"), so
        // a missing state there is an account that never uploaded one, and an unopenable one at v1
        // protects nothing; refusing would let a stolen session that spoiled the object brick
        // every recovery-key action of a single-device account for ever (ruling 28). At any later
        // version some device uploaded a state, so its absence is withholding: accepting it would
        // lift the rollback floor and wipe the UMK pins in the re-sealed object.
        Err(_) if list.unsigned.version == 1 => (None, vec![0x80]),
        Err(detail) => return Err(ClientError::new(E_CORE_INPUT, detail)),
    };
    let state_list_version = state_list.as_ref().map(|l| l.unsigned.version);
    // BACKUPS-RECOVERY-02: a device PUT the state object of list v + 1 and lost the list PUT (a
    // failed sign-out or revocation, then a forgotten browser). The state's list is authentic when it
    // is exactly the served list's successor, chains from it and verifies under the recovered SSK: it
    // is returned for the caller to publish first, and the next list is signed on it. Anything else
    // keeps the served list as the base, and the floor refuses a served list older than the state's.
    let (list, interrupted) = match state_list {
        Some(next)
            if list.unsigned.version.checked_add(1) == Some(next.unsigned.version)
                && next.unsigned.user_id == list.unsigned.user_id
                && next.accept(Some(&list), &ssk_pub).is_ok() =>
        {
            (next, true)
        }
        _ => (list, false),
    };
    Ok(Recovered {
        umk_priv,
        ssk_priv,
        umk_pub,
        ssk_pub,
        k_backup,
        pins,
        state_list_version,
        list,
        interrupted,
    })
}

/// The interrupted publication's PUT body when `r` signed on one, for the caller to send first.
fn interrupted_body(r: &Recovered) -> Option<Vec<u8>> {
    r.interrupted.then(|| wire::device_list_put_body(&r.list))
}

/// The rollback floor of enrol_complete (`stored` = None) and device_list_revoke (the stored newest
/// list): the served list must not be older than the list in the opened state object, nor older
/// than the stored newest, and at the stored version it must be the stored list byte for byte.
/// Signing `old + 1` on an older base could re-list a device revoked in between.
///
/// Residue (core-block security review §1, recorded for the plan head's L-CORE-26 attacker
/// statement): the floor refuses a mismatched pair, never a consistent replay. An instance that
/// kept list k and the state object written at k serves both; both are authentic, so the floor
/// passes and the device signs k + 1 on a fork that may re-list a device revoked in k+1..n.
/// Devices holding a newer list refuse the fork by version; one still at k accepts it. Nothing in
/// the state object (AAD "dilla state v1", plaintext [1, list, pins]) is monotonic, so no check
/// here can catch it; a mitigation (a counter the instance cannot roll back) is design-level.
fn floor(r: &Recovered, stored: Option<&DeviceList>) -> Result<(), ClientError> {
    let served = &r.list.unsigned;
    if let Some(s) = stored
        && served.version == s.unsigned.version
        && r.list.encode() != s.encode()
    {
        return Err(ClientError::new(
            E_CORE_INPUT,
            "the instance served a different device list at the stored version",
        ));
    }
    if stored.is_some_and(|s| served.version < s.unsigned.version)
        || r.state_list_version.is_some_and(|v| served.version < v)
    {
        return Err(ClientError::new(
            E_CORE_INPUT,
            "the instance served an older device list",
        ));
    }
    Ok(())
}

/// The `state_list` meta value: the device list version inside the state object just sealed.
fn state_list(version: u64) -> Vec<u8> {
    let mut e = Encoder::new();
    e.uint(version);
    e.into_vec()
}

fn signed_next(
    ssk_priv: &[u8; 32],
    ssk_pub: &[u8; 32],
    list: &DeviceList,
    entries: Vec<DeviceEntry>,
) -> Result<DeviceList, ClientError> {
    let unsigned = DeviceListUnsigned {
        v: 1,
        user_id: list.unsigned.user_id,
        version: list.unsigned.version + 1,
        prev_hash: list.hash(),
        entries,
    };
    let sig_ssk = SskSigner::from_bytes(ssk_priv).sign_device_list(&unsigned);
    let next = DeviceList { unsigned, sig_ssk };
    next.verify(ssk_pub)?;
    Ok(next)
}

fn reseal_state(
    provider: &DillaProvider,
    k_backup: &[u8; 32],
    next: &DeviceList,
    pins: &[u8],
) -> Result<Vec<u8>, ClientError> {
    let mut e = Encoder::new();
    e.array(3).uint(1).bytes(&next.encode()).raw(pins);
    let plain = Zeroizing::new(e.into_vec());
    seal(provider, k_backup, AAD_STATE, &plain)
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
        Phase::None | Phase::Enrolling(_) => {
            Err(ClientError::new(E_CORE_STATE, "no signup is pending"))
        }
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
        let (identity, signup, enrol) = self.read(load_phase)?;
        decode_phase(identity, signup, enrol)
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
            Phase::Enrolling(r) => wire::identity_info(
                3,
                Some(&r.instance_id),
                r.user_id.as_ref(),
                Some(&r.device_id),
                "",
                false,
            ),
        })
    }
    pub fn signup_begin(&mut self, instance_id: &[u8; 16]) -> Result<String, ClientError> {
        match self.phase()? {
            Phase::None => {}
            Phase::Pending(_) => return Err(ClientError::new(E_CORE_STATE, "a signup is pending")),
            Phase::Ready(_) => return Err(ClientError::new(E_CORE_STATE, "an identity exists")),
            Phase::Enrolling(_) => {
                return Err(ClientError::new(E_CORE_STATE, "an enrolment is pending"));
            }
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
            let (identity, signup, enrol) = u.with_conn(load_phase)?;
            let rec = pending(decode_phase(identity, signup, enrol)?)?;
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
                device_list: list.encode(),
                state_uploaded: false,
            };
            u.with_conn(|c| {
                schema::meta_put(c, schema::STATE_SEALED, &state)?;
                schema::meta_put(c, schema::STATE_LIST, &state_list(1))?;
                schema::meta_put(c, schema::IDENTITY, &identity.encode())?;
                schema::meta_del(c, schema::SIGNUP)
            })?;
            Ok(put)
        })
    }
    pub fn signup_reset(&mut self) -> Result<(), ClientError> {
        self.write(|ctx, u| {
            let ((identity, signup, enrol), session) =
                u.with_conn(|c| Ok((load_phase(c)?, schema::meta_get(c, schema::SESSION)?)))?;
            let rec = pending(decode_phase(identity, signup, enrol)?)?;
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
            let (identity, signup, enrol) = u.with_conn(load_phase)?;
            let mut rec = ready(decode_phase(identity, signup, enrol)?)?;
            rec.device_list = wire::decode_device_list_body(&rec.device_list_body)
                .map_err(|_| malformed(schema::IDENTITY))?
                .blob;
            rec.list_published = true;
            u.with_conn(|c| schema::meta_put(c, schema::IDENTITY, &rec.encode()))?;
            Ok(())
        })
    }
    /// BACKUPS-RECOVERY-02: drops an unpublished candidate (a failed sign-out's self-revocation, a
    /// revocation whose list PUT failed). The candidate becomes the accepted list's own PUT body,
    /// still unpublished: the next publication sends it, and the instance's 409 for a list it already
    /// holds settles it; an interrupted publication the core adopted is then published.
    pub fn device_list_drop(&mut self) -> Result<(), ClientError> {
        self.write(|_, u| {
            let (identity, signup, enrol) = u.with_conn(load_phase)?;
            let mut rec = ready(decode_phase(identity, signup, enrol)?)?;
            let accepted =
                DeviceList::decode(&rec.device_list).map_err(|_| malformed(schema::IDENTITY))?;
            rec.device_list_body = wire::device_list_put_body(&accepted);
            rec.list_published = false;
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
            Phase::Enrolling(r) => (r.instance_id, r.device_id),
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
            let (identity, signup, enrol) = u.with_conn(load_phase)?;
            if matches!(decode_phase(identity, signup, enrol)?, Phase::None) {
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
            let (identity, signup, enrol) = u.with_conn(load_phase)?;
            let rec = ready(decode_phase(identity, signup, enrol)?)?;
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
        let (phase, root, state) = self.read(|c| {
            Ok((
                load_phase(c)?,
                schema::meta_get(c, schema::ROOT_SEALED)?,
                schema::meta_get(c, schema::STATE_SEALED)?,
            ))
        })?;
        let uploaded = match decode_phase(phase.0, phase.1, phase.2)? {
            Phase::Ready(rec) => rec.state_uploaded,
            _ => false,
        };
        Ok(wire::sealed_objects(
            root.as_deref(),
            state.as_deref(),
            uploaded,
        ))
    }

    pub fn enrol_begin(&mut self, instance_id: &[u8; 16]) -> Result<Vec<u8>, ClientError> {
        let (signer, device_id, dsk_pub) = self.write(|ctx, u| {
            let (identity, signup, enrol) = u.with_conn(load_phase)?;
            match decode_phase(identity, signup, enrol)? {
                Phase::None => {}
                Phase::Pending(_) => {
                    return Err(ClientError::new(E_CORE_STATE, "a signup is pending"));
                }
                Phase::Ready(_) => {
                    return Err(ClientError::new(E_CORE_STATE, "an identity exists"));
                }
                Phase::Enrolling(_) => {
                    return Err(ClientError::new(E_CORE_STATE, "an enrolment is pending"));
                }
            }
            let device_id = random::<16>(ctx.provider)?;
            let signer = SignatureKeyPair::new(CIPHERSUITE.signature_algorithm())
                .map_err(|e| ClientError::new(E_CORE_MLS, format!("keygen: {e:?}")))?;
            signer.store(ctx.provider.storage())?;
            let dsk_pub: [u8; 32] = signer
                .public()
                .try_into()
                .map_err(|_| ClientError::new(E_CORE_STATE, "dsk is not 32 bytes"))?;
            let rec = EnrolRecord {
                instance_id: *instance_id,
                device_id: *device_id,
                dsk_pub,
                user_id: None,
            };
            u.with_conn(|c| schema::meta_put(c, schema::ENROL, &rec.encode()))?;
            Ok((signer, *device_id, dsk_pub))
        })?;
        self.signer = Some(signer);
        Ok(wire::bytes_pair(&device_id, &dsk_pub))
    }

    pub fn enrol_session_sign(
        &self,
        nonce: &[u8; 32],
        login: &[u8],
    ) -> Result<Vec<u8>, ClientError> {
        if !(1..=256).contains(&login.len()) {
            return Err(ClientError::new(
                E_CORE_INPUT,
                "login must be 1..=256 bytes",
            ));
        }
        let Phase::Enrolling(rec) = self.phase()? else {
            return Err(ClientError::new(E_CORE_STATE, "no enrolment is pending"));
        };
        let signer = self
            .signer
            .as_ref()
            .ok_or_else(|| ClientError::new(E_CORE_STATE, "the device key is not loaded"))?;
        let sig = signer
            .sign(&session_preimage(
                &rec.instance_id,
                &rec.device_id,
                nonce,
                0,
            ))
            .map_err(|e| ClientError::new(E_CORE_MLS, format!("sign: {e:?}")))?;
        let placeholder = CredentialIdentity {
            v: 1,
            umk_pub: [0; 32],
            user_id: UserId::from_bytes([0; 16]),
            device_id: DeviceId::from_bytes(rec.device_id),
            kind: Kind::User,
            tier: Tier::Browser,
            signer_tier: SignerTier::Browser,
            ssk_pub: [0; 32],
            sig_umk_ssk: [0; 64],
            sig_ssk_dev: [0; 64],
        };
        Ok(wire::enrol_session_body(
            nonce,
            &sig,
            &rec.device_id,
            &rec.dsk_pub,
            &placeholder.encode(),
            login,
        ))
    }

    pub fn enrol_registered(&mut self, user_id: &[u8; 16]) -> Result<(), ClientError> {
        if *user_id == [0; 16] {
            return Err(ClientError::new(E_CORE_INPUT, "user_id is all zero"));
        }
        self.write(|_, u| {
            let (identity, signup, enrol) = u.with_conn(load_phase)?;
            let Phase::Enrolling(mut rec) = decode_phase(identity, signup, enrol)? else {
                return Err(ClientError::new(E_CORE_STATE, "no enrolment is pending"));
            };
            match rec.user_id {
                Some(id) if id == *user_id => Ok(()),
                Some(_) => Err(ClientError::new(E_CORE_STATE, "user already recorded")),
                None => {
                    rec.user_id = Some(*user_id);
                    u.with_conn(|c| schema::meta_put(c, schema::ENROL, &rec.encode()))?;
                    Ok(())
                }
            }
        })
    }

    pub fn enrol_reset(&mut self) -> Result<(), ClientError> {
        self.write(|ctx, u| {
            let (identity, signup, enrol) = u.with_conn(load_phase)?;
            let Phase::Enrolling(rec) = decode_phase(identity, signup, enrol)? else {
                return Err(ClientError::new(E_CORE_STATE, "no enrolment is pending"));
            };
            SignatureKeyPair::delete(
                ctx.provider.storage(),
                &rec.dsk_pub,
                CIPHERSUITE.signature_algorithm(),
            )?;
            u.with_conn(|c| {
                schema::meta_del(c, schema::ENROL)?;
                schema::meta_del(c, schema::SESSION)
            })?;
            Ok(())
        })?;
        self.signer = None;
        Ok(())
    }

    pub fn enrol_complete(
        &mut self,
        recovery_key: &str,
        root_sealed: &[u8],
        state_sealed: &[u8],
        list_body: &[u8],
        username: &str,
        now: u64,
    ) -> Result<Vec<u8>, ClientError> {
        self.write(|ctx, u| {
            let (identity, signup, enrol) = u.with_conn(load_phase)?;
            let Phase::Enrolling(rec) = decode_phase(identity, signup, enrol)? else {
                return Err(ClientError::new(E_CORE_STATE, "no enrolment is pending"));
            };
            let user_id = rec
                .user_id
                .ok_or_else(|| ClientError::new(E_CORE_STATE, "no user recorded"))?;
            let recovered = recover(
                recovery_key,
                root_sealed,
                state_sealed,
                list_body,
                &user_id,
                None,
            )?;
            floor(&recovered, None)?;
            // Any entry with this id, live, revoked or under another key: a second entry would
            // never be found, as lookup returns the first.
            if recovered
                .list
                .lookup(&DeviceId::from_bytes(rec.device_id))
                .is_some()
            {
                return Err(ClientError::new(E_CORE_STATE, "device is listed"));
            }
            let umk = UmkSigner::from_bytes(&recovered.umk_priv);
            let ssk = SskSigner::from_bytes(&recovered.ssk_priv);
            let cred = CredentialIdentity {
                v: 1,
                umk_pub: recovered.umk_pub,
                user_id: UserId::from_bytes(user_id),
                device_id: DeviceId::from_bytes(rec.device_id),
                kind: Kind::User,
                tier: Tier::Browser,
                signer_tier: SignerTier::Browser,
                ssk_pub: recovered.ssk_pub,
                sig_umk_ssk: umk.sign_ssk(&recovered.ssk_pub),
                sig_ssk_dev: ssk.sign_device(
                    &DeviceId::from_bytes(rec.device_id),
                    &rec.dsk_pub,
                    Kind::User,
                    Tier::Browser,
                    SignerTier::Browser,
                ),
            };
            cred.verify_signatures(&rec.dsk_pub)
                .map_err(|_| ClientError::new(E_CORE_STATE, "credential does not verify"))?;
            let mut entries = recovered.list.unsigned.entries.clone();
            entries.push(DeviceEntry {
                device_id: DeviceId::from_bytes(rec.device_id),
                dsk_pub: rec.dsk_pub,
                tier: Tier::Browser,
                added_at: now,
                revoked_at: None,
            });
            let next = signed_next(
                &recovered.ssk_priv,
                &recovered.ssk_pub,
                &recovered.list,
                entries,
            )?;
            let state = reseal_state(ctx.provider, &recovered.k_backup, &next, &recovered.pins)?;
            let put = wire::device_list_put_body(&next);
            let first = interrupted_body(&recovered);
            let identity = IdentityRecord {
                instance_id: rec.instance_id,
                user_id,
                device_id: rec.device_id,
                dsk_pub: rec.dsk_pub,
                umk_pub: recovered.umk_pub,
                ssk_pub: recovered.ssk_pub,
                username: username.to_owned(),
                credential: cred.encode(),
                device_list_body: put.clone(),
                list_published: false,
                device_list: recovered.list.encode(),
                state_uploaded: false,
            };
            u.with_conn(|c| {
                schema::meta_put(c, schema::STATE_SEALED, &state)?;
                schema::meta_put(c, schema::STATE_LIST, &state_list(next.unsigned.version))?;
                schema::meta_put(c, schema::ROOT_SEALED, root_sealed)?;
                schema::meta_put(c, schema::IDENTITY, &identity.encode())?;
                schema::meta_del(c, schema::ENROL)
            })?;
            Ok(wire::signed_lists(&put, &state, first.as_deref()))
        })
    }

    pub fn device_list_revoke(
        &mut self,
        recovery_key: &str,
        root_sealed: &[u8],
        state_sealed: &[u8],
        list_body: &[u8],
        device_ids: &[u8],
        now: u64,
    ) -> Result<Vec<u8>, ClientError> {
        if device_ids.is_empty()
            || device_ids.len() > 64 * 16
            || !device_ids.len().is_multiple_of(16)
        {
            return Err(ClientError::new(
                E_CORE_INPUT,
                "device_ids must be 1..=64 ids of 16 bytes",
            ));
        }
        // At most 64 ids: a quadratic scan of the slice instead of a set keeps the browser core
        // smaller (web-2a task 4's size budget).
        let ids = device_ids.as_chunks::<16>().0;
        for (i, id) in ids.iter().enumerate() {
            if ids[..i].contains(id) {
                return Err(ClientError::new(E_CORE_INPUT, "device_ids repeats an id"));
            }
        }
        self.write(|ctx, u| {
            let (identity, signup, enrol) = u.with_conn(load_phase)?;
            let mut rec = ready(decode_phase(identity, signup, enrol)?)?;
            let recovered = recover(
                recovery_key,
                root_sealed,
                state_sealed,
                list_body,
                &rec.user_id,
                Some((&rec.umk_pub, &rec.ssk_pub)),
            )?;
            let stored =
                DeviceList::decode(&rec.device_list).map_err(|_| malformed(schema::IDENTITY))?;
            floor(&recovered, Some(&stored))?;
            for id in ids {
                if !recovered
                    .list
                    .lookup(&DeviceId::from_bytes(*id))
                    .is_some_and(|e| e.revoked_at.is_none())
                {
                    return Err(ClientError::new(
                        E_CORE_NOT_FOUND,
                        "device is not an unrevoked entry of the list",
                    ));
                }
            }
            let mut entries = recovered.list.unsigned.entries.clone();
            for entry in &mut entries {
                if ids.contains(entry.device_id.as_bytes()) {
                    entry.revoked_at = Some(now);
                }
            }
            let next = signed_next(
                &recovered.ssk_priv,
                &recovered.ssk_pub,
                &recovered.list,
                entries,
            )?;
            let state = reseal_state(ctx.provider, &recovered.k_backup, &next, &recovered.pins)?;
            let put = wire::device_list_put_body(&next);
            let first = interrupted_body(&recovered);
            rec.device_list_body = put.clone();
            rec.list_published = false;
            rec.device_list = recovered.list.encode();
            rec.state_uploaded = false;
            u.with_conn(|c| {
                schema::meta_put(c, schema::STATE_SEALED, &state)?;
                schema::meta_put(c, schema::STATE_LIST, &state_list(next.unsigned.version))?;
                schema::meta_put(c, schema::IDENTITY, &rec.encode())
            })?;
            Ok(wire::signed_lists(&put, &state, first.as_deref()))
        })
    }

    pub fn own_device_list_update(&mut self, history_body: &[u8]) -> Result<Vec<u8>, ClientError> {
        let rows = wire::decode_history_body(history_body)
            .map_err(|_| ClientError::new(E_CORE_INPUT, "history_body is malformed"))?;
        self.write(|_, u| {
            let (identity, signup, enrol) = u.with_conn(load_phase)?;
            let mut rec = ready(decode_phase(identity, signup, enrol)?)?;
            let mut newest =
                DeviceList::decode(&rec.device_list).map_err(|_| malformed(schema::IDENTITY))?;
            let mut adopted = false;
            for row in &rows {
                let list = DeviceList::decode(&row.blob)?;
                if row.version == newest.unsigned.version && row.blob == newest.encode() {
                    continue;
                }
                list.accept(Some(&newest), &rec.ssk_pub)?;
                if row.version != list.unsigned.version
                    || row.prev_hash != list.unsigned.prev_hash
                    || row.ssk_signature != list.sig_ssk
                {
                    return Err(ClientError::new(
                        E_CORE_INPUT,
                        "history row elements disagree",
                    ));
                }
                if list.unsigned.user_id != UserId::from_bytes(rec.user_id) {
                    return Err(ProtocolError::Credential.into());
                }
                newest = list;
                adopted = true;
            }
            if adopted {
                if !rec.list_published {
                    let candidate = wire::decode_device_list_body(&rec.device_list_body)
                        .map_err(|_| malformed(schema::IDENTITY))?;
                    if candidate.version <= newest.unsigned.version {
                        rec.device_list_body = wire::device_list_put_body(&newest);
                        rec.list_published = true;
                    }
                }
                rec.device_list = newest.encode();
                u.with_conn(|c| schema::meta_put(c, schema::IDENTITY, &rec.encode()))?;
            }
            let listed = newest
                .lookup(&DeviceId::from_bytes(rec.device_id))
                .is_some_and(|e| e.revoked_at.is_none() && e.dsk_pub == rec.dsk_pub);
            Ok(wire::list_status(newest.unsigned.version, listed))
        })
    }

    pub fn own_device_list(&self) -> Result<Vec<u8>, ClientError> {
        let rec = ready(self.phase()?)?;
        let list = DeviceList::decode(&rec.device_list).map_err(|_| malformed(schema::IDENTITY))?;
        Ok(wire::own_device_list(
            list.unsigned.version,
            rec.list_published,
            &list.unsigned.entries,
        ))
    }

    /// BACKUPS-RECOVERY-03: whether this device's own sealed state object carries the list it
    /// accepted as the newest. A browser holds no K_backup and cannot open the instance's copy; when
    /// this is true, a stored object with other bytes is behind that list or junk, and the browser
    /// re-uploads its own. A store without the record (written before it existed) answers false.
    pub fn state_sealed_current(&self) -> Result<bool, ClientError> {
        let (phase, version) =
            self.read(|c| Ok((load_phase(c)?, schema::meta_get(c, schema::STATE_LIST)?)))?;
        let rec = ready(decode_phase(phase.0, phase.1, phase.2)?)?;
        let Some(raw) = version else {
            return Ok(false);
        };
        let sealed =
            decode_strict(&raw, |d| d.uint()).map_err(|_| malformed(schema::STATE_LIST))?;
        let accepted =
            DeviceList::decode(&rec.device_list).map_err(|_| malformed(schema::IDENTITY))?;
        Ok(sealed == accepted.unsigned.version)
    }

    pub fn state_sealed_uploaded(&mut self) -> Result<(), ClientError> {
        self.write(|_, u| {
            let (identity, signup, enrol) = u.with_conn(load_phase)?;
            let mut rec = ready(decode_phase(identity, signup, enrol)?)?;
            rec.state_uploaded = true;
            u.with_conn(|c| schema::meta_put(c, schema::IDENTITY, &rec.encode()))?;
            Ok(())
        })
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
            device_list: vec![0xd8; 16],
            state_uploaded: false,
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
        assert!(i.contains("device_list") && i.contains("state_uploaded"));
        assert!(!i.contains("216"));
        assert!(!i.contains("private-name-marker") && !i.contains("199"));
        let t = format!("{session:?}");
        assert!(t.contains("token"));
        assert!(!t.contains("private-token-marker"));
    }
}

#[cfg(test)]
mod enrol_record_tests {
    use super::EnrolRecord;

    #[test]
    fn the_enrol_record_round_trips_with_and_without_a_user() {
        for user_id in [None, Some([0x42; 16])] {
            let rec = EnrolRecord {
                instance_id: [0x11; 16],
                device_id: [0x5d; 16],
                dsk_pub: [0x09; 32],
                user_id,
            };
            let bytes = rec.encode();
            let mut want = vec![0x85, 0x01, 0x50];
            want.extend_from_slice(&[0x11; 16]);
            want.push(0x50);
            want.extend_from_slice(&[0x5d; 16]);
            want.extend_from_slice(&[0x58, 0x20]);
            want.extend_from_slice(&[0x09; 32]);
            match user_id {
                Some(u) => {
                    want.push(0x50);
                    want.extend_from_slice(&u);
                }
                None => want.push(0xf6),
            }
            assert_eq!(
                bytes, want,
                "[1, instance_id, device_id, dsk_pub, user_id|null]"
            );
            let back = EnrolRecord::decode(&bytes).expect("decode");
            assert_eq!(
                (back.instance_id, back.device_id, back.dsk_pub, back.user_id),
                (rec.instance_id, rec.device_id, rec.dsk_pub, rec.user_id)
            );
        }
        assert!(
            EnrolRecord::decode(&[0x85, 0x02]).is_err(),
            "element 0 must be 1"
        );
    }
}
