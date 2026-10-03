//! Seal and open over `P || H || C || T` with AAD `H || P` (protocol/05 "Frame format").
//!
//! `encrypt_frame`/`open_frame`/`peek_kid_ctr` work on the unescaped layout; `protect` and
//! `unescape_protected` add the codec layer (the prefix rule, H.264 canonicalisation and the
//! seeded RBSP escape) that the sender, the key ring, the vectors runner and the wasm surface
//! share.

use aes_gcm::aead::{AeadInPlace, KeyInit};
use aes_gcm::{Aes128Gcm, Nonce, Tag};

use super::h264::{canonicalize_h264, rbsp_escape, rbsp_unescape, trailing_zeros};
use super::prefix::prefix_len;
use super::{Codec, Ctr, FrameKey, Kid, NT, SframeError, decode_header, encode_header, nonce};

/// `P || H || C || T`: `frame[..prefix_len]` stays clear, the rest is sealed under `key` with the
/// nonce `salt XOR CTR` and AAD `H || P`.
pub fn encrypt_frame(
    key: &FrameKey,
    kid: Kid,
    ctr: Ctr,
    prefix_len: usize,
    frame: &[u8],
) -> Result<Vec<u8>, SframeError> {
    let prefix = frame
        .get(..prefix_len)
        .ok_or(SframeError::MalformedPrefix)?;
    let header = encode_header(kid, ctr);
    let mut aad = Vec::with_capacity(header.len() + prefix.len());
    aad.extend_from_slice(&header);
    aad.extend_from_slice(prefix);

    let mut out = Vec::with_capacity(frame.len() + header.len() + NT);
    out.extend_from_slice(prefix);
    out.extend_from_slice(&header);
    let body = out.len();
    out.extend_from_slice(&frame[prefix_len..]);

    let cipher = Aes128Gcm::new((&key.key).into());
    let n = nonce(&key.salt, ctr);
    let tag = cipher
        .encrypt_in_place_detached(Nonce::from_slice(&n), &aad, &mut out[body..])
        .map_err(|_| SframeError::AuthFailed)?;
    out.extend_from_slice(&tag);
    Ok(out)
}

/// The KID, the counter and the header length of an unescaped frame, without decrypting: what a
/// receiver needs to pick the key.
pub fn peek_kid_ctr(prefix_len: usize, frame: &[u8]) -> Result<(Kid, Ctr, usize), SframeError> {
    let rest = frame
        .get(prefix_len..)
        .ok_or(SframeError::MalformedPrefix)?;
    decode_header(rest)
}

/// Opens an unescaped frame under `key` and returns its KID, counter and `P || plaintext`.
/// `TruncatedFrame` when fewer than 16 bytes follow the header; `AuthFailed` on any tag mismatch
/// (constant-time, `subtle::ConstantTimeEq` inside `aes-gcm`).
pub fn open_frame(
    key: &FrameKey,
    prefix_len: usize,
    frame: &[u8],
) -> Result<(Kid, Ctr, Vec<u8>), SframeError> {
    let (kid, ctr, header_len) = peek_kid_ctr(prefix_len, frame)?;
    let prefix = &frame[..prefix_len];
    let sealed = &frame[prefix_len + header_len..];
    if sealed.len() < NT {
        return Err(SframeError::TruncatedFrame);
    }
    let (ciphertext, tag) = sealed.split_at(sealed.len() - NT);

    let mut aad = Vec::with_capacity(header_len + prefix_len);
    aad.extend_from_slice(&frame[prefix_len..prefix_len + header_len]);
    aad.extend_from_slice(prefix);

    let mut out = Vec::with_capacity(prefix_len + ciphertext.len());
    out.extend_from_slice(prefix);
    out.extend_from_slice(ciphertext);
    let cipher = Aes128Gcm::new((&key.key).into());
    let n = nonce(&key.salt, ctr);
    cipher
        .decrypt_in_place_detached(
            Nonce::from_slice(&n),
            &aad,
            &mut out[prefix_len..],
            Tag::from_slice(tag),
        )
        .map_err(|_| SframeError::AuthFailed)?;
    Ok((kid, ctr, out))
}

