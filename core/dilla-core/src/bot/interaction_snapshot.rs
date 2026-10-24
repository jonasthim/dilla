//! Verification of the signed, read-only interaction context transport snapshot.
//!
//! This verifies only the signed snapshot, admission proof, and device lists. The native
//! transaction-local create path must still authenticate the actual MLS context and roster.

use crate::{
    cbor::{Decoder, decode_strict},
    identity::DeviceList,
    ids::MsgId,
};
use ed25519_dalek::{Signature, VerifyingKey};
use sha2::{Digest, Sha256};

use super::{
    CodecError,
    interaction_admission::{Expected, verify_with_pinned_instance_key},
};

const DOMAIN: &[u8] = b"dilla bot interaction context snapshot v1\0";
const MAX_SNAPSHOT: usize = 160 * 1024;
const MAX_LIST: usize = 64 * 1024;
const MAX_I64: u64 = i64::MAX as u64;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SnapshotList {
    pub user: MsgId,
    pub umk: [u8; 32],
    pub ssk: [u8; 32],
    pub binding_signature: [u8; 64],
    pub version: u64,
    pub blob: Vec<u8>,
    pub signature: [u8; 64],
    pub prev_hash: [u8; 32],
    pub hash: [u8; 32],
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Snapshot {
    pub request: MsgId,
    pub admission_id: MsgId,
    pub admission_payload: Vec<u8>,
    pub admission_signature: [u8; 64],
    /// Exclusive admission expiry recovered from the instance-signed proof.
    pub not_after: u64,
    pub now: u64,
    pub min_revision: u64,
    pub policy: u64,
    pub e2ee: u64,
    pub media: u64,
    pub instance: MsgId,
    /// Signed descriptive server key ID. The Bot store currently pins only the external-sender
    /// public key, so this ID is authenticated by that key but is not compared with a separate
    /// locally persisted ID pin.
    pub key_id: MsgId,
    pub instance_signer: [u8; 32],
    pub expected: [MsgId; 8],
    pub bot: SnapshotList,
    pub participant: SnapshotList,
}

fn msg(d: &mut Decoder<'_>) -> Result<MsgId, crate::cbor::CborError> {
    Ok(MsgId::from_bytes(d.bytes_exact::<16>()?))
}
fn list(d: &mut Decoder<'_>) -> Result<SnapshotList, crate::cbor::CborError> {
    d.array(9)?;
    let value = SnapshotList {
        user: msg(d)?,
        umk: d.bytes_exact()?,
        ssk: d.bytes_exact()?,
        binding_signature: d.bytes_exact()?,
        version: d.uint()?,
        blob: d.bytes()?.to_vec(),
        signature: d.bytes_exact()?,
        prev_hash: d.bytes_exact()?,
        hash: d.bytes_exact()?,
    };
    Ok(value)
}

/// Decode exact canonical `[payload, signature]`, verify the snapshot with the already-pinned
/// instance external-sender key, and validate the embedded admission tuple and signed lists.
pub fn verify(
    wire: &[u8],
    pinned_key: &[u8; 32],
    expected: &Expected,
) -> Result<Snapshot, CodecError> {
    let (payload, _sig) = verify_outer(wire, pinned_key)?;
    let s = decode_payload(&payload)?;
    if [s.request, s.admission_id, s.instance, s.key_id]
        .iter()
        .any(|x| x.as_bytes().iter().all(|b| *b == 0))
        || s.now > MAX_I64
        || s.now == 0
        || s.min_revision == 0
        || s.min_revision > MAX_I64
        || s.policy == 0
        || s.policy > MAX_I64
        || s.e2ee != 1
        || s.media != 0
        || s.instance_signer != *pinned_key
        || s.instance != expected.instance
        || s.now != expected.server_now
        || s.min_revision != expected.minimum_eligibility_revision
        || s.policy != expected.policy_version
    {
        return Err(CodecError::Context);
    }
    let tuple = [
        expected.instance,
        expected.installation,
        expected.community,
        expected.bot_user,
        expected.bot_device,
        expected.participant_user,
        expected.participant_device,
        expected.group,
    ];
    if s.expected != tuple
        || s.bot.user != expected.bot_user
        || s.participant.user != expected.participant_user
        || expected.bot_user == expected.participant_user
        || expected.bot_device == expected.participant_device
    {
        return Err(CodecError::Context);
    }
    let proof = [
        encode_bytes(&s.admission_payload),
        encode_bytes(&s.admission_signature),
    ]
    .concat();
    let mut env = vec![0x82];
    env.extend_from_slice(&proof);
    let admission = verify_with_pinned_instance_key(&env, pinned_key, expected)?;
    if admission.admission != s.admission_id {
        return Err(CodecError::Context);
    }
    let mut s = s;
    s.not_after = admission.not_after;
    validate_list(&s.bot)?;
    validate_list(&s.participant)?;
    Ok(s)
}

pub fn verify_outer(wire: &[u8], pinned_key: &[u8; 32]) -> Result<(Vec<u8>, [u8; 64]), CodecError> {
    if wire.is_empty() || wire.len() > MAX_SNAPSHOT + 128 {
        return Err(CodecError::Limit);
    }
    let (payload, sig) = decode_strict(wire, |d| {
        d.array(2)?;
        Ok((d.bytes()?.to_vec(), d.bytes_exact::<64>()?))
    })?;
    if payload.is_empty() || payload.len() > MAX_SNAPSHOT {
        return Err(CodecError::Limit);
    }
    let key = VerifyingKey::from_bytes(pinned_key).map_err(|_| CodecError::Value)?;
    let mut preimage = Vec::with_capacity(DOMAIN.len() + payload.len());
    preimage.extend_from_slice(DOMAIN);
    preimage.extend_from_slice(&payload);
    key.verify_strict(&preimage, &Signature::from_bytes(&sig))
        .map_err(|_| CodecError::Context)?;
    Ok((payload, sig))
}

fn decode_payload(payload: &[u8]) -> Result<Snapshot, CodecError> {
    decode_strict(payload, |d| {
        d.array(16)?;
        let version = d.uint()?;
        let request = msg(d)?;
        let admission_id = msg(d)?;
        let admission_payload = d.bytes()?.to_vec();
        let admission_signature = d.bytes_exact()?;
        let now = d.uint()?;
        let min_revision = d.uint()?;
        let policy = d.uint()?;
        let e2ee = d.uint()?;
        let media = d.uint()?;
        let instance = msg(d)?;
        let key_id = msg(d)?;
        let instance_signer = d.bytes_exact()?;
        d.array(8)?;
        let mut expected_tuple = [MsgId::from_bytes([0; 16]); 8];
        for item in &mut expected_tuple {
            *item = msg(d)?;
        }
        let bot = list(d)?;
        let participant = list(d)?;
        if version != 1 {
            return Err(crate::cbor::CborError::TypeMismatch {
                expected: "snapshot v1",
                offset: d.position(),
            });
        }
        Ok(Snapshot {
            request,
            admission_id,
            admission_payload,
            admission_signature,
            not_after: 0,
            now,
            min_revision,
            policy,
            e2ee,
            media,
            instance,
            key_id,
            instance_signer,
            expected: expected_tuple,
            bot,
            participant,
        })
    })
    .map_err(Into::into)
}

fn encode_bytes(b: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    let n = b.len();
    if n < 24 {
        out.push(0x40 + n as u8)
    } else if n <= 255 {
        out.extend_from_slice(&[0x58, n as u8])
    } else {
        out.extend_from_slice(&[0x59, (n >> 8) as u8, n as u8])
    };
    out.extend_from_slice(b);
    out
}

pub(super) fn validate_list(x: &SnapshotList) -> Result<(), CodecError> {
    if x.user.as_bytes().iter().all(|b| *b == 0)
        || x.version == 0
        || x.version > MAX_I64
        || x.blob.is_empty()
        || x.blob.len() > MAX_LIST
    {
        return Err(CodecError::Value);
    }
    if Sha256::digest(&x.blob).as_slice() != x.hash {
        return Err(CodecError::Context);
    }
    let umk = VerifyingKey::from_bytes(&x.umk).map_err(|_| CodecError::Value)?;
    umk.verify_strict(
        &crate::identity::CredentialIdentity::ssk_message(&x.ssk),
        &Signature::from_bytes(&x.binding_signature),
    )
    .map_err(|_| CodecError::Context)?;
    let device_list = DeviceList::decode(&x.blob).map_err(|_| CodecError::Format)?;
    if device_list.unsigned.user_id.as_bytes() != x.user.as_bytes()
        || device_list.unsigned.version != x.version
        || device_list.unsigned.prev_hash != x.prev_hash
        || device_list.sig_ssk != x.signature
    {
        return Err(CodecError::Context);
    }
    device_list
        .accept(None, &x.ssk)
        .map_err(|_| CodecError::Context)?;
    Ok(())
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::cbor::Encoder;
    use crate::identity::{
        DeviceEntry, DeviceList, DeviceListUnsigned, SskSigner, Tier, UmkSigner,
    };
    use crate::ids::{DeviceId, UserId};
    use ed25519_dalek::{Signer, SigningKey};

    fn id(byte: u8) -> MsgId {
        MsgId::from_bytes([byte; 16])
    }
    fn expected() -> Expected {
        Expected {
            instance: id(2),
            installation: id(3),
            community: id(4),
            bot_user: id(5),
            bot_device: id(6),
            participant_user: id(7),
            participant_device: id(8),
            group: id(9),
            minimum_eligibility_revision: 7,
            server_now: 100,
            policy_version: 9,
        }
    }
    fn unhex(s: &str) -> Vec<u8> {
        (0..s.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap())
            .collect()
    }

    pub(crate) fn signed_list(
        user: MsgId,
        device: MsgId,
        umk_seed: u8,
        ssk_seed: u8,
    ) -> SnapshotList {
        let umk = UmkSigner::from_bytes(&[umk_seed; 32]);
        let ssk = SskSigner::from_bytes(&[ssk_seed; 32]);
        let unsigned = DeviceListUnsigned {
            v: 1,
            user_id: UserId::from_bytes(user.0),
            version: 1,
            prev_hash: [0; 32],
            entries: vec![DeviceEntry {
                device_id: DeviceId::from_bytes(device.0),
                dsk_pub: [ssk_seed.wrapping_add(1); 32],
                tier: Tier::Native,
                added_at: 100,
                revoked_at: None,
            }],
        };
        let device_list = DeviceList {
            sig_ssk: ssk.sign_device_list(&unsigned),
            unsigned,
        };
        let blob = device_list.encode();
        SnapshotList {
            user,
            umk: umk.public(),
            ssk: ssk.public(),
            binding_signature: umk.sign_ssk(&ssk.public()),
            version: 1,
            signature: device_list.sig_ssk,
            prev_hash: device_list.unsigned.prev_hash,
            hash: Sha256::digest(&blob).into(),
            blob,
        }
    }

    pub(crate) fn make_snapshot(
        expected: &Expected,
        bot: &SnapshotList,
        participant: &SnapshotList,
        key: &SigningKey,
        expiry: u64,
    ) -> Vec<u8> {
        let mut admission = Encoder::new();
        admission
            .array(12)
            .uint(1)
            .bytes(id(1).as_bytes())
            .bytes(expected.instance.as_bytes())
            .bytes(expected.installation.as_bytes())
            .bytes(expected.community.as_bytes())
            .bytes(expected.bot_user.as_bytes())
            .bytes(expected.bot_device.as_bytes())
            .bytes(expected.participant_user.as_bytes())
            .bytes(expected.participant_device.as_bytes())
            .bytes(expected.group.as_bytes())
            .uint(expected.minimum_eligibility_revision)
            .uint(expiry);
        let admission_payload = admission.into_vec();
        let admission_sig = key
            .sign(
                &[
                    b"dilla bot interaction admission v1\0".as_slice(),
                    &admission_payload,
                ]
                .concat(),
            )
            .to_bytes();
        let mut payload = Encoder::new();
        payload
            .array(16)
            .uint(1)
            .bytes(id(10).as_bytes())
            .bytes(id(1).as_bytes())
            .bytes(&admission_payload)
            .bytes(&admission_sig)
            .uint(expected.server_now)
            .uint(expected.minimum_eligibility_revision)
            .uint(expected.policy_version)
            .uint(1)
            .uint(0)
            .bytes(expected.instance.as_bytes())
            .bytes(id(11).as_bytes())
            .bytes(&key.verifying_key().to_bytes());
        payload
            .array(8)
            .bytes(expected.instance.as_bytes())
            .bytes(expected.installation.as_bytes())
            .bytes(expected.community.as_bytes())
            .bytes(expected.bot_user.as_bytes())
            .bytes(expected.bot_device.as_bytes())
            .bytes(expected.participant_user.as_bytes())
            .bytes(expected.participant_device.as_bytes())
            .bytes(expected.group.as_bytes());
        for list in [bot, participant] {
            payload
                .array(9)
                .bytes(list.user.as_bytes())
                .bytes(&list.umk)
                .bytes(&list.ssk)
                .bytes(&list.binding_signature)
                .uint(list.version)
                .bytes(&list.blob)
                .bytes(&list.signature)
                .bytes(&list.prev_hash)
                .bytes(&list.hash);
        }
        let payload = payload.into_vec();
        let sig = key.sign(&[DOMAIN, payload.as_slice()].concat()).to_bytes();
        let mut wire = Encoder::new();
        wire.array(2).bytes(&payload).bytes(&sig);
        wire.into_vec()
    }

    fn signed_snapshot(expiry: u64) -> (Vec<u8>, SigningKey, Expected) {
        let expected = Expected {
            instance: id(2),
            installation: id(3),
            community: id(4),
            bot_user: id(5),
            bot_device: id(6),
            participant_user: id(7),
            participant_device: id(8),
            group: id(9),
            minimum_eligibility_revision: 11,
            server_now: 100,
            policy_version: 3,
        };
        let key = SigningKey::from_bytes(&[42; 32]);
        let bot = signed_list(id(5), id(6), 51, 61);
        let participant = signed_list(id(7), id(8), 71, 81);
        (
            make_snapshot(&expected, &bot, &participant, &key, expiry),
            key,
            expected,
        )
    }

    #[test]
    fn shared_snapshot_vector_verifies_and_rejects_mutations() {
        let value: serde_json::Value =
            serde_json::from_str(include_str!("../../../../protocol/vectors/bot.json")).unwrap();
        let vector = &value["interaction_context_snapshot"];
        let payload = unhex(vector["payload_hex"].as_str().unwrap());
        let sig = unhex(vector["signature_hex"].as_str().unwrap());
        let seed: [u8; 32] = unhex(vector["seed"].as_str().unwrap()).try_into().unwrap();
        let key = SigningKey::from_bytes(&seed);
        assert_eq!(
            key.verifying_key().to_bytes().to_vec(),
            unhex(vector["public_key"].as_str().unwrap())
        );
        let mut env = Encoder::new();
        env.array(2).bytes(&payload).bytes(&sig);
        let wire = env.into_vec();
        let (signed_payload, _) = verify_outer(&wire, &key.verifying_key().to_bytes()).unwrap();
        let snapshot = decode_payload(&signed_payload).unwrap();
        assert_eq!(snapshot.admission_id, id(1));
        assert_eq!(snapshot.bot.user, id(5));
        let mut unknown_field = signed_payload.clone();
        unknown_field[0] = 0x91; // array(17), an unknown trailing field
        assert_eq!(decode_payload(&unknown_field), Err(CodecError::Format));
        assert!(
            verify(&wire, &key.verifying_key().to_bytes(), &expected()).is_err(),
            "the shared fixture uses placeholder device-list material"
        );
        let mut changed = wire.clone();
        *changed.last_mut().unwrap() ^= 1;
        assert_eq!(
            verify_outer(&changed, &key.verifying_key().to_bytes()),
            Err(CodecError::Context)
        );
        assert!(verify_outer(&wire, &[0; 32]).is_err());
        let mut wrong = expected();
        wrong.policy_version += 1;
        assert!(verify(&wire, &key.verifying_key().to_bytes(), &wrong).is_err());
    }

    #[test]
    fn full_snapshot_accepts_real_signed_lists_and_rejects_expiry_equality() {
        let (wire, key, expected) = signed_snapshot(101);
        let accepted = verify(&wire, &key.verifying_key().to_bytes(), &expected).unwrap();
        assert_eq!(accepted.bot.user, expected.bot_user);
        assert_eq!(accepted.participant.user, expected.participant_user);

        let (expired, expiry_key, expiry_expected) = signed_snapshot(100);
        assert_eq!(
            verify(
                &expired,
                &expiry_key.verifying_key().to_bytes(),
                &expiry_expected
            ),
            Err(CodecError::Expired)
        );
    }
}
