//! Server-signed structural admission proof for a managed bot interaction.
//! Verification here does not admit an MLS group: callers must independently
//! check the authenticated GroupInfo, exact two-device roster and device lists.

use crate::identity::{DeviceList, Tier};
use crate::ids::{DeviceId, UserId};
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

/// A leaf identity and DSK extracted from an already authenticated MLS group state.
/// Constructing this value does not authenticate the source; callers must use the OpenMLS
/// authenticated member view and verify its dilla credential before passing it here.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AuthenticatedRosterLeaf {
    pub user: UserId,
    pub device: DeviceId,
    pub dsk_pub: [u8; 32],
    pub tier: Tier,
}

/// Check that the authenticated group has exactly the bot device and admitted participant device,
/// and that each leaf is present in a valid signed device list. Callers must establish the MLS
/// leaf authentication, device-list freshness and trust pins for both SSKs before relying on this.
pub fn verify_exact_authenticated_roster(
    admission: &Admission,
    leaves: &[AuthenticatedRosterLeaf],
    bot_list: &DeviceList,
    bot_ssk_pub: &[u8; 32],
    participant_list: &DeviceList,
    participant_ssk_pub: &[u8; 32],
) -> Result<(), CodecError> {
    if leaves.len() != 2
        || admission.bot_user == admission.participant_user
        || admission.bot_device == admission.participant_device
    {
        return Err(CodecError::Context);
    }
    let bot_user = UserId::from_bytes(admission.bot_user.0);
    let bot_device = DeviceId::from_bytes(admission.bot_device.0);
    let participant_user = UserId::from_bytes(admission.participant_user.0);
    let participant_device = DeviceId::from_bytes(admission.participant_device.0);
    let bot_leaf = leaves
        .iter()
        .find(|leaf| leaf.user == bot_user && leaf.device == bot_device);
    let participant_leaf = leaves
        .iter()
        .find(|leaf| leaf.user == participant_user && leaf.device == participant_device);
    let (Some(bot_leaf), Some(participant_leaf)) = (bot_leaf, participant_leaf) else {
        return Err(CodecError::Context);
    };
    if bot_leaf.user == participant_leaf.user
        || bot_leaf.device == participant_leaf.device
        || bot_list.unsigned.user_id != bot_user
        || participant_list.unsigned.user_id != participant_user
    {
        return Err(CodecError::Context);
    }
    bot_list
        .accept(None, bot_ssk_pub)
        .map_err(|_| CodecError::Context)?;
    participant_list
        .accept(None, participant_ssk_pub)
        .map_err(|_| CodecError::Context)?;
    bot_list
        .check_leaf(&bot_leaf.device, &bot_leaf.dsk_pub, bot_leaf.tier)
        .map_err(|_| CodecError::Context)?;
    participant_list
        .check_leaf(
            &participant_leaf.device,
            &participant_leaf.dsk_pub,
            participant_leaf.tier,
        )
        .map_err(|_| CodecError::Context)?;
    Ok(())
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
    use crate::identity::{DeviceEntry, DeviceList, DeviceListUnsigned, SskSigner, Tier};
    use crate::ids::{DeviceId, UserId};

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

    #[test]
    fn authenticated_roster_requires_exact_two_listed_devices() {
        let key = SigningKey::from_bytes(&[42; 32]);
        let expected = expected();
        let admission = verify_with_pinned_instance_key(
            &signed(&expected, &key, 11, 100),
            &key.verifying_key().to_bytes(),
            &expected,
        )
        .unwrap();
        let bot_ssk = SskSigner::from_bytes(&[21; 32]);
        let participant_ssk = SskSigner::from_bytes(&[22; 32]);
        let bot_dsk = [31; 32];
        let participant_dsk = [32; 32];
        let bot_list = device_list(
            UserId::from_bytes(expected.bot_user.0),
            DeviceId::from_bytes(expected.bot_device.0),
            bot_dsk,
            &bot_ssk,
        );
        let participant_list = device_list(
            UserId::from_bytes(expected.participant_user.0),
            DeviceId::from_bytes(expected.participant_device.0),
            participant_dsk,
            &participant_ssk,
        );
        let leaves = [
            AuthenticatedRosterLeaf {
                user: UserId::from_bytes(expected.bot_user.0),
                device: DeviceId::from_bytes(expected.bot_device.0),
                dsk_pub: bot_dsk,
                tier: Tier::Native,
            },
            AuthenticatedRosterLeaf {
                user: UserId::from_bytes(expected.participant_user.0),
                device: DeviceId::from_bytes(expected.participant_device.0),
                dsk_pub: participant_dsk,
                tier: Tier::Native,
            },
        ];

        verify_exact_authenticated_roster(
            &admission,
            &leaves,
            &bot_list,
            &bot_ssk.public(),
            &participant_list,
            &participant_ssk.public(),
        )
        .unwrap();

        assert_eq!(
            verify_exact_authenticated_roster(
                &admission,
                &leaves[..1],
                &bot_list,
                &bot_ssk.public(),
                &participant_list,
                &participant_ssk.public()
            ),
            Err(CodecError::Context)
        );
        let extra = [leaves[0].clone(), leaves[1].clone(), leaves[0].clone()];
        assert_eq!(
            verify_exact_authenticated_roster(
                &admission,
                &extra,
                &bot_list,
                &bot_ssk.public(),
                &participant_list,
                &participant_ssk.public()
            ),
            Err(CodecError::Context)
        );
        let wrong_dsk = [33; 32];
        let bad_leaves = [
            leaves[0].clone(),
            AuthenticatedRosterLeaf {
                dsk_pub: wrong_dsk,
                ..leaves[1].clone()
            },
        ];
        assert_eq!(
            verify_exact_authenticated_roster(
                &admission,
                &bad_leaves,
                &bot_list,
                &bot_ssk.public(),
                &participant_list,
                &participant_ssk.public()
            ),
            Err(CodecError::Context)
        );
        let mut tampered_list = participant_list.clone();
        tampered_list.sig_ssk[0] ^= 1;
        assert_eq!(
            verify_exact_authenticated_roster(
                &admission,
                &leaves,
                &bot_list,
                &bot_ssk.public(),
                &tampered_list,
                &participant_ssk.public()
            ),
            Err(CodecError::Context)
        );
        let revoked_list = device_list_with_revocation(
            UserId::from_bytes(expected.participant_user.0),
            DeviceId::from_bytes(expected.participant_device.0),
            participant_dsk,
            &participant_ssk,
        );
        assert_eq!(
            verify_exact_authenticated_roster(
                &admission,
                &leaves,
                &bot_list,
                &bot_ssk.public(),
                &revoked_list,
                &participant_ssk.public()
            ),
            Err(CodecError::Context)
        );
    }

    fn device_list(
        user: UserId,
        device: DeviceId,
        dsk_pub: [u8; 32],
        signer: &SskSigner,
    ) -> DeviceList {
        signed_device_list(user, device, dsk_pub, None, signer)
    }

    fn device_list_with_revocation(
        user: UserId,
        device: DeviceId,
        dsk_pub: [u8; 32],
        signer: &SskSigner,
    ) -> DeviceList {
        signed_device_list(user, device, dsk_pub, Some(2), signer)
    }

    fn signed_device_list(
        user: UserId,
        device: DeviceId,
        dsk_pub: [u8; 32],
        revoked_at: Option<u64>,
        signer: &SskSigner,
    ) -> DeviceList {
        let unsigned = DeviceListUnsigned {
            v: 1,
            user_id: user,
            version: 1,
            prev_hash: [0; 32],
            entries: vec![DeviceEntry {
                device_id: device,
                dsk_pub,
                tier: Tier::Native,
                added_at: 1,
                revoked_at,
            }],
        };
        DeviceList {
            sig_ssk: signer.sign_device_list(&unsigned),
            unsigned,
        }
    }
}