/// The sender's whole codec path: compute the prefix (H.264: canonicalise first), seal, and for
/// H.264 escape everything after the prefix with the zero counter seeded by the prefix's trailing
/// zeros.
pub fn protect(
    key: &FrameKey,
    kid: Kid,
    ctr: Ctr,
    codec: Codec,
    frame: &[u8],
) -> Result<Vec<u8>, SframeError> {
    if codec != Codec::H264 {
        let prefix = prefix_len(codec, frame)?;
        return encrypt_frame(key, kid, ctr, prefix, frame);
    }
    let (canonical, prefix) = canonicalize_h264(frame)?;
    let sealed = encrypt_frame(key, kid, ctr, prefix, &canonical)?;
    let mut out = sealed[..prefix].to_vec();
    out.extend_from_slice(&rbsp_escape(
        trailing_zeros(&sealed[..prefix]),
        &sealed[prefix..],
    ));
    Ok(out)
}

/// The receiver's inverse of `protect`'s codec layer: `(P || unescaped H||C||T, prefix_len)`,
/// ready for `peek_kid_ctr` and `open_frame`.
pub fn unescape_protected(codec: Codec, frame: &[u8]) -> Result<(Vec<u8>, usize), SframeError> {
    let prefix = prefix_len(codec, frame)?;
    if codec != Codec::H264 {
        return Ok((frame.to_vec(), prefix));
    }
    let mut out = frame[..prefix].to_vec();
    out.extend_from_slice(&rbsp_unescape(
        trailing_zeros(&frame[..prefix]),
        &frame[prefix..],
    ));
    Ok((out, prefix))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sframe::NK;

    fn unhex(s: &str) -> Vec<u8> {
        (0..s.len() / 2)
            .map(|i| u8::from_str_radix(&s[2 * i..2 * i + 2], 16).expect("hex digit"))
            .collect()
    }

    fn hex(b: &[u8]) -> String {
        b.iter().map(|x| format!("{x:02x}")).collect()
    }

    const BASE: [u8; NK] = [0x0a; NK];
    const VP8_KEY_IN: &str = "5002009d012a8002e0010102030405060708";
    const VP8_KEY_OUT: &str = "5002009d012a8002e0019f032901200000000003e8690e3801073c4c990ed0d5ad5735f3b67f0fdaa765afe0ba";

    fn open(codec: Codec, frame: &[u8]) -> Result<Vec<u8>, SframeError> {
        let (unescaped, prefix) = unescape_protected(codec, frame)?;
        let (kid, _, _) = peek_kid_ctr(prefix, &unescaped)?;
        let (_, _, plain) = open_frame(&FrameKey::derive(&BASE, kid), prefix, &unescaped)?;
        Ok(plain)
    }

    /// RFC 9605 appendix C.3, suite 0x0004, as a dilla frame: the RFC's metadata is the prefix,
    /// and the AAD is header || metadata (metadata || header does not reproduce it).
    #[test]
    fn reproduces_the_rfc_9605_c3_frame() {
        let base: [u8; NK] = unhex("000102030405060708090a0b0c0d0e0f")
            .try_into()
            .expect("16 bytes");
        let kid = Kid::from_raw(0x123);
        let ctr = Ctr::from_raw(0x4567);
        let prefix = unhex("4945544620534672616d65205747");
        let mut input = prefix.clone();
        input.extend_from_slice(&unhex("64726166742d696574662d736672616d652d656e63"));
        let key = FrameKey::derive(&base, kid);
        let sealed = encrypt_frame(&key, kid, ctr, prefix.len(), &input).expect("seal");
        assert_eq!(
            hex(&sealed),
            "4945544620534672616d652057479901234567b7412c2513a1b66dbb48841bbaf17f598751176ad847681a69c6d0b091c07018ce4adb34eb"
        );
        let (k, c, plain) = open_frame(&key, prefix.len(), &sealed).expect("open");
        assert_eq!((k, c, plain), (kid, ctr, input));
    }

    #[test]
    fn the_three_media_vectors_seal_and_open() {
        for (codec, leaf, epoch, slot, layer, seq, input, output) in [
            (
                Codec::Opus,
                0u16,
                41u64,
                0u8,
                0u8,
                0u64,
                "fc0102030405060708",
                "8029e2cb55c1af3559fae36751e93f325d2aaeff190e61164a66ff",
            ),
            (
                Codec::Vp8,
                3,
                41,
                1,
                0,
                1,
                "310102030405060708",
                "319f03290100000000000001340a6b27e8eb6e0103de9bc092d5abe52394632f8ecd2519",
            ),
            (Codec::Vp8, 3, 297, 1, 2, 1000, VP8_KEY_IN, VP8_KEY_OUT),
        ] {
            let kid = Kid::new(leaf, epoch);
            let ctr = Ctr::new(slot, layer, seq).expect("ctr");
            let key = FrameKey::derive(&BASE, kid);
            let sealed = protect(&key, kid, ctr, codec, &unhex(input)).expect("protect");
            assert_eq!(hex(&sealed), output, "{codec:?} {input}");
            assert_eq!(hex(&open(codec, &sealed).expect("open")), input);
        }
    }

    #[test]
    fn the_h264_vector_is_escaped_after_its_prefix_and_opens() {
        let input =
            unhex("000000016742c01e95a0501ec80000000168ce3c800000000165888421ff00000312345a5a5a5a");
        let kid = Kid::new(3, 41);
        let ctr = Ctr::new(1, 0, 5).expect("ctr");
        let key = FrameKey::derive(&BASE, kid);
        let sealed = protect(&key, kid, ctr, Codec::H264, &input).expect("protect");
        assert_eq!(
            hex(&sealed),
            "000000016742c01e95a0501ec80000000168ce3c80000000016588849f032901000003000003000005db05f193d08dc6cc86f2420a0baae4e1e76087c4740ff030eb87e1"
        );
        assert_eq!(open(Codec::H264, &sealed).expect("open"), input);
    }

    /// The five AEAD rows of `sframe.json`'s `rejects`: a flipped tag bit, a flipped prefix byte
    /// (the test that the prefix is in the AAD), a flipped ciphertext bit, a changed CTR byte in
    /// the header, and a tag one byte short.
    #[test]
    fn every_aead_tamper_is_refused() {
        for (frame, want) in [
            (
                "5002009d012a8002e0019f032901200000000003e8690e3801073c4c990ed0d5ad5735f3b67f0fdaa765afe0bb",
                SframeError::AuthFailed,
            ),
            (
                "5002009d012a8102e0019f032901200000000003e8690e3801073c4c990ed0d5ad5735f3b67f0fdaa765afe0ba",
                SframeError::AuthFailed,
            ),
            (
                "5002009d012a8002e0019f032901200000000003e8680e3801073c4c990ed0d5ad5735f3b67f0fdaa765afe0ba",
                SframeError::AuthFailed,
            ),
            (
                "5002009d012a8002e0019f032901200000000003e9690e3801073c4c990ed0d5ad5735f3b67f0fdaa765afe0ba",
                SframeError::AuthFailed,
            ),
            (
                "5002009d012a8002e0019f032901200000000003e8690e3801073c4c990ed0d5ad5735f3",
                SframeError::TruncatedFrame,
            ),
        ] {
            assert_eq!(open(Codec::Vp8, &unhex(frame)), Err(want), "{frame}");
        }
        assert_eq!(
            open(Codec::Vp8, &unhex("5002009d012a8002e0")),
            Err(SframeError::MalformedPrefix)
        );
    }

    #[test]
    fn a_prefix_longer_than_the_frame_is_malformed() {
        let kid = Kid::new(0, 0);
        let key = FrameKey::derive(&BASE, kid);
        assert_eq!(
            encrypt_frame(&key, kid, Ctr::from_raw(0), 4, &[1, 2, 3]),
            Err(SframeError::MalformedPrefix)
        );
        assert_eq!(
            peek_kid_ctr(4, &[1, 2, 3]),
            Err(SframeError::MalformedPrefix)
        );
    }
}
