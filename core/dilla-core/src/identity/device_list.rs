//! The SSK-signed device list: a hash-chained, monotonically versioned 6-element array
//! (protocol/03-identity.md "Device list").

use super::{DOMAIN_DEVICES, Tier, sha256};
use crate::cbor::{CborError, Decoder, Encoder, decode_strict};
use crate::error::ProtocolError;
use crate::ids::{DeviceId, UserId};
use ed25519_dalek::{Signature, VerifyingKey};

#[derive(Clone, PartialEq, Eq, Debug)]
pub struct DeviceEntry {
    pub device_id: DeviceId,
    pub dsk_pub: [u8; 32],
    pub tier: Tier,
    pub added_at: u64,
    pub revoked_at: Option<u64>,
}

#[derive(Clone, PartialEq, Eq, Debug)]
pub struct DeviceListUnsigned {
    pub v: u64,
    pub user_id: UserId,
    /// Monotonically increasing from 1.
    pub version: u64,
    /// SHA-256 of the previous list's full 6-element encoding; 32 zero bytes for version 1.
    pub prev_hash: [u8; 32],
    pub entries: Vec<DeviceEntry>,
}

#[derive(Clone, PartialEq, Eq, Debug)]
pub struct DeviceList {
    pub unsigned: DeviceListUnsigned,
    pub sig_ssk: [u8; 64],
}

fn write_entries(e: &mut Encoder, entries: &[DeviceEntry]) {
    e.array(entries.len());
    for entry in entries {
        e.array(5)
            .bytes(entry.device_id.as_bytes())
            .bytes(&entry.dsk_pub)
            .uint(u64::from(entry.tier.as_u8()))
            .uint(entry.added_at)
            .opt_uint(entry.revoked_at);
    }
}

fn read_entries(d: &mut Decoder<'_>) -> Result<Vec<DeviceEntry>, CborError> {
    let n = d.array_len()?;
    // Deliberately not `Vec::with_capacity(n)`. `array_len` bounds `n` by the bytes that remain,
    // but a `DeviceEntry` in memory is far wider than the 54 bytes its shortest encoding costs, so
    // reserving one per claimed element scales an N-byte blob from an untrusted DS into ~80N bytes
    // of heap (`cbor::Decoder::array_len`'s own doc: "a caller must not scale it into a larger
    // allocation"). Geometric growth is bounded by the entries that actually parse.
    let mut entries = Vec::new();
    for _ in 0..n {
        d.array(5)?;
        let device_id = DeviceId::from_bytes(d.bytes_exact::<16>()?);
        let dsk_pub = d.bytes_exact::<32>()?;
        let tier = Tier::from_u64(d.uint()?).map_err(|_| CborError::TypeMismatch {
            expected: "tier",
            offset: 0,
        })?;
        let added_at = d.uint()?;
        let revoked_at = d.opt_uint()?;
        entries.push(DeviceEntry {
            device_id,
            dsk_pub,
            tier,
            added_at,
            revoked_at,
        });
    }
    Ok(entries)
}

impl DeviceListUnsigned {
    /// The 5-element array `[v, user_id, version, prev_hash, entries]`.
    pub fn encode(&self) -> Vec<u8> {
        let mut e = Encoder::with_capacity(96 + 90 * self.entries.len());
        e.array(5)
            .uint(self.v)
            .bytes(self.user_id.as_bytes())
            .uint(self.version)
            .bytes(&self.prev_hash);
        write_entries(&mut e, &self.entries);
        e.into_vec()
    }

    /// `"dilla devices v1" || encode()`
    pub fn signing_message(&self) -> Vec<u8> {
        let body = self.encode();
        let mut m = Vec::with_capacity(DOMAIN_DEVICES.len() + body.len());
        m.extend_from_slice(DOMAIN_DEVICES);
        m.extend_from_slice(&body);
        m
    }
}

impl DeviceList {
    /// The 6-element array: the five unsigned fields plus `sig_ssk`.
    pub fn encode(&self) -> Vec<u8> {
        let u = &self.unsigned;
        let mut e = Encoder::with_capacity(160 + 90 * u.entries.len());
        e.array(6)
            .uint(u.v)
            .bytes(u.user_id.as_bytes())
            .uint(u.version)
            .bytes(&u.prev_hash);
        write_entries(&mut e, &u.entries);
        e.bytes(&self.sig_ssk);
        e.into_vec()
    }

