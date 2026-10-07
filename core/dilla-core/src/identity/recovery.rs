//! The recovery key's Crockford base32 form and the two keys derived from it
//! (protocol/03-identity.md "Recovery", protocol/06-backup-archive.md "Keys").
//!
//! The 24-word BIP-39 form is deliberately absent: no reference implementation and no vector for
//! it exists in this repository, so there is nothing to check an implementation against.

use super::{CROCKFORD, INFO_ARCHIVE, INFO_HEADER, hkdf_sha256};
use crate::error::ProtocolError;

/// MSB-first 5-bit groups, uppercase, ungrouped. The final character of a 32-byte input carries
/// one payload bit followed by four zero bits.
pub(super) fn crockford_encode(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len().div_ceil(5) * 8);
    let (mut acc, mut bits) = (0u16, 0u8);
    for b in bytes {
        acc = (acc << 8) | u16::from(*b);
        bits += 8;
        while bits >= 5 {
            out.push(char::from(CROCKFORD[usize::from((acc >> (bits - 5)) & 31)]));
            bits -= 5;
        }
    }
    if bits > 0 {
        out.push(char::from(CROCKFORD[usize::from((acc << (5 - bits)) & 31)]));
    }
    out
}

/// The inverse. Uppercase only, and any bits past the byte boundary must be zero, so one byte
/// string has exactly one spelling.
pub(super) fn crockford_decode(s: &str) -> Result<Vec<u8>, ProtocolError> {
    let out_len = s.len() * 5 / 8;
    if out_len == 0 || s.len() != out_len * 8 / 5 + usize::from(!(out_len * 8).is_multiple_of(5)) {
        return Err(ProtocolError::Credential);
    }
    let mut out = Vec::with_capacity(out_len);
    let (mut acc, mut bits) = (0u16, 0u8);
    for c in s.bytes() {
        let value = CROCKFORD
            .iter()
            .position(|k| *k == c)
            .ok_or(ProtocolError::Credential)? as u16;
        acc = (acc << 5) | value;
        bits += 5;
        if bits >= 8 {
            out.push(((acc >> (bits - 8)) & 0xff) as u8);
            bits -= 8;
        }
    }
    if out.len() != out_len || (acc & ((1 << bits) - 1)) != 0 {
        return Err(ProtocolError::Credential);
    }
    Ok(out)
}

/// 256 bits as 52 Crockford base32 characters, uppercase and ungrouped. The display form is
/// 13 groups of 4; grouping is a rendering concern, not part of the encoding.
pub fn recovery_key_base32(rk: &[u8; 32]) -> String {
    crockford_encode(rk)
}

pub fn recovery_key_from_base32(s: &str) -> Result<[u8; 32], ProtocolError> {
    if s.len() != 52 {
        return Err(ProtocolError::Credential);
    }
    let bytes = zeroize::Zeroizing::new(crockford_decode(s)?);
    let mut out = [0u8; 32];
    if bytes.len() != 32 {
        return Err(ProtocolError::Credential);
    }
    out.copy_from_slice(&bytes);
    Ok(out)
}

/// Drops ASCII space, tab, newline, carriage return, hyphen-minus, en dash and em dash;
/// upper-cases ASCII a-z; maps I/L to 1 and O to 0; keeps every other character.
pub fn recovery_key_normalise(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for ch in text.chars() {
        if matches!(ch, ' ' | '\t' | '\n' | '\r' | '-' | '\u{2013}' | '\u{2014}') {
            continue;
        }
        let up = ch.to_ascii_uppercase();
        out.push(match up {
            'I' | 'L' => '1',
            'O' => '0',
            _ => up,
        });
    }
    out
}

/// `HKDF-SHA256(salt = "", IKM = RK, info = "dilla header v1", L = 32)`
pub fn k_header(rk: &[u8; 32]) -> [u8; 32] {
    let mut out = [0u8; 32];
    hkdf_sha256(Some(&[]), rk, INFO_HEADER, &mut out).expect("32 bytes is within the HKDF limit");
    out
}

