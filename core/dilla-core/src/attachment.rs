//! The attachment AEAD of protocol/04 § Attachments (Q15): AES-256-GCM under a random per-attachment
//! key and nonce, stored as ciphertext ‖ 16-byte tag, addressed by the SHA-256 of the stored bytes;
//! the thumbnail under the same key with the nonce's byte 11 XOR 0x01 and its own AAD.

use crate::error::ProtocolError;
use aes_gcm::aead::{Aead, Payload};
use aes_gcm::{Aes256Gcm, KeyInit, Nonce};

pub const AAD_BLOB: &[u8] = b"dilla attachment v1";
pub const AAD_THUMB: &[u8] = b"dilla thumb v1";
pub const TAG_LEN: usize = 16;
/// 8 192 (the envelope's thumb bound, on the sealed bytes) minus the tag.
pub const MAX_THUMB_PLAINTEXT: usize = 8_176;

/// nonce with byte 11 XOR 0x01.
pub fn thumb_nonce(nonce: &[u8; 12]) -> [u8; 12] {
    let mut out = *nonce;
    out[11] ^= 0x01;
    out
}

/// SHA-256 of the stored bytes.
pub fn blob_id(stored: &[u8]) -> [u8; 32] {
    crate::identity::sha256(stored)
}

/// aes-gcm 0.10.3's only encrypt error is a plaintext over 2^36 − 32 bytes, which no caller can
/// hold in memory, so the `expect` cannot fire.
fn seal(key: &[u8; 32], nonce: &[u8; 12], aad: &[u8], plaintext: &[u8]) -> Vec<u8> {
    Aes256Gcm::new(key.into())
        .encrypt(
            Nonce::from_slice(nonce),
            Payload {
                msg: plaintext,
                aad,
            },
        )
        .expect("an attachment over the AES-GCM length bound")
}

fn open(
    key: &[u8; 32],
    nonce: &[u8; 12],
    aad: &[u8],
    data: &[u8],
) -> Result<Vec<u8>, ProtocolError> {
    if data.len() < TAG_LEN {
        return Err(ProtocolError::BlobOpen);
    }
    Aes256Gcm::new(key.into())
        .decrypt(Nonce::from_slice(nonce), Payload { msg: data, aad })
        .map_err(|_| ProtocolError::BlobOpen)
}

/// AES-256-GCM(key, nonce, aad = AAD_BLOB) over the file; returns ct ‖ tag (plaintext length + 16 bytes).
pub fn seal_blob(key: &[u8; 32], nonce: &[u8; 12], plaintext: &[u8]) -> Vec<u8> {
    seal(key, nonce, AAD_BLOB, plaintext)
}

/// Order: blob_id(stored) != blob_id → E_BLOB_HASH; stored shorter than TAG_LEN or the AEAD fails → E_BLOB_OPEN;
/// plaintext length != size → E_BLOB_OPEN. Returns the plaintext.
///
/// Attacker statement (lesson e): this refuses only bytes that do not match what the sender
/// sealed; the instance or anyone who swaps blob bytes gets `E_BLOB_HASH`, which is the check's
/// purpose (protocol/04 § Attachments). `blob_id` is a public hash, so `!=` needs no constant time.
pub fn open_blob(
    key: &[u8; 32],
    nonce: &[u8; 12],
    id: &[u8; 32],
    size: u64,
    stored: &[u8],
) -> Result<Vec<u8>, ProtocolError> {
    if blob_id(stored) != *id {
        return Err(ProtocolError::BlobHash);
    }
    let plaintext = open(key, nonce, AAD_BLOB, stored)?;
    if plaintext.len() as u64 != size {
        return Err(ProtocolError::BlobOpen);
    }
    Ok(plaintext)
}

/// AES-256-GCM(key, thumb_nonce(nonce), aad = AAD_THUMB); plaintext over MAX_THUMB_PLAINTEXT → E_ENVELOPE_LIMIT.
pub fn seal_thumb(
    key: &[u8; 32],
    nonce: &[u8; 12],
    plaintext: &[u8],
) -> Result<Vec<u8>, ProtocolError> {
    if plaintext.len() > MAX_THUMB_PLAINTEXT {
        return Err(ProtocolError::EnvelopeLimit);
    }
    Ok(seal(key, &thumb_nonce(nonce), AAD_THUMB, plaintext))
}

