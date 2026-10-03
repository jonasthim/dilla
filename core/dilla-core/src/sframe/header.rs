//! The SFrame header (RFC 9605 section 4.3, as cited by protocol/05-media-frames.md).
//!
//! ```text
//! config byte = (X << 7) | (K << 4) | (Y << 3) | C
//! ```
//! `X` is set when the KID does not fit in three bits; `K` then holds `len(KID) - 1` and the KID
//! bytes follow. `Y` and `C` are the same for the counter. When a value does fit, its field holds
//! the value itself and no extension bytes follow.

use super::{Ctr, Kid, SframeError};

/// The minimum number of big-endian bytes `v` needs, at least 1.
const fn min_len(v: u64) -> usize {
    let mut len = 8;
    while len > 1 && (v >> ((len - 1) * 8)) == 0 {
        len -= 1;
    }
    len
}

fn push_be(out: &mut Vec<u8>, v: u64, len: usize) {
    let bytes = v.to_be_bytes();
    out.extend_from_slice(&bytes[8 - len..]);
}

pub fn encode_header(kid: Kid, ctr: Ctr) -> Vec<u8> {
    let k = kid.value();
    let c = ctr.value();
    let extended_kid = k > 7;
    let extended_ctr = c > 7;
    let klen = min_len(k);
    let clen = min_len(c);

    let kfield = if extended_kid {
        (klen - 1) as u8
    } else {
        k as u8
    };
    let cfield = if extended_ctr {
        (clen - 1) as u8
    } else {
        c as u8
    };
    let config =
        (u8::from(extended_kid) << 7) | (kfield << 4) | (u8::from(extended_ctr) << 3) | cfield;

    let mut out = Vec::with_capacity(1 + klen + clen);
    out.push(config);
    if extended_kid {
        push_be(&mut out, k, klen);
    }
    if extended_ctr {
        push_be(&mut out, c, clen);
    }
    out
}

/// One extended field: `len` big-endian bytes at `at`. Truncation is checked before minimality,
/// so a field that is both cut short and non-minimal reads as truncated.
fn read_extended(bytes: &[u8], at: usize, len: usize) -> Result<u64, SframeError> {
    let field = bytes
        .get(at..at + len)
        .ok_or(SframeError::TruncatedHeader)?;
    let v = field.iter().fold(0u64, |v, b| (v << 8) | u64::from(*b));
    // RFC 9605 section 4.3: a value 0-7 MUST be carried in the config byte, and any other value in
    // the minimum number of bytes. A leading zero byte at length > 1 is a longer-than-minimal field.
    if v <= 7 || (len > 1 && field[0] == 0) {
        return Err(SframeError::NonMinimalHeader);
    }
    Ok(v)
}

