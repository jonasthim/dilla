//! The accept and reject corpora of protocol/04 "Deterministic CBOR",
//! ported from packages/protocol-vectors/src/cbor.test.ts and extended with the
//! cases gap-27 section 7 item 5 found ciborium accepting.

use dilla_core::cbor::{CborError, Decoder, Encoder, MAX_NESTING, decode_strict};

fn unhex(s: &str) -> Vec<u8> {
    assert!(s.len().is_multiple_of(2), "odd hex length: {s}");
    (0..s.len() / 2)
        .map(|i| u8::from_str_radix(&s[2 * i..2 * i + 2], 16).expect("hex digit"))
        .collect()
}

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

/// Every reject case must fail when the item is merely *skipped*: strictness lives in the
/// decoder's head parser, not in the typed readers.
fn skip_all(bytes: &[u8]) -> Result<(), CborError> {
    decode_strict(bytes, |d| d.skip().map(|_| ()))
}

#[test]
fn accepts_and_round_trips_the_uint_corpus() {
    for (v, expect) in [
        (0u64, "00"),
        (1, "01"),
        (10, "0a"),
        (23, "17"),
        (24, "1818"),
        (25, "1819"),
        (100, "1864"),
        (1000, "1903e8"),
        (1_000_000, "1a000f4240"),
        (1_000_000_000_000, "1b000000e8d4a51000"),
    ] {
        let mut e = Encoder::new();
        e.uint(v);
        assert_eq!(hex(e.as_slice()), expect, "encoding {v}");
        assert_eq!(decode_strict(e.as_slice(), |d| d.uint()).unwrap(), v);
    }
}

#[test]
fn accepts_and_round_trips_the_string_and_bytes_corpus() {
    for (s, expect) in [
        ("", "60"),
        ("a", "6161"),
        ("IETF", "6449455446"),
        ("\u{fc}", "62c3bc"),
    ] {
        let mut e = Encoder::new();
        e.text(s);
        assert_eq!(hex(e.as_slice()), expect, "encoding {s:?}");
        assert_eq!(
            decode_strict(e.as_slice(), |d| d.text().map(str::to_owned)).unwrap(),
            s
        );
    }
    for (b, expect) in [(&[][..], "40"), (&[1, 2, 3, 4][..], "4401020304")] {
        let mut e = Encoder::new();
        e.bytes(b);
        assert_eq!(hex(e.as_slice()), expect);
        assert_eq!(
            decode_strict(e.as_slice(), |d| d.bytes().map(<[u8]>::to_vec)).unwrap(),
            b
        );
    }
}

#[test]
fn accepts_and_round_trips_null_and_arrays() {
    let mut e = Encoder::new();
    e.null();
    assert_eq!(hex(e.as_slice()), "f6");
    assert!(decode_strict(e.as_slice(), |d| d.null()).is_ok());

    let mut e = Encoder::new();
    e.array(0);
    assert_eq!(hex(e.as_slice()), "80");

    let mut e = Encoder::new();
    e.array(3).uint(1).uint(2).uint(3);
    assert_eq!(hex(e.as_slice()), "83010203");
    let got = decode_strict(e.as_slice(), |d| {
        d.array(3)?;
        Ok([d.uint()?, d.uint()?, d.uint()?])
    })
    .unwrap();
    assert_eq!(got, [1, 2, 3]);

    // [1, [2, 3], [4, 5]] - fixed-position nesting, no automatic descent
    let mut e = Encoder::new();
    e.array(3)
        .uint(1)
        .array(2)
        .uint(2)
        .uint(3)
        .array(2)
        .uint(4)
        .uint(5);
    assert_eq!(hex(e.as_slice()), "8301820203820405");
}

#[test]
fn head_len_matches_the_encoder() {
    for arg in [
        0u64,
        23,
        24,
        255,
        256,
        65_535,
        65_536,
        0xffff_ffff,
        0x1_0000_0000,
        u64::MAX,
    ] {
        let mut e = Encoder::new();
        e.uint(arg);
        assert_eq!(
            dilla_core::cbor::head_len(arg),
            e.as_slice().len(),
            "head_len disagrees with the encoder for {arg}"
        );
    }
}