/// The AEAD fails or thumb is shorter than TAG_LEN → E_BLOB_OPEN.
pub fn open_thumb(
    key: &[u8; 32],
    nonce: &[u8; 12],
    thumb: &[u8],
) -> Result<Vec<u8>, ProtocolError> {
    open(key, &thumb_nonce(nonce), AAD_THUMB, thumb)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::envelope::MAX_THUMB;
    use crate::error::ProtocolError;

    const KEY: [u8; 32] = [0x07; 32];
    const NONCE: [u8; 12] = [0x09; 12];

    #[test]
    fn the_constants_are_the_protocol_values() {
        assert_eq!(AAD_BLOB, b"dilla attachment v1");
        assert_eq!(AAD_THUMB, b"dilla thumb v1");
        assert_eq!(TAG_LEN, 16);
        assert_eq!(MAX_THUMB_PLAINTEXT, 8_176);
        assert_eq!(
            MAX_THUMB_PLAINTEXT + TAG_LEN,
            MAX_THUMB,
            "a sealed thumbnail fits the envelope bound"
        );
    }

    #[test]
    fn the_thumbnail_nonce_flips_the_low_bit_of_byte_eleven_only() {
        let mut want = [0u8; 12];
        want[11] = 0x01;
        assert_eq!(thumb_nonce(&[0u8; 12]), want);
        let n = [
            0x10, 0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x1b,
        ];
        let t = thumb_nonce(&n);
        assert_eq!(t[..11], n[..11]);
        assert_eq!(t[11], 0x1a);
        assert_eq!(thumb_nonce(&t), n);
    }

    #[test]
    fn a_sealed_blob_is_ciphertext_and_tag_and_opens_to_the_plaintext() {
        let stored = seal_blob(&KEY, &NONCE, b"dilla");
        assert_eq!(stored.len(), 5 + TAG_LEN);
        assert_eq!(blob_id(&stored), crate::identity::sha256(&stored));
        assert_eq!(
            open_blob(&KEY, &NONCE, &blob_id(&stored), 5, &stored),
            Ok(b"dilla".to_vec())
        );
        let empty = seal_blob(&KEY, &NONCE, b"");
        assert_eq!(empty.len(), TAG_LEN, "an empty file is its tag");
        assert_eq!(
            open_blob(&KEY, &NONCE, &blob_id(&empty), 0, &empty),
            Ok(Vec::new())
        );
    }

    #[test]
    fn a_70000_byte_file_round_trips() {
        // (ruled: AI-1) the large-file coverage the vector file no longer carries.
        let plaintext: Vec<u8> = (0..70_000u32).map(|i| (i * 7 % 256) as u8).collect();
        let stored = seal_blob(&[0x57; 32], &[0x58; 12], &plaintext);
        assert_eq!(stored.len(), 70_016);
        assert_eq!(
            open_blob(&[0x57; 32], &[0x58; 12], &blob_id(&stored), 70_000, &stored),
            Ok(plaintext)
        );
    }

    /// Attacker statement (lesson e): `open_blob` refuses only bytes that are not what the sender
    /// sealed. Whoever swaps stored bytes (the instance, a proxy) meets the hash check first.
    #[test]
    fn open_blob_checks_the_hash_then_the_aead_then_the_size() {
        let stored = seal_blob(&KEY, &NONCE, b"dilla");
        let id = blob_id(&stored);
        let mut wrong_id = id;
        wrong_id[0] ^= 0x01;
        assert_eq!(
            open_blob(&KEY, &NONCE, &wrong_id, 5, &stored),
            Err(ProtocolError::BlobHash)
        );
        let mut tampered = stored.clone();
        tampered[0] ^= 0x01;
        assert_eq!(
            open_blob(&KEY, &NONCE, &id, 5, &tampered),
            Err(ProtocolError::BlobHash),
            "the hash is checked before the AEAD"
        );
        assert_eq!(
            open_blob(&KEY, &NONCE, &blob_id(&tampered), 5, &tampered),
            Err(ProtocolError::BlobOpen)
        );
        assert_eq!(
            open_blob(&[0x08; 32], &NONCE, &id, 5, &stored),
            Err(ProtocolError::BlobOpen)
        );
        assert_eq!(
            open_blob(&KEY, &thumb_nonce(&NONCE), &id, 5, &stored),
            Err(ProtocolError::BlobOpen)
        );
        assert_eq!(
            open_blob(&KEY, &NONCE, &id, 6, &stored),
            Err(ProtocolError::BlobOpen)
        );
        let short = &stored[..TAG_LEN - 1];
        assert_eq!(
            open_blob(&KEY, &NONCE, &blob_id(short), 0, short),
            Err(ProtocolError::BlobOpen)
        );
    }

    #[test]
    fn the_two_aads_keep_a_file_and_a_thumbnail_apart() {
        let thumb = seal_thumb(&KEY, &NONCE, b"RIFF").expect("small");
        assert_eq!(
            open_blob(&KEY, &NONCE, &blob_id(&thumb), 4, &thumb),
            Err(ProtocolError::BlobOpen),
            "a thumbnail does not open as a file"
        );
        let blob = seal_blob(&KEY, &thumb_nonce(&NONCE), b"RIFF");
        assert_eq!(
            open_thumb(&KEY, &NONCE, &blob),
            Err(ProtocolError::BlobOpen),
            "a file sealed under the thumbnail nonce does not open as a thumbnail"
        );
        assert_eq!(open_thumb(&KEY, &NONCE, &thumb), Ok(b"RIFF".to_vec()));
    }

    #[test]
    fn a_thumbnail_is_bounded_so_its_sealed_form_fits_the_envelope() {
        let max = vec![0x5a; MAX_THUMB_PLAINTEXT];
        let sealed = seal_thumb(&KEY, &NONCE, &max).expect("at the bound");
        assert_eq!(sealed.len(), MAX_THUMB);
        assert_eq!(open_thumb(&KEY, &NONCE, &sealed), Ok(max));
        assert_eq!(
            seal_thumb(&KEY, &NONCE, &vec![0x5a; MAX_THUMB_PLAINTEXT + 1]),
            Err(ProtocolError::EnvelopeLimit)
        );
        assert_eq!(
            open_thumb(&KEY, &NONCE, &sealed[..TAG_LEN - 1]),
            Err(ProtocolError::BlobOpen)
        );
    }
}
