//! Safety numbers and the pairing/call SAS (protocol/03-identity.md "Safety number").

use super::sha256;

/// The bytes as one unsigned big-endian integer, in decimal, left-padded with zeros to 78 digits
/// (2^256 has 78 decimal digits).
pub fn decimal_digits(bytes: &[u8; 32]) -> String {
    let mut n = *bytes;
    let mut digits: Vec<u8> = Vec::with_capacity(78);
    loop {
        let mut rem = 0u16;
        let mut nonzero = false;
        for b in n.iter_mut() {
            let cur = rem * 256 + u16::from(*b);
            *b = (cur / 10) as u8;
            rem = cur % 10;
            if *b != 0 {
                nonzero = true;
            }
        }
        digits.push(b'0' + rem as u8);
        if !nonzero {
            break;
        }
    }
    while digits.len() < 78 {
        digits.push(b'0');
    }
    digits.reverse();
    String::from_utf8(digits).expect("ascii digits")
}

/// The first 60 digits of `decimal(SHA-256(min(a, b) || max(a, b)))`, compared byte-wise.
/// Displayed as 12 groups of 5.
pub fn safety_number(umk_a: &[u8; 32], umk_b: &[u8; 32]) -> String {
    let (lo, hi) = if umk_a <= umk_b {
        (umk_a, umk_b)
    } else {
        (umk_b, umk_a)
    };
    let mut input = [0u8; 64];
    input[..32].copy_from_slice(lo);
    input[32..].copy_from_slice(hi);
    let mut digits = decimal_digits(&sha256(&input));
    digits.truncate(60);
    digits
}

/// The first 30 digits of the MLS `epoch_authenticator`. Displayed as 6 groups of 5.
pub fn sas(epoch_authenticator: &[u8; 32]) -> String {
    let mut digits = decimal_digits(epoch_authenticator);
    digits.truncate(30);
    digits
}

/// Display helper: split into fixed-size groups joined by single spaces.
pub fn group_digits(digits: &str, per_group: usize) -> String {
    assert!(per_group > 0, "group size must be positive");
    let bytes = digits.as_bytes();
    let mut out = String::with_capacity(digits.len() + digits.len() / per_group);
    for (i, chunk) in bytes.chunks(per_group).enumerate() {
        if i > 0 {
            out.push(' ');
        }
        out.push_str(core::str::from_utf8(chunk).expect("ascii digits"));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decimal_digits_pads_to_78_and_reproduces_the_anchors() {
        assert_eq!(decimal_digits(&[0u8; 32]), "0".repeat(78));
        let mut one = [0u8; 32];
        one[31] = 1;
        assert_eq!(decimal_digits(&one), format!("{}1", "0".repeat(77)));
        assert_eq!(
            decimal_digits(&[0xff; 32]),
            "115792089237316195423570985008687907853269984665640564039457584007913129639935"
        );
    }

    /// protocol/vectors/identity.json, `safety_number`.
    #[test]
    fn safety_number_reproduces_the_vector_and_is_symmetric() {
        let a = [0xa1u8; 32];
        let b = [0xb2u8; 32];
        let expect = "097797588879462191319159221653839944788022939511249052334637";
        assert_eq!(safety_number(&a, &b), expect);
        assert_eq!(safety_number(&b, &a), expect);
        assert_eq!(safety_number(&a, &b).len(), 60);
        assert_ne!(safety_number(&a, &[0x03u8; 32]), expect);
    }

    /// protocol/vectors/identity.json, `sas`.
    #[test]
    fn sas_reproduces_the_vector_and_the_anchors() {
        assert_eq!(sas(&[0xc3u8; 32]), "088546891769712384735671929712");
        assert_eq!(sas(&[0xffu8; 32]), "115792089237316195423570985008");
        assert_eq!(sas(&[0u8; 32]), "0".repeat(30));
    }

    #[test]
    fn group_digits_joins_fixed_size_groups_with_single_spaces() {
        assert_eq!(group_digits("1234567890", 5), "12345 67890");
        assert_eq!(group_digits("123456789", 5), "12345 6789");
        assert_eq!(group_digits(&"0".repeat(60), 5).split(' ').count(), 12);
        assert_eq!(group_digits(&"0".repeat(30), 5).split(' ').count(), 6);
    }
}
