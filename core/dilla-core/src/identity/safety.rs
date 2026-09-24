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

/// The group size protocol/03-identity.md displays both numbers in: the safety number as 12 groups
/// of 5, the SAS as 6 groups of 5. Named so a caller of [`group_digits`] does not have to build a
/// `NonZeroUsize` for the only value the protocol uses.
pub const DISPLAY_GROUP: core::num::NonZeroUsize = match core::num::NonZeroUsize::new(5) {
    Some(n) => n,
    None => unreachable!(),
};

/// Display helper: split into fixed-size groups joined by single spaces.
///
/// `per_group` is a `NonZeroUsize` rather than a `usize` with an `assert!`: zero is the one value
/// this cannot answer for (`chunks(0)` panics inside `core`), and a display helper has no business
/// aborting the process over a caller's argument. Making it unrepresentable is cheaper than
/// returning a `Result` nobody would have an error type for — and every caller in the protocol
/// wants [`DISPLAY_GROUP`] anyway.
pub fn group_digits(digits: &str, per_group: core::num::NonZeroUsize) -> String {
    let per_group = per_group.get();
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
        let five = DISPLAY_GROUP;
        assert_eq!(five.get(), 5, "protocol/03 displays both numbers in fives");
        assert_eq!(group_digits("1234567890", five), "12345 67890");
        assert_eq!(group_digits("123456789", five), "12345 6789");
        assert_eq!(group_digits(&"0".repeat(60), five).split(' ').count(), 12);
        assert_eq!(group_digits(&"0".repeat(30), five).split(' ').count(), 6);
        // A group wider than the input is one group, not a panic and not padding.
        let wide = core::num::NonZeroUsize::new(100).expect("nonzero");
        assert_eq!(group_digits("123", wide), "123");
        // The empty string has no groups at all.
        assert_eq!(group_digits("", five), "");
    }
}