#[test]
fn rejects_non_minimal_integer_arguments() {
    for case in [
        "1801",
        "1817",
        "190017",
        "1a00000017",
        "1b0000000000000017",
        "1900ff",
    ] {
        assert_eq!(
            skip_all(&unhex(case)),
            Err(CborError::NonMinimalInt),
            "case {case}"
        );
    }
}

#[test]
fn rejects_non_minimal_lengths_on_majors_2_3_4() {
    for case in ["5800", "7800", "9800", "990003010203"] {
        assert_eq!(
            skip_all(&unhex(case)),
            Err(CborError::NonMinimalInt),
            "case {case}"
        );
    }
}

#[test]
fn rejects_indefinite_lengths() {
    for (case, ai) in [
        ("9f01ff", 31u8),
        ("5f41014102ff", 31),
        ("7f6161ff", 31),
        ("bf0101ff", 31),
    ] {
        assert_eq!(
            skip_all(&unhex(case)),
            Err(CborError::IndefiniteOrReserved(ai)),
            "case {case}"
        );
    }
}

#[test]
fn rejects_maps_tags_floats_and_negatives() {
    for case in ["a0", "a10102"] {
        assert_eq!(
            skip_all(&unhex(case)),
            Err(CborError::MapForbidden),
            "case {case}"
        );
    }
    for case in ["c11a514b67b0", "d8ff01", "c001"] {
        assert_eq!(
            skip_all(&unhex(case)),
            Err(CborError::TagForbidden),
            "case {case}"
        );
    }
    for case in ["fb3ff0000000000000", "f93c00"] {
        assert_eq!(
            skip_all(&unhex(case)),
            Err(CborError::FloatForbidden),
            "case {case}"
        );
    }
    assert_eq!(skip_all(&unhex("20")), Err(CborError::NegativeForbidden));
}

#[test]
fn rejects_every_simple_value_but_null() {
    assert_eq!(skip_all(&unhex("f7")), Err(CborError::SimpleForbidden(23))); // undefined
    assert_eq!(
        skip_all(&unhex("f816")),
        Err(CborError::SimpleForbidden(22))
    ); // non-minimal null
    assert_eq!(skip_all(&unhex("f4")), Err(CborError::SimpleForbidden(20))); // false
    assert_eq!(skip_all(&unhex("f5")), Err(CborError::SimpleForbidden(21))); // true
}

#[test]
fn rejects_reserved_additional_information() {
    for (case, ai) in [("1c", 28u8), ("1d", 29), ("1e", 30)] {
        assert_eq!(
            skip_all(&unhex(case)),
            Err(CborError::IndefiniteOrReserved(ai)),
            "case {case}"
        );
    }
}

#[test]
fn rejects_trailing_bytes() {
    for case in ["0101", "01a0", "83010203ff", "83010203ffffffff"] {
        assert_eq!(
            skip_all(&unhex(case)),
            Err(CborError::TrailingBytes),
            "case {case}"
        );
    }
}

#[test]
fn rejects_truncation_and_bad_utf8() {
    assert_eq!(skip_all(&unhex("5820")), Err(CborError::Truncated));
    assert_eq!(skip_all(&unhex("6263c3")), Err(CborError::InvalidUtf8));
}

#[test]
fn rejects_shape_confusion_in_both_directions() {
    // an array offered where a byte string is required
    let err = decode_strict(&unhex("820102"), |d| d.bytes().map(|_| ())).unwrap_err();
    assert!(
        matches!(
            err,
            CborError::TypeMismatch {
                expected: "bytes",
                offset: 0
            }
        ),
        "{err:?}"
    );
    // a byte string offered where an array is required
    let err = decode_strict(&unhex("420102"), |d| d.array(2)).unwrap_err();
    assert!(
        matches!(
            err,
            CborError::TypeMismatch {
                expected: "array",
                offset: 0
            }
        ),
        "{err:?}"
    );
}

#[test]
fn rejects_wrong_array_and_byte_lengths() {
    let err = decode_strict(&unhex("83010203"), |d| d.array(9)).unwrap_err();
    assert_eq!(
        err,
        CborError::WrongArrayLen {
            expected: 9,
            actual: 3
        }
    );
    let err =
        decode_strict(&unhex("4401020304"), |d| d.bytes_exact::<16>().map(|_| ())).unwrap_err();
    assert_eq!(
        err,
        CborError::WrongByteLen {
            expected: 16,
            actual: 4
        }
    );
}