    pub fn decode(bytes: &[u8]) -> Result<Self, ProtocolError> {
        decode_strict(bytes, |d| {
            d.array(6)?;
            let v = d.uint()?;
            let user_id = UserId::from_bytes(d.bytes_exact::<16>()?);
            let version = d.uint()?;
            let prev_hash = d.bytes_exact::<32>()?;
            let entries = read_entries(d)?;
            let sig_ssk = d.bytes_exact::<64>()?;
            Ok(Self {
                unsigned: DeviceListUnsigned {
                    v,
                    user_id,
                    version,
                    prev_hash,
                    entries,
                },
                sig_ssk,
            })
        })
        .map_err(|_| ProtocolError::Credential)
        // protocol/03-identity.md writes `v ; uint, = 1`. Without this a future version decodes
        // as if it were version 1, and every rule below — the version/`prev_hash` chain and the
        // `revoked_at` check that is dilla's only cryptographic revocation — is then applied to a
        // structure this build does not understand. (`E_UNSUPPORTED_VERSION` per the final-fix
        // brief's item 4 ruling.)
        .and_then(|l| {
            if l.unsigned.v == 1 {
                Ok(l)
            } else {
                Err(ProtocolError::UnsupportedVersion)
            }
        })
    }

    /// SHA-256 of the full 6-element encoding. This is what the next version's `prev_hash` carries.
    pub fn hash(&self) -> [u8; 32] {
        sha256(&self.encode())
    }

    pub fn verify(&self, ssk_pub: &[u8; 32]) -> Result<(), ProtocolError> {
        let key = VerifyingKey::from_bytes(ssk_pub).map_err(|_| ProtocolError::Credential)?;
        key.verify_strict(
            &self.unsigned.signing_message(),
            &Signature::from_bytes(&self.sig_ssk),
        )
        .map_err(|_| ProtocolError::Credential)
    }

    /// A verifier keeps the newest validated list per user and accepts a replacement only if the
    /// version is strictly greater, the chain link matches and the signature verifies
    /// (protocol/03-identity.md, "Device list").
    ///
    /// With no previously validated list there is nothing for the version to be "not greater
    /// than", so a first-sight list is trusted on its signature alone — the cross-user TOFU path,
    /// where a client meeting another user fetches whatever version the DS is currently serving.
    /// Only the genesis list can claim to chain from nothing, so `prev_hash` is pinned to 32 zero
    /// bytes exactly when `version == 1`; `version == 0` is not a version at all (the document
    /// numbers lists "monotonically increasing from 1").
    pub fn accept(
        &self,
        prev: Option<&DeviceList>,
        ssk_pub: &[u8; 32],
    ) -> Result<(), ProtocolError> {
        match prev {
            Some(p) => {
                if self.unsigned.version <= p.unsigned.version {
                    return Err(ProtocolError::DeviceListStale);
                }
                if self.unsigned.prev_hash != p.hash() {
                    return Err(ProtocolError::DeviceListStale);
                }
            }
            None => {
                if self.unsigned.version == 0 {
                    return Err(ProtocolError::DeviceListStale);
                }
                if self.unsigned.version == 1 && self.unsigned.prev_hash != [0u8; 32] {
                    return Err(ProtocolError::DeviceListStale);
                }
            }
        }
        self.verify(ssk_pub)
    }

    pub fn lookup(&self, device_id: &DeviceId) -> Option<&DeviceEntry> {
        self.unsigned
            .entries
            .iter()
            .find(|e| &e.device_id == device_id)
    }

