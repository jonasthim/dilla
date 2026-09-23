//! Identity: keys, credentials, the signed device list, safety numbers, recovery and pairing
//! (protocol/03-identity.md). This file holds the primitives every submodule shares.

use crate::error::ProtocolError;
use hkdf::Hkdf;
// `KeyInit` is not optional: `new_from_slice` is a method of `KeyInit` (re-exported by `hmac` from
// crypto-common), not of `Mac`. gap-10-openmls.md section 4: "`Mac` and `KeyInit` must both be in
// scope." Without it the two calls below are error[E0599].
use hmac::{Hmac, KeyInit, Mac};
use sha2::{Digest, Sha256};

type HmacSha256 = Hmac<Sha256>;

pub fn sha256(data: &[u8]) -> [u8; 32] {
    let digest = Sha256::digest(data);
    let mut out = [0u8; 32];
    out.copy_from_slice(&digest);
    out
}

pub fn hmac_sha256(key: &[u8], data: &[u8]) -> [u8; 32] {
    let mut mac = HmacSha256::new_from_slice(key).expect("HMAC accepts a key of any length");
    mac.update(data);
    let tag = mac.finalize().into_bytes();
    let mut out = [0u8; 32];
    out.copy_from_slice(&tag);
    out
}

/// Constant-time tag comparison. Never compare MAC output with `==`.
pub fn hmac_sha256_verify(key: &[u8], data: &[u8], tag: &[u8; 32]) -> bool {
    let mut mac = HmacSha256::new_from_slice(key).expect("HMAC accepts a key of any length");
    mac.update(data);
    mac.verify_slice(tag).is_ok()
}

/// HKDF-SHA256 (RFC 5869): Expand(Extract(salt, ikm), info) into `okm`.
///
/// `None` and `Some(&[])` are the same salt for HMAC, so both reproduce the vectors.
/// `Err(ProtocolError::Credential)` on RFC 5869's 255 x HashLen output ceiling: protocol/03
/// defines no separate code for a key-derivation failure, and every caller in dilla asks for 32
/// bytes, so the error is unreachable in practice.
pub fn hkdf_sha256(
    salt: Option<&[u8]>,
    ikm: &[u8],
    info: &[u8],
    okm: &mut [u8],
) -> Result<(), ProtocolError> {
    Hkdf::<Sha256>::new(salt, ikm)
        .expand(info, okm)
        .map_err(|_| ProtocolError::Credential)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn unhex(s: &str) -> Vec<u8> {
        (0..s.len() / 2)
            .map(|i| u8::from_str_radix(&s[2 * i..2 * i + 2], 16).expect("hex digit"))
            .collect()
    }

    #[test]
    fn sha256_matches_the_empty_string_digest() {
        assert_eq!(
            sha256(b"").to_vec(),
            unhex("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855")
        );
    }

    /// RFC 5869 test case 3: empty salt, empty info, 22-byte IKM, L = 42.
    /// The same vector is asserted by packages/protocol-vectors/src/hkdf.test.ts.
    #[test]
    fn hkdf_reproduces_rfc_5869_case_3() {
        let ikm = [0x0bu8; 22];
        let mut okm = [0u8; 42];
        hkdf_sha256(Some(&[]), &ikm, &[], &mut okm).unwrap();
        assert_eq!(
            okm.to_vec(),
            unhex(
                "8da4e775a563c18f715f802a063c5a31b8a11f5c5ee1879ec3454e5f3c738d2d\
                 9d201395faa4b61a96c8"
            )
        );
        // `None` and `Some(&[])` are the same salt for HMAC, so both reproduce the vector.
        let mut okm_none = [0u8; 42];
        hkdf_sha256(None, &ikm, &[], &mut okm_none).unwrap();
        assert_eq!(okm, okm_none);
    }

    #[test]
    fn hkdf_rejects_an_output_longer_than_255_hash_lengths() {
        let mut okm = vec![0u8; 255 * 32 + 1];
        assert_eq!(
            hkdf_sha256(None, b"ikm", b"info", &mut okm),
            Err(ProtocolError::Credential)
        );
    }

    #[test]
    fn hmac_matches_rfc_4231_case_1_truncated_to_sha256() {
        let tag = hmac_sha256(&[0x0bu8; 20], b"Hi There");
        assert_eq!(
            tag.to_vec(),
            unhex("b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7")
        );
    }

    #[test]
    fn hmac_verify_is_constant_time_and_rejects_a_flipped_bit() {
        let key = [0x09u8; 32];
        let tag = hmac_sha256(&key, b"payload");
        assert!(hmac_sha256_verify(&key, b"payload", &tag));
        let mut bad = tag;
        bad[31] ^= 0x01;
        assert!(!hmac_sha256_verify(&key, b"payload", &bad));
        assert!(!hmac_sha256_verify(&[0x0au8; 32], b"payload", &tag));
    }
}
