//! `dilla-sframe/1`: the RFC 9605 key schedule, KID and CTR packing and header codec for suite
//! 0x0004 (AES_128_GCM_SHA256_128), as pinned by protocol/05-media-frames.md.
//!
//! Week 1 covers exactly what protocol/vectors/sframe.json pins. The codec-prefix parsers for
//! Opus, VP8, VP9 and H.264 and the RBSP escaping arrive when the format is exercised end to end;
//! `dilla-sframe/1` freezes at the end of W5, never on paper.

mod ctr;
mod header;

pub use ctr::{Ctr, MAX_SEQ, Slot, nonce};
pub use header::{decode_header, encode_header};

use crate::identity::hkdf_sha256;

/// AES_128_GCM_SHA256_128.
pub const SFRAME_SUITE: u16 = 0x0004;
/// Key length in bytes.
pub const NK: usize = 16;
/// Nonce and salt length in bytes.
pub const NN: usize = 12;
/// A receiver MUST reject a KID that would resolve against an epoch more than this many commits
/// ago (protocol/05 "Rotation").
pub const KID_EPOCH_WINDOW: u64 = 255;
/// The MLS exporter label the call group's base key is derived under.
pub const LABEL_BASE_KEY: &str = "SFrame 1.0 Base Key";
/// Note the trailing space: it is part of the label.
pub const LABEL_KEY: &[u8] = b"SFrame 1.0 Secret key ";
/// Note the trailing space: it is part of the label.
pub const LABEL_SALT: &[u8] = b"SFrame 1.0 Secret salt ";

/// `(leaf_index << 8) | (epoch mod 256)`. `leaf_index` is capped at 2^16, so a KID uses 24 bits.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct Kid(u64);

impl Kid {
    pub fn new(leaf_index: u16, epoch: u64) -> Self {
        Self((u64::from(leaf_index) << 8) | (epoch % 256))
    }

    pub const fn from_raw(v: u64) -> Self {
        Self(v)
    }

    pub const fn value(self) -> u64 {
        self.0
    }

    pub const fn leaf_index(self) -> u16 {
        ((self.0 >> 8) & 0xffff) as u16
    }

