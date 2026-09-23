//! The instance-side franking tag `T` (protocol/04-envelope-and-franking.md "Franking").
//!
//! `C` (the commitment) is computed by the sender and travels in the MLS `authenticated_data`.
//! `T` is computed by the delivery service over `C` and the delivery metadata, under a per-instance
//! key that is rotated yearly with old keys kept. A report is verified only when both match.

use super::DOMAIN_FRANK_TAG;
use crate::identity::{hmac_sha256, hmac_sha256_verify};
use crate::ids::DeviceId;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct FrankingTagInput {
    pub group_id: [u8; 16],
    pub epoch: u64,
    pub seq: u64,
    pub uploader_device: DeviceId,
    pub commitment: [u8; 32],
    pub recv_ts: u64,
}

impl FrankingTagInput {
    /// `DOMAIN_FRANK_TAG || group_id || epoch(8 BE) || seq(8 BE) || uploader_device ||
    /// commitment || recv_ts(8 BE)`
    pub fn preimage(&self) -> Vec<u8> {
        let mut m = Vec::with_capacity(DOMAIN_FRANK_TAG.len() + 16 + 8 + 8 + 16 + 32 + 8);
        m.extend_from_slice(DOMAIN_FRANK_TAG);
        m.extend_from_slice(&self.group_id);
        m.extend_from_slice(&self.epoch.to_be_bytes());
        m.extend_from_slice(&self.seq.to_be_bytes());
        m.extend_from_slice(self.uploader_device.as_bytes());
        m.extend_from_slice(&self.commitment);
        m.extend_from_slice(&self.recv_ts.to_be_bytes());
        m
    }
}

pub fn franking_tag(k_frank: &[u8; 32], input: &FrankingTagInput) -> [u8; 32] {
    hmac_sha256(k_frank, &input.preimage())
}

pub fn verify_franking_tag(k_frank: &[u8; 32], input: &FrankingTagInput, tag: &[u8; 32]) -> bool {
    hmac_sha256_verify(k_frank, &input.preimage(), tag)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::envelope::Envelope;
    use crate::ids::DeviceId;

    const FRANKING_JSON: &str = include_str!("../../../../protocol/vectors/franking.json");

    fn unhex(s: &str) -> Vec<u8> {
        (0..s.len() / 2)
            .map(|i| u8::from_str_radix(&s[2 * i..2 * i + 2], 16).expect("hex digit"))
            .collect()
    }

    fn unhex_n<const N: usize>(s: &str) -> [u8; N] {
        let v = unhex(s);
        assert_eq!(v.len(), N);
        let mut out = [0u8; N];
        out.copy_from_slice(&v);
        out
    }

    fn hex_of(b: &[u8]) -> String {
        b.iter().map(|x| format!("{x:02x}")).collect()
    }

    #[test]
    fn every_franking_vector_reproduces_its_tag() {
        let doc: serde_json::Value = serde_json::from_str(FRANKING_JSON).expect("franking.json");
        let k_frank = unhex_n::<32>(doc["instance_franking_key"].as_str().expect("key"));
        let cases = doc["cases"].as_array().expect("cases");
        assert_eq!(
            cases.len(),
            3,
            "franking.json is expected to carry three cases"
        );
        for case in cases {
            let input = FrankingTagInput {
                group_id: unhex_n::<16>(case["group_id"].as_str().expect("group_id")),
                epoch: case["epoch"].as_u64().expect("epoch"),
                seq: case["seq"].as_u64().expect("seq"),
                uploader_device: DeviceId::from_bytes(unhex_n::<16>(
                    case["uploader_device"].as_str().expect("uploader_device"),
                )),
                commitment: unhex_n::<32>(case["commitment"].as_str().expect("commitment")),
                recv_ts: case["recv_ts"].as_u64().expect("recv_ts"),
            };
            let tag = franking_tag(&k_frank, &input);
            assert_eq!(hex_of(&tag), case["tag"].as_str().expect("tag"));
            assert!(verify_franking_tag(&k_frank, &input, &tag));
            let mut wrong = tag;
            wrong[31] ^= 0x01;
            assert!(!verify_franking_tag(&k_frank, &input, &wrong));
        }
    }

    /// The shared envelope in franking.json must produce the commitment all three cases carry.
    #[test]
    fn the_shared_envelope_reproduces_the_shared_commitment() {
        let doc: serde_json::Value = serde_json::from_str(FRANKING_JSON).expect("franking.json");
        let bytes = unhex(doc["envelope_cbor"].as_str().expect("envelope_cbor"));
        let env = Envelope::decode(&bytes).expect("decode");
        assert_eq!(
            env.encode().unwrap(),
            bytes,
            "re-encoding must be byte-identical"
        );
        assert_eq!(
            hex_of(&env.commitment().unwrap()),
            doc["cases"][0]["commitment"].as_str().expect("commitment")
        );
    }

    #[test]
    fn the_tag_preimage_is_the_documented_concatenation() {
        let input = FrankingTagInput {
            group_id: [0x07; 16],
            epoch: 41,
            seq: 4127,
            uploader_device: DeviceId::from_bytes([0x08; 16]),
            commitment: [0x0c; 32],
            recv_ts: 1_758_659_640,
        };
        let mut want = b"dilla frank tag v1".to_vec();
        want.extend_from_slice(&[0x07; 16]);
        want.extend_from_slice(&41u64.to_be_bytes());
        want.extend_from_slice(&4127u64.to_be_bytes());
        want.extend_from_slice(&[0x08; 16]);
        want.extend_from_slice(&[0x0c; 32]);
        want.extend_from_slice(&1_758_659_640u64.to_be_bytes());
        assert_eq!(input.preimage(), want);
        assert_eq!(want.len(), 18 + 16 + 8 + 8 + 16 + 32 + 8);
    }
}
