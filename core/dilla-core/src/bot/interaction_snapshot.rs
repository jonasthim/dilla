//! Verification of the signed, read-only interaction context transport snapshot.
//!
//! This does not authenticate an MLS roster or enable group creation. That requires the native
//! candidate-group inspection boundary, which is intentionally still unavailable.

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
    pub now: u64,
    pub min_revision: u64,
    pub policy: u64,
    pub e2ee: u64,
    pub media: u64,
    pub instance: MsgId,
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

fn validate_list(x: &SnapshotList) -> Result<(), CodecError> {
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
mod tests {
    use super::*;
    use crate::cbor::Encoder;
    use ed25519_dalek::SigningKey;

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
}