    pub const fn epoch_low(self) -> u8 {
        (self.0 & 0xff) as u8
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct SframeKeys {
    pub key: [u8; NK],
    pub salt: [u8; NN],
}

/// `HKDF-Extract(salt = "", IKM = base_key)` (RFC 9605 section 4.4.2).
pub fn sframe_secret(base_key: &[u8; NK]) -> [u8; 32] {
    crate::identity::hmac_sha256(&[0u8; 32], base_key)
}

/// ```text
/// key  = HKDF-Expand(secret, "SFrame 1.0 Secret key "  || KID(8, BE) || 0x0004, 16)
/// salt = HKDF-Expand(secret, "SFrame 1.0 Secret salt " || KID(8, BE) || 0x0004, 12)
/// ```
///
/// The reference implementation performs Extract and Expand as one HKDF call with an empty salt,
/// which is what `hkdf_sha256(Some(&[]), base_key, info, out)` does here.
pub fn derive_keys(base_key: &[u8; NK], kid: Kid) -> SframeKeys {
    let mut info_key = Vec::with_capacity(LABEL_KEY.len() + 10);
    info_key.extend_from_slice(LABEL_KEY);
    info_key.extend_from_slice(&kid.value().to_be_bytes());
    info_key.extend_from_slice(&SFRAME_SUITE.to_be_bytes());

    let mut info_salt = Vec::with_capacity(LABEL_SALT.len() + 10);
    info_salt.extend_from_slice(LABEL_SALT);
    info_salt.extend_from_slice(&kid.value().to_be_bytes());
    info_salt.extend_from_slice(&SFRAME_SUITE.to_be_bytes());

    let mut key = [0u8; NK];
    let mut salt = [0u8; NN];
    hkdf_sha256(Some(&[]), base_key, &info_key, &mut key).expect("16 bytes is within the limit");
    hkdf_sha256(Some(&[]), base_key, &info_salt, &mut salt).expect("12 bytes is within the limit");
    SframeKeys { key, salt }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SFRAME_JSON: &str = include_str!("../../../../protocol/vectors/sframe.json");

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

    /// `kid` and `ctr` are decimal strings in the JSON even when small enough for a JSON number
    /// (protocol/vectors/README.md). Accept both spellings so a future regeneration cannot break
    /// the runner silently.
    fn as_u64(v: &serde_json::Value) -> u64 {
        match v {
            serde_json::Value::String(s) => s.parse().expect("decimal string"),
            other => other.as_u64().expect("number"),
        }
    }

    #[test]
    fn every_sframe_vector_reproduces_kid_key_salt_ctr_nonce_and_header() {
        let doc: serde_json::Value = serde_json::from_str(SFRAME_JSON).expect("sframe.json");
        assert_eq!(doc["suite"].as_u64(), Some(u64::from(SFRAME_SUITE)));
        let base_key = unhex_n::<NK>(doc["base_key"].as_str().expect("base_key"));
        let cases = doc["cases"].as_array().expect("cases");
        assert_eq!(
            cases.len(),
            4,
            "sframe.json is expected to carry four cases"
        );
        for case in cases {
            let leaf = u16::try_from(case["leaf_index"].as_u64().expect("leaf_index")).unwrap();
            let epoch = case["epoch"].as_u64().expect("epoch");
            let kid = Kid::new(leaf, epoch);
            assert_eq!(
                kid.value(),
                as_u64(&case["kid"]),
                "kid for leaf {leaf} epoch {epoch}"
            );

            let keys = derive_keys(&base_key, kid);
            assert_eq!(hex_of(&keys.key), case["key"].as_str().expect("key"));
            assert_eq!(hex_of(&keys.salt), case["salt"].as_str().expect("salt"));

            let ctr = Ctr::new(
                u8::try_from(case["slot"].as_u64().expect("slot")).unwrap(),
                u8::try_from(case["layer"].as_u64().expect("layer")).unwrap(),
                case["seq"].as_u64().expect("seq"),
            )
            .expect("ctr");
            assert_eq!(ctr.value(), as_u64(&case["ctr"]), "ctr");
            assert_eq!(
                hex_of(&nonce(&keys.salt, ctr)),
                case["nonce"].as_str().expect("nonce")
            );
            assert_eq!(
                hex_of(&encode_header(kid, ctr)),
                case["header"].as_str().expect("header")
            );
        }
    }

    #[test]
    fn kid_packs_leaf_index_and_the_low_epoch_byte() {
        let kid = Kid::new(3, 297);
        assert_eq!(kid.value(), 809); // (3 << 8) | (297 mod 256 = 41)
        assert_eq!(kid.leaf_index(), 3);
        assert_eq!(kid.epoch_low(), 41);
        assert_eq!(Kid::new(3, 41).value(), Kid::new(3, 297).value());
        assert_eq!(Kid::new(65535, 255).value(), 16_777_215);
        assert_eq!(Kid::from_raw(16_777_215).leaf_index(), 65535);
        assert_eq!(KID_EPOCH_WINDOW, 255);
    }

    /// Anchored against a value computed outside this crate, not against
    /// `hmac_sha256(&[0u8; 32], base_key)` — that is `sframe_secret`'s own definition, so asserting
    /// it would hold for any implementation of either side.
    ///
    /// HKDF-Extract(salt = "", IKM) is HMAC-SHA256(key = 32 zero bytes, IKM) (RFC 5869 section
    /// 2.2). For IKM = `0x0a` x 16 that PRK is the constant below. `derive_keys` performs Extract
    /// and Expand in one `hkdf_sha256` call, so this test is `sframe_secret`'s only coverage: the
    /// sframe vectors do not reach it.
    #[test]
    fn sframe_secret_is_rfc_5869_extract_with_an_empty_salt() {
        let base_key = [0x0au8; NK];
        let expected: [u8; 32] = [
            0x2d, 0xe5, 0x3a, 0x7f, 0xec, 0xa0, 0xf6, 0x49, 0x68, 0x3f, 0xff, 0x23, 0x93, 0x1b,
            0x57, 0x6a, 0xce, 0x9f, 0x84, 0xb1, 0x95, 0xb2, 0x89, 0xb1, 0x65, 0xcd, 0x02, 0x4a,
            0xb8, 0x2b, 0x4c, 0x2c,
        ];
        assert_eq!(sframe_secret(&base_key), expected);
    }

    /// The third-party anchor for the whole schedule: Extract *and* Expand, against a vector this
    /// repository did not produce. RFC 9605 appendix C.3 "SFrame Encryption/Decryption", the
    /// `cipher_suite: 0x0004` (AES_128_GCM_SHA256_128) case, copied verbatim; the same four
    /// constants are pinned on the TypeScript side at
    /// `packages/protocol-vectors/src/sframe.test.ts:78-90`, so both targets are checked against
    /// the RFC rather than against each other.
    ///
    /// `protocol/05-media-frames.md:38` names this vector as the check for the key schedule.
    #[test]
    fn derive_keys_reproduces_the_rfc_9605_c3_suite_0x0004_vector() {
        let base_key = unhex_n::<NK>("000102030405060708090a0b0c0d0e0f");
        let keys = derive_keys(&base_key, Kid::from_raw(0x123));
        assert_eq!(hex_of(&keys.key), "d34f547f4ca4f9a7447006fe7fcbf768");
        assert_eq!(hex_of(&keys.salt), "75234edefe07819026751816");
    }
}