    /// Rules 3 and 5 of protocol/03: the leaf's device is listed, is not revoked, carries this
    /// exact `dsk_pub`, and its recorded tier equals the credential's.
    pub fn check_leaf(
        &self,
        device_id: &DeviceId,
        dsk_pub: &[u8; 32],
        tier: Tier,
    ) -> Result<(), ProtocolError> {
        let entry = self
            .lookup(device_id)
            .ok_or(ProtocolError::DeviceUnlisted)?;
        if entry.revoked_at.is_some() || &entry.dsk_pub != dsk_pub {
            return Err(ProtocolError::DeviceUnlisted);
        }
        if entry.tier != tier {
            return Err(ProtocolError::TierMismatch);
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    // `SskSigner` lives in `identity::credential` and is re-exported at `identity`; `super` here is
    // `identity::device_list`, whose own `use super::{sha256, Tier, DOMAIN_DEVICES}` does not bring
    // it in, so `use super::*` does not either.
    use crate::identity::SskSigner;
    use crate::ids::{DeviceId, UserId};

    fn signer() -> SskSigner {
        SskSigner::from_bytes(&[0x32; 32])
    }

    fn entry(id: u8, revoked: Option<u64>) -> DeviceEntry {
        DeviceEntry {
            device_id: DeviceId::from_bytes([id; 16]),
            dsk_pub: [id.wrapping_add(1); 32],
            tier: Tier::Native,
            added_at: 1_758_659_640,
            revoked_at: revoked,
        }
    }

    fn list(version: u64, prev_hash: [u8; 32], entries: Vec<DeviceEntry>) -> DeviceList {
        let unsigned = DeviceListUnsigned {
            v: 1,
            user_id: UserId::from_bytes([0xd4; 16]),
            version,
            prev_hash,
            entries,
        };
        let sig_ssk = signer().sign_device_list(&unsigned);
        DeviceList { unsigned, sig_ssk }
    }

    #[test]
    fn device_list_round_trips_and_signs_over_the_five_element_array() {
        let l = list(
            1,
            [0u8; 32],
            vec![entry(0x01, None), entry(0x02, Some(1_758_700_000))],
        );
        assert_eq!(DeviceList::decode(&l.encode()).unwrap(), l);
        assert_eq!(l.verify(&signer().public()), Ok(()));

        let mut msg = b"dilla devices v1".to_vec();
        msg.extend_from_slice(&l.unsigned.encode());
        assert_eq!(l.unsigned.signing_message(), msg);
    }

    /// protocol/03-identity.md writes `v ; uint, = 1` for the device list as it does for the
    /// credential and the two pairing payloads. Without the guard a `v = 2` list decoded as if it
    /// were version 1, and the revocation rules — which are the only cryptographic revocation
    /// dilla has — were applied to a structure this build does not understand.
    #[test]
    fn device_list_decode_rejects_an_unknown_version() {
        let mut future = list(1, [0u8; 32], vec![entry(0x01, None)]);
        future.unsigned.v = 2;
        assert_eq!(
            DeviceList::decode(&future.encode()),
            Err(ProtocolError::UnsupportedVersion)
        );
        let ok = list(1, [0u8; 32], vec![entry(0x01, None)]);
        assert!(DeviceList::decode(&ok.encode()).is_ok());
    }

    #[test]
    fn verify_rejects_a_bad_signature_and_a_wrong_key() {
        let mut l = list(1, [0u8; 32], vec![entry(0x01, None)]);
        assert_eq!(
            l.verify(&SskSigner::from_bytes(&[0x99; 32]).public()),
            Err(ProtocolError::Credential)
        );
        l.sig_ssk[0] ^= 0x01;
        assert_eq!(l.verify(&signer().public()), Err(ProtocolError::Credential));
    }

    #[test]
    fn accept_requires_a_strictly_greater_version_and_a_matching_prev_hash() {
        let key = signer().public();
        let v1 = list(1, [0u8; 32], vec![entry(0x01, None)]);
        assert_eq!(v1.accept(None, &key), Ok(()));

        let v2 = list(2, v1.hash(), vec![entry(0x01, None), entry(0x02, None)]);
        assert_eq!(v2.accept(Some(&v1), &key), Ok(()));

        // same version again
        let stale = list(1, v1.hash(), vec![entry(0x01, None)]);
        assert_eq!(
            stale.accept(Some(&v1), &key),
            Err(ProtocolError::DeviceListStale)
        );

        // right version, wrong chain link
        let forked = list(2, [0xff; 32], vec![entry(0x01, None)]);
        assert_eq!(
            forked.accept(Some(&v1), &key),
            Err(ProtocolError::DeviceListStale)
        );

        // version 1 must chain from 32 zero bytes
        let bad_root = list(1, [0x01; 32], vec![entry(0x01, None)]);
        assert_eq!(
            bad_root.accept(None, &key),
            Err(ProtocolError::DeviceListStale)
        );
    }

    /// Not `assert_eq!(l.hash(), sha256(&l.encode()))`: that is the definition of `hash()`, so it
    /// holds for any encoding and cannot fail. What must hold is that the digest covers every
    /// field and is what the next version chains from.
    #[test]
    fn hash_covers_every_field_and_is_what_the_next_version_chains_from() {
        let a = list(1, [0u8; 32], vec![entry(0x01, None)]);
        let revoked = list(1, [0u8; 32], vec![entry(0x01, Some(1_758_700_000))]);
        assert_ne!(
            a.hash(),
            revoked.hash(),
            "a revocation must change the hash"
        );
        let two_devices = list(1, [0u8; 32], vec![entry(0x01, None), entry(0x02, None)]);
        assert_ne!(
            a.hash(),
            two_devices.hash(),
            "an added device must change the hash"
        );
        let bumped = list(2, a.hash(), vec![entry(0x01, None)]);
        assert_ne!(a.hash(), bumped.hash(), "the version is inside the hash");
        // protocol/03-identity.md:81-82 digests the *full 6-element* encoding, so `sig_ssk` is
        // covered too. Every other list here is signed by the same key over different content, and
        // Ed25519 is deterministic, so content and signature always move together: only a
        // signature flipped under fixed content can tell `sha256(encode())` from
        // `sha256(unsigned.encode())`.
        let mut resigned = a.clone();
        resigned.sig_ssk[0] ^= 0x01;
        assert_ne!(
            a.hash(),
            resigned.hash(),
            "the signature is inside the hash"
        );
        assert_eq!(bumped.accept(Some(&a), &signer().public()), Ok(()));
        assert_ne!(a.hash(), [0u8; 32]);
    }

    /// protocol/03-identity.md:90-92 gives a verifier nothing to compare `version` against until
    /// it has validated a list of its own, so first sight of a mid-chain list is a signature check,
    /// not a replay of the whole chain from genesis.
    #[test]
    fn first_sight_of_a_mid_chain_list_is_accepted_on_its_signature() {
        let key = signer().public();

        let v5 = list(5, [0x77; 32], vec![entry(0x01, None)]);
        assert_eq!(v5.accept(None, &key), Ok(()));

        // ... and it is still only the signature that buys the trust
        let mut tampered = v5.clone();
        tampered.sig_ssk[0] ^= 0x01;
        assert_eq!(tampered.accept(None, &key), Err(ProtocolError::Credential));

        // a list accepted on first sight is a usable chain head
        let v6 = list(6, v5.hash(), vec![entry(0x01, None), entry(0x02, None)]);
        assert_eq!(v6.accept(Some(&v5), &key), Ok(()));

        // version 0 is not a version
        let zero = list(0, [0u8; 32], vec![entry(0x01, None)]);
        assert_eq!(zero.accept(None, &key), Err(ProtocolError::DeviceListStale));
    }

    /// `array_len` bounds the claimed element count by the bytes that remain, never by the size of
    /// what those bytes decode into: the shortest entry encoding is 54 bytes, so a head claiming
    /// one entry per remaining byte is a ~20x lie that the decoder must not reserve memory on.
    #[test]
    fn decode_rejects_an_entry_array_head_that_overclaims() {
        let e0 = entry(0x01, None);
        let mut e = Encoder::with_capacity(256);
        e.array(6)
            .uint(1)
            .bytes(UserId::from_bytes([0xd4; 16]).as_bytes())
            .uint(1)
            .bytes(&[0u8; 32]);
        e.array(100); // claims 100 entries ...
        for _ in 0..2 {
            // ... and supplies two
            e.array(5)
                .bytes(e0.device_id.as_bytes())
                .bytes(&e0.dsk_pub)
                .uint(u64::from(Tier::Native.as_u8()))
                .uint(e0.added_at)
                .opt_uint(None);
        }
        e.bytes(&[0u8; 64]);
        let bytes = e.into_vec();

        // The entries head sits at offset 54 and costs two bytes, and 100 is well under the bytes
        // that follow it, so `array_len`'s own bound accepts this input: the reservation policy is
        // the only thing between the claim and the heap.
        assert_eq!(
            bytes[54], 0x98,
            "the entries head is where this test thinks it is"
        );
        assert!(bytes.len() - 56 >= 100);
        assert_eq!(DeviceList::decode(&bytes), Err(ProtocolError::Credential));
    }

    #[test]
    fn check_leaf_enforces_presence_revocation_and_tier() {
        let present = entry(0x01, None);
        let revoked = entry(0x02, Some(1_758_700_000));
        let l = list(1, [0u8; 32], vec![present.clone(), revoked.clone()]);

        assert_eq!(
            l.check_leaf(&present.device_id, &present.dsk_pub, Tier::Native),
            Ok(())
        );
        assert_eq!(
            l.check_leaf(&present.device_id, &present.dsk_pub, Tier::Browser),
            Err(ProtocolError::TierMismatch)
        );
        assert_eq!(
            l.check_leaf(&revoked.device_id, &revoked.dsk_pub, Tier::Native),
            Err(ProtocolError::DeviceUnlisted)
        );
        assert_eq!(
            l.check_leaf(&DeviceId::from_bytes([0x77; 16]), &[0u8; 32], Tier::Native),
            Err(ProtocolError::DeviceUnlisted)
        );
        // present, unrevoked, right tier, but a different leaf key
        assert_eq!(
            l.check_leaf(&present.device_id, &[0xaa; 32], Tier::Native),
            Err(ProtocolError::DeviceUnlisted)
        );
        assert!(l.lookup(&present.device_id).is_some());
        assert!(l.lookup(&DeviceId::from_bytes([0x77; 16])).is_none());
    }
}