/// `HKDF-SHA256(salt = "", IKM = RK, info = "dilla archive v1", L = 32)`
pub fn k_backup(rk: &[u8; 32]) -> [u8; 32] {
    let mut out = [0u8; 32];
    hkdf_sha256(Some(&[]), rk, INFO_ARCHIVE, &mut out).expect("32 bytes is within the HKDF limit");
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn unhex32(s: &str) -> [u8; 32] {
        let mut out = [0u8; 32];
        for (i, b) in out.iter_mut().enumerate() {
            *b = u8::from_str_radix(&s[2 * i..2 * i + 2], 16).expect("hex digit");
        }
        out
    }

    /// protocol/vectors/identity.json, `recovery_key`.
    #[test]
    fn recovery_key_base32_reproduces_the_vector_and_round_trips() {
        let rk = [0x0bu8; 32];
        let expect = "1C5GP2RB1C5GP2RB1C5GP2RB1C5GP2RB1C5GP2RB1C5GP2RB1C5G";
        assert_eq!(recovery_key_base32(&rk), expect);
        assert_eq!(expect.len(), 52);
        assert_eq!(recovery_key_from_base32(expect).unwrap(), rk);

        assert_eq!(recovery_key_base32(&[0u8; 32]), "0".repeat(52));
        assert_eq!(
            recovery_key_from_base32(&"0".repeat(52)).unwrap(),
            [0u8; 32]
        );
    }

    #[test]
    fn recovery_key_from_base32_rejects_bad_input() {
        let ok = recovery_key_base32(&[0x0bu8; 32]);
        assert_eq!(
            recovery_key_from_base32(&ok[..51]),
            Err(ProtocolError::Credential)
        );
        assert_eq!(
            recovery_key_from_base32(&format!("{ok}0")),
            Err(ProtocolError::Credential)
        );
        // U, I, L and O are outside the Crockford alphabet
        assert_eq!(
            recovery_key_from_base32(&format!("U{}", &ok[1..])),
            Err(ProtocolError::Credential)
        );
        assert_eq!(
            recovery_key_from_base32(&ok.to_lowercase()),
            Err(ProtocolError::Credential)
        );
        // the 52nd character carries 1 payload bit and 4 zero bits; a non-zero remainder is invalid
        let mut bad: Vec<char> = ok.chars().collect();
        bad[51] = 'Z';
        assert_eq!(
            recovery_key_from_base32(&bad.into_iter().collect::<String>()),
            Err(ProtocolError::Credential)
        );
    }

    /// protocol/vectors/identity.json, `recovery_key.k_header` / `k_backup`.
    #[test]
    fn derived_keys_reproduce_the_vector() {
        let rk = [0x0bu8; 32];
        assert_eq!(
            k_header(&rk),
            unhex32("9fbf18dbf25c74e20589a850571aa504c9fe2d05fdbd303a1d0e3a20f27e6967")
        );
        assert_eq!(
            k_backup(&rk),
            unhex32("2888f1d18f96115fb632fd340d1e3bfbcb765e9883a12cc5afa0c76b2fbf72d2")
        );
        assert_ne!(k_header(&rk), k_backup(&rk));
    }
    /// L-CORE-28: the vectors packages/client-core/src/recovery-key.test.ts asserts byte for byte.
    #[test]
    fn recovery_key_normalise_reproduces_the_shared_vectors() {
        assert_eq!(recovery_key_normalise("abcd-efgh"), "ABCDEFGH");
        assert_eq!(recovery_key_normalise("AB CD\nEF"), "ABCDEF");
        assert_eq!(recovery_key_normalise("il1o0"), "11100");
        assert_eq!(recovery_key_normalise("A\u{2013}B\u{2014}C"), "ABC");
        assert_eq!(recovery_key_normalise("ABCU"), "ABCU");
        assert_eq!(recovery_key_normalise("a\tb\r\nc"), "ABC");
        assert_eq!(recovery_key_normalise(""), "");
        assert_eq!(
            recovery_key_normalise("\u{e9}-\u{fc}_"),
            "\u{e9}\u{fc}_",
            "non-ASCII and other punctuation are kept for the parser to refuse"
        );
    }

    #[test]
    fn a_shown_key_survives_typing_and_paste() {
        let rk = [0x0bu8; 32];
        let shown = recovery_key_base32(&rk);
        assert_eq!(
            recovery_key_normalise(&shown),
            shown,
            "the shown form is a fixed point"
        );
        let groups: Vec<&str> = (0..13).map(|i| &shown[4 * i..4 * i + 4]).collect();
        let typed = groups.join("-").to_lowercase();
        assert_eq!(
            recovery_key_from_base32(&recovery_key_normalise(&typed)),
            Ok(rk)
        );
        let pasted = format!("  {}\r\n", groups.join(" "));
        assert_eq!(
            recovery_key_from_base32(&recovery_key_normalise(&pasted)),
            Ok(rk)
        );
        let with_u = format!("U{}", &shown[1..]);
        assert_eq!(recovery_key_normalise(&with_u), with_u);
        assert_eq!(
            recovery_key_from_base32(&recovery_key_normalise(&with_u)),
            Err(ProtocolError::Credential),
            "U survives normalisation and the strict parser refuses it"
        );
    }
}
