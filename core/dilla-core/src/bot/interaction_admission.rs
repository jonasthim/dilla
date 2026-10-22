//! Server-signed structural admission proof for a managed bot interaction.
//! Verification here does not admit an MLS group: callers must independently
//! check the authenticated GroupInfo, exact two-device roster and device lists.

use ed25519_dalek::{Signature, VerifyingKey};

use super::CodecError;
use crate::cbor::decode_strict;
use crate::ids::MsgId;

const DOMAIN: &[u8] = b"dilla bot interaction admission v1\0";
const MAX_PROOF: usize = 320;
const MAX_I64: u64 = i64::MAX as u64;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Admission {
    pub admission: MsgId,
    pub instance: MsgId,
    pub installation: MsgId,
    pub community: MsgId,
    pub bot_user: MsgId,
    pub bot_device: MsgId,
    pub participant_user: MsgId,
    pub participant_device: MsgId,
    pub group: MsgId,
    pub eligibility_revision: u64,
    pub not_after: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Expected {
    pub instance: MsgId,
    pub installation: MsgId,
    pub community: MsgId,
    pub bot_user: MsgId,
    pub bot_device: MsgId,
    pub participant_user: MsgId,
    pub participant_device: MsgId,
    pub group: MsgId,
    pub minimum_eligibility_revision: u64,
    pub server_now: u64,
}

fn id(d: &mut crate::cbor::Decoder<'_>) -> Result<MsgId, crate::cbor::CborError> {
    Ok(MsgId::from_bytes(d.bytes_exact::<16>()?))
}

fn nonzero(value: MsgId) -> bool {
    value.as_bytes().iter().any(|byte| *byte != 0)
}

/// Decode and verify a proof using a public key pinned from authenticated
/// instance metadata. Passing a caller-declared key is not an admission check.
pub fn verify_with_pinned_instance_key(
    proof: &[u8],
    pinned_instance_key: &[u8; 32],
    expected: &Expected,
) -> Result<Admission, CodecError> {
    if proof.len() > MAX_PROOF || proof.is_empty() {
        return Err(CodecError::Limit);
    }
    let (payload, signature) = decode_strict(proof, |d| {
        d.array(2)?;
        Ok((d.bytes()?.to_vec(), d.bytes_exact::<64>()?))
    })?;
    if payload.is_empty() || payload.len() > MAX_PROOF - 70 {
        return Err(CodecError::Limit);
    }
    let admission = decode_strict(&payload, |d| {
        d.array(12)?;
        if d.uint()? != 1 {
            return Err(crate::cbor::CborError::TypeMismatch {
                expected: "admission v1",
                offset: d.position(),
            });
        }
        Ok(Admission {
            admission: id(d)?,
            instance: id(d)?,
            installation: id(d)?,
            community: id(d)?,
            bot_user: id(d)?,
            bot_device: id(d)?,
            participant_user: id(d)?,
            participant_device: id(d)?,
            group: id(d)?,
            eligibility_revision: d.uint()?,
            not_after: d.uint()?,
        })
    })?;
    if [
        admission.admission,
        admission.instance,
        admission.installation,
        admission.community,
        admission.bot_user,
        admission.bot_device,
        admission.participant_user,
        admission.participant_device,
        admission.group,
    ]
    .into_iter()
    .any(|v| !nonzero(v))
        || admission.eligibility_revision == 0
        || admission.eligibility_revision > MAX_I64
        || admission.not_after == 0
        || admission.not_after > MAX_I64
        || expected.server_now > MAX_I64
        || expected.minimum_eligibility_revision > MAX_I64
    {
        return Err(CodecError::Value);
    }
    if admission.instance != expected.instance
        || admission.installation != expected.installation
        || admission.community != expected.community
        || admission.bot_user != expected.bot_user
        || admission.bot_device != expected.bot_device
        || admission.participant_user != expected.participant_user
        || admission.participant_device != expected.participant_device
        || admission.group != expected.group
    {
        return Err(CodecError::Context);
    }
    if admission.not_after < expected.server_now
        || admission.eligibility_revision < expected.minimum_eligibility_revision
    {
        return Err(CodecError::Expired);
    }
    let key = VerifyingKey::from_bytes(pinned_instance_key).map_err(|_| CodecError::Value)?;
    let preimage = [DOMAIN, payload.as_slice()].concat();
    key.verify_strict(&preimage, &Signature::from_bytes(&signature))
        .map_err(|_| CodecError::Context)?;
    Ok(admission)
}

#[cfg(test)]
mod tests {
    use ed25519_dalek::{Signer, SigningKey};

    use super::*;
    use crate::cbor::Encoder;

    fn mid(byte: u8) -> MsgId {
        MsgId::from_bytes([byte; 16])
    }

    fn expected() -> Expected {
        Expected {
            instance: mid(2),
            installation: mid(3),
            community: mid(4),
            bot_user: mid(5),
            bot_device: mid(6),
            participant_user: mid(7),
            participant_device: mid(8),
            group: mid(9),
            minimum_eligibility_revision: 11,
            server_now: 100,
        }
    }

    fn signed(expected: &Expected, key: &SigningKey, revision: u64, expiry: u64) -> Vec<u8> {
        let mut payload = Encoder::new();
        payload
            .array(12)
            .uint(1)
            .bytes(mid(1).as_bytes())
            .bytes(expected.instance.as_bytes())
            .bytes(expected.installation.as_bytes())
            .bytes(expected.community.as_bytes())
            .bytes(expected.bot_user.as_bytes())
            .bytes(expected.bot_device.as_bytes())
            .bytes(expected.participant_user.as_bytes())
            .bytes(expected.participant_device.as_bytes())
            .bytes(expected.group.as_bytes())
            .uint(revision)
            .uint(expiry);
        let payload = payload.into_vec();
        let sig = key.sign(&[DOMAIN, payload.as_slice()].concat());
        let mut proof = Encoder::new();
        proof.array(2).bytes(&payload).bytes(&sig.to_bytes());
        proof.into_vec()
    }

    #[test]
    fn exact_signed_tuple_and_fresh_revision_are_required() {
        let key = SigningKey::from_bytes(&[42; 32]);
        let expected = expected();
        let proof = signed(&expected, &key, 11, 100);
        let public = key.verifying_key().to_bytes();
        let got = verify_with_pinned_instance_key(&proof, &public, &expected).unwrap();
        assert_eq!(got.group, expected.group);
        assert_eq!(got.eligibility_revision, 11);

        let mut wrong = expected.clone();
        wrong.participant_device = mid(10);
        assert_eq!(
            verify_with_pinned_instance_key(&proof, &public, &wrong),
            Err(CodecError::Context)
        );
        wrong = expected.clone();
        wrong.minimum_eligibility_revision = 12;
        assert_eq!(
            verify_with_pinned_instance_key(&proof, &public, &wrong),
            Err(CodecError::Expired)
        );
        wrong = expected.clone();
        wrong.server_now = 101;
        assert_eq!(
            verify_with_pinned_instance_key(&proof, &public, &wrong),
            Err(CodecError::Expired)
        );
        let other_public = SigningKey::from_bytes(&[43; 32]).verifying_key().to_bytes();
        assert_eq!(
            verify_with_pinned_instance_key(&proof, &other_public, &expected),
            Err(CodecError::Context)
        );
        let mut tampered = proof.clone();
        *tampered.last_mut().unwrap() ^= 1;
        assert_eq!(
            verify_with_pinned_instance_key(&tampered, &public, &expected),
            Err(CodecError::Context)
        );
    }

    #[test]
    fn malformed_and_zero_ids_are_refused() {
        let key = SigningKey::from_bytes(&[42; 32]);
        let expected = expected();
        let public = key.verifying_key().to_bytes();
        assert!(verify_with_pinned_instance_key(&[], &public, &expected).is_err());
        let mut zero = expected.clone();
        zero.group = MsgId::from_bytes([0; 16]);
        let proof = signed(&zero, &key, 11, 100);
        assert_eq!(
            verify_with_pinned_instance_key(&proof, &public, &zero),
            Err(CodecError::Value)
        );
        let proof = signed(&expected, &key, 0, 100);
        assert_eq!(
            verify_with_pinned_instance_key(&proof, &public, &expected),
            Err(CodecError::Value)
        );
    }
}