/// Returns the KID, the counter and the number of bytes the header occupied, so the caller can
/// step over it to the ciphertext.
///
/// Strict, in reading order: the config byte, then the KID field (truncation, then minimality),
/// then the CTR field. Every one of RFC 9605 appendix C.1's 289 headers decodes; every
/// non-minimal encoding is `NonMinimalHeader`.
pub fn decode_header(bytes: &[u8]) -> Result<(Kid, Ctr, usize), SframeError> {
    let config = *bytes.first().ok_or(SframeError::TruncatedHeader)?;
    let extended_kid = config & 0x80 != 0;
    let kfield = (config >> 4) & 0x7;
    let extended_ctr = config & 0x08 != 0;
    let cfield = config & 0x07;

    let mut at = 1usize;
    let kid = if extended_kid {
        let len = usize::from(kfield) + 1;
        let v = read_extended(bytes, at, len)?;
        at += len;
        v
    } else {
        u64::from(kfield)
    };
    let ctr = if extended_ctr {
        let len = usize::from(cfield) + 1;
        let v = read_extended(bytes, at, len)?;
        at += len;
        v
    } else {
        u64::from(cfield)
    };
    Ok((Kid::from_raw(kid), Ctr::from_raw(ctr), at))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hex_of(b: &[u8]) -> String {
        b.iter().map(|x| format!("{x:02x}")).collect()
    }

    fn unhex(s: &str) -> Vec<u8> {
        (0..s.len() / 2)
            .map(|i| u8::from_str_radix(&s[2 * i..2 * i + 2], 16).expect("hex digit"))
            .collect()
    }

    /// RFC 9605 appendix C.1, as embedded in packages/protocol-vectors/src/sframe.test.ts.
    #[test]
    fn reproduces_the_rfc_9605_c1_header_vectors() {
        for (kid, ctr, expect) in [
            (0u64, 0u64, "00"),
            (0, 0x100, "090100"),
            (0xff, 0, "80ff"),
            (0x100, 0x100, "9901000100"),
        ] {
            let bytes = encode_header(Kid::from_raw(kid), Ctr::from_raw(ctr));
            assert_eq!(hex_of(&bytes), expect, "kid {kid} ctr {ctr}");
            let (k, c, read) = decode_header(&bytes).expect("decode");
            assert_eq!(k.value(), kid);
            assert_eq!(c.value(), ctr);
            assert_eq!(read, bytes.len());
        }
    }

    /// Pins the short-form/extended boundary in exact bytes, which no round-trip test can: decode
    /// is symmetric, so an encoder that spilled 7 into a 2-byte extended field would still round
    /// trip. 7 is the largest value the 3-bit config field holds, so kid = ctr = 7 MUST be one
    /// byte, and 8 MUST be the config byte plus one extension byte each. The TypeScript reference
    /// draws the line in the same place (`packages/protocol-vectors/src/sframe.ts:53`, `k > 7n` /
    /// `ctr > 7n`), and the later cross-target conformance runner compares these bytes directly.
    #[test]
    fn the_short_form_boundary_is_seven() {
        assert_eq!(
            hex_of(&encode_header(Kid::from_raw(7), Ctr::from_raw(7))),
            "77"
        );
        assert_eq!(
            hex_of(&encode_header(Kid::from_raw(8), Ctr::from_raw(8))),
            "880808"
        );
        // Either field alone at the boundary, so a one-sided mutation cannot hide.
        assert_eq!(
            hex_of(&encode_header(Kid::from_raw(7), Ctr::from_raw(8))),
            "7808"
        );
        assert_eq!(
            hex_of(&encode_header(Kid::from_raw(8), Ctr::from_raw(7))),
            "8708"
        );
        // And the strict decoder accepts all four (none of them is in C.1).
        for (h, kid, ctr) in [
            ("77", 7, 7),
            ("880808", 8, 8),
            ("7808", 7, 8),
            ("8708", 8, 7),
        ] {
            let (k, c, n) = decode_header(&unhex(h)).expect(h);
            assert_eq!((k.value(), c.value(), n), (kid, ctr, h.len() / 2), "{h}");
        }
    }

    #[test]
    fn every_header_round_trips() {
        for kid in [0u64, 1, 7, 8, 0xff, 0x100, 0xffff, 0xff_ffff, u64::MAX] {
            for ctr in [0u64, 7, 8, 0xff, 0x100, 0x3e8, 0xffff_ffff, u64::MAX] {
                let bytes = encode_header(Kid::from_raw(kid), Ctr::from_raw(ctr));
                let (k, c, read) = decode_header(&bytes).expect("decode");
                assert_eq!((k.value(), c.value(), read), (kid, ctr, bytes.len()));
            }
        }
    }

    #[test]
    fn decode_rejects_a_truncated_header() {
        let bytes = encode_header(Kid::from_raw(0x100), Ctr::from_raw(0x100));
        assert_eq!(bytes.len(), 5);
        for cut in 0..bytes.len() {
            assert_eq!(
                decode_header(&bytes[..cut]),
                Err(SframeError::TruncatedHeader),
                "truncated to {cut} bytes"
            );
        }
    }

    /// The twelve header rows of `sframe.json`'s `rejects` (interfaces.md d.6), plus the reading
    /// order: `8800` is a non-minimal KID *and* a truncated CTR, and the KID is read first.
    #[test]
    fn decode_rejects_every_non_minimal_and_truncated_header_in_reading_order() {
        for (h, want) in [
            ("", SframeError::TruncatedHeader),
            ("80", SframeError::TruncatedHeader),
            ("8f", SframeError::TruncatedHeader),
            ("99010001", SframeError::TruncatedHeader),
            ("8005", SframeError::NonMinimalHeader),
            ("8007", SframeError::NonMinimalHeader),
            ("0800", SframeError::NonMinimalHeader),
            ("0807", SframeError::NonMinimalHeader),
            ("9000ff", SframeError::NonMinimalHeader),
            ("0900ff", SframeError::NonMinimalHeader),
            ("f00000000000000000", SframeError::NonMinimalHeader),
            ("0f0000000000000008", SframeError::NonMinimalHeader),
            ("8800", SframeError::NonMinimalHeader),
        ] {
            assert_eq!(decode_header(&unhex(h)), Err(want), "{h:?}");
        }
        // `8100ff` is a one-byte extended KID 00 (non-minimal), not a two-byte KID.
        assert_eq!(
            decode_header(&unhex("8100ff")),
            Err(SframeError::NonMinimalHeader)
        );
    }

    #[test]
    fn decode_returns_the_bytes_it_read_so_the_caller_can_advance() {
        let mut framed = encode_header(Kid::from_raw(41), Ctr::from_raw(0));
        let header_len = framed.len();
        framed.extend_from_slice(b"ciphertext");
        let (_, _, read) = decode_header(&framed).expect("decode");
        assert_eq!(read, header_len);
        assert_eq!(&framed[read..], b"ciphertext");
    }
}