#[test]
fn accepts_nesting_up_to_the_limit_and_rejects_deeper() {
    let ok: Vec<u8> = std::iter::repeat_n(0x81u8, MAX_NESTING)
        .chain([0x00])
        .collect();
    assert!(
        skip_all(&ok).is_ok(),
        "{} nested arrays must be accepted",
        MAX_NESTING
    );

    // The boundary itself, not a comfortably deeper case: an off-by-one in `skip_inner`'s
    // `depth > MAX_NESTING` would accept 9 levels and still pass a `MAX_NESTING + 2` assertion.
    let one_too_deep: Vec<u8> = std::iter::repeat_n(0x81u8, MAX_NESTING + 1)
        .chain([0x00])
        .collect();
    assert_eq!(
        skip_all(&one_too_deep),
        Err(CborError::TooDeep(MAX_NESTING))
    );

    let deep: Vec<u8> = std::iter::repeat_n(0x81u8, MAX_NESTING + 8)
        .chain([0x00])
        .collect();
    assert_eq!(skip_all(&deep), Err(CborError::TooDeep(MAX_NESTING)));
}

#[test]
fn skip_returns_the_bytes_it_consumed_and_position_tracks() {
    let bytes = unhex("83010203" /* [1,2,3] */);
    let mut d = Decoder::new(&bytes);
    assert_eq!(d.position(), 0);
    assert_eq!(d.skip().unwrap(), &bytes[..]);
    assert_eq!(d.position(), bytes.len());
    assert!(d.finish().is_ok());
}

#[test]
fn optional_readers_consume_nothing_on_a_non_null() {
    let bytes = unhex("5001020304050607080910111213141516");
    let got = decode_strict(&bytes, |d| d.opt_bytes_exact::<16>()).unwrap();
    assert_eq!(got.unwrap()[0], 0x01);

    let got = decode_strict(&unhex("f6"), |d| d.opt_bytes_exact::<16>()).unwrap();
    assert!(got.is_none());

    let got = decode_strict(&unhex("1864"), |d| d.opt_uint()).unwrap();
    assert_eq!(got, Some(100));
}

/// The variable-length twin of `opt_bytes_exact`, added for ABI v2's `credential_identity`.
#[test]
fn opt_bytes_reads_a_bstr_or_a_null() {
    let mut d = Decoder::new(&[0xf6]);
    assert_eq!(d.opt_bytes().unwrap(), None);
    let mut d = Decoder::new(&[0x43, 1, 2, 3]);
    assert_eq!(d.opt_bytes().unwrap(), Some(&[1u8, 2, 3][..]));
    let mut d = Decoder::new(&[0x01]);
    assert!(d.opt_bytes().is_err(), "a uint is not a bstr");
}

#[test]
fn raw_splices_an_already_encoded_sub_item() {
    let mut inner = Encoder::new();
    inner.array(2).uint(2).uint(3);
    let mut outer = Encoder::new();
    outer.array(2).uint(1).raw(inner.as_slice());
    assert_eq!(hex(outer.as_slice()), "8201820203");
}

#[test]
fn rejects_an_array_count_the_remaining_input_cannot_satisfy() {
    // Every array element costs at least one byte, so a count larger than the number of bytes
    // left is truncation, not a valid head. Without the bound the natural
    // `Vec::with_capacity(d.array_len()?)` a caller writes turns these 9 bytes into an OOM.
    assert_eq!(
        decode_strict(&unhex("9bffffffffffffffff"), |d| d.array_len()),
        Err(CborError::Truncated)
    );
    assert_eq!(
        decode_strict(&unhex("9b0000000100000000"), |d| d.array_len()),
        Err(CborError::Truncated)
    );
    // The same head reached through the fixed-length reader.
    assert_eq!(
        decode_strict(&unhex("9bffffffffffffffff"), |d| d.array(3)),
        Err(CborError::Truncated)
    );
    // The boundary in both directions: one byte per element is legal, one more is not.
    let bytes = unhex("83010203");
    let n = decode_strict(&bytes, |d| {
        let n = d.array_len()?;
        for _ in 0..n {
            d.uint()?;
        }
        Ok(n)
    })
    .unwrap();
    assert_eq!(n, 3);
    assert_eq!(
        decode_strict(&unhex("830102"), |d| d.array_len()),
        Err(CborError::Truncated)
    );
}
