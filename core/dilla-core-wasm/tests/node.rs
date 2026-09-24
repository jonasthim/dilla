//! Conformance under `wasm32-unknown-unknown`, executed by Node through
//! `wasm-bindgen-test-runner` (the `.cargo/config.toml` runner, R6). No browser and no
//! chromedriver is involved; OPFS is task 17's Playwright spike.

#![cfg(target_arch = "wasm32")]

use dilla_core::cbor::{CborError, Decoder, Encoder, decode_strict};
use dilla_core_wasm::store::redacted_sqlite_message;
use dilla_core_wasm::{
    abi_version, core_version, credential_identity_cbor, envelope_commitment, envelope_decode_json,
    envelope_encode, franking_tag, recovery_key_base32, safety_number, sas, sframe_derive,
    sframe_header, vectors_check_json, vectors_check_ok,
};
use wasm_bindgen_test::*;

// NV-8: delete this line if step 1 shows the identifier does not exist on 0.3.78; Node is the
// runner's default either way.
wasm_bindgen_test_configure!(run_in_node_experimental);

fn unhex(s: &str) -> Vec<u8> {
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap())
        .collect()
}

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

const VECTOR_ENVELOPE_CBOR: &str = "89015011111111111111111111111111111111035012121212121212121212121212121212501313131313131313131313131313131363e29b8f808058201616161616161616161616161616161616161616161616161616161616161616";
const VECTOR_ENVELOPE_COMMITMENT: &str =
    "ab2930d97f3c839758c035d9b2ace3b85676e65a37807b66370ffb2885a23148";

/// The committed golden of suite names, in order, from `dilla_core::vectors`' five runners
/// (Plan A task 11 writes `SuiteReport { name: "envelope" | "franking" | "sframe" | "identity" |
/// "rejects", .. }`). Without it, comparing the wasm report against a report produced by the same
/// wasm build proves only internal consistency: a build that silently lost an entire suite would
/// pass. Plan B task 4 holds the equivalent golden for the wasip1 leg.
const EXPECTED_SUITES: [&str; 5] = ["envelope", "franking", "sframe", "identity", "rejects"];

#[wasm_bindgen_test]
fn the_vector_report_is_green_on_wasm() {
    let report = dilla_core::vectors::run_all();
    assert_eq!(report.failed, 0, "wasm32 report:\n{}", report.to_text());
    assert!(report.passed > 0, "a zero-case report would pass vacuously");
    assert!(vectors_check_ok());
}

/// The point of the cross-target triangle is not "wasm is green" but "every field of every case
/// holds under wasm too", so this asserts per case, naming the one that broke.
#[wasm_bindgen_test]
fn every_case_of_every_suite_holds_on_wasm() {
    let report = dilla_core::vectors::run_all();
    let json = vectors_check_json();

    let names: Vec<&str> = report.suites.iter().map(|s| s.name).collect();
    assert_eq!(
        names, EXPECTED_SUITES,
        "the wasm build must run all five suites, in order"
    );

    // Every CaseReport is one (case, field) check, so the two counters and the case rows must agree.
    // A suite dropped between `run_all()` and the counters would break this even if the names held.
    let cases: usize = report.suites.iter().map(|s| s.cases.len()).sum();
    assert_eq!(
        cases as u32,
        report.passed + report.failed,
        "passed + failed must account for every case row"
    );

    for suite in &report.suites {
        assert!(
            json.contains(&format!("\"name\":\"{}\"", suite.name)),
            "missing suite {}",
            suite.name
        );
        assert!(!suite.cases.is_empty(), "suite {} has no cases", suite.name);
        for case in &suite.cases {
            assert!(
                case.ok,
                "{}/{}/{}: expected {} got {}",
                suite.name, case.case, case.field, case.expected, case.actual
            );
        }
    }
    assert!(json.contains("\"failed\":0"));
}

#[wasm_bindgen_test]
fn the_cbor_reject_corpus_behaves_identically_on_wasm() {
    // interfaces §2.3's reject corpus, one entry per rejection class.
    let cases: [(&str, &str); 12] = [
        ("1817", "non-minimal uint"),
        ("190017", "non-minimal uint"),
        ("5800", "non-minimal length"),
        ("9f01ff", "indefinite array"),
        ("5f41014102ff", "indefinite bstr"),
        ("a0", "map"),
        ("c11a514b67b0", "tag"),
        ("fb3ff0000000000000", "double"),
        ("f93c00", "half"),
        ("20", "negative"),
        ("f7", "undefined"),
        ("1c", "reserved additional info"),
    ];
    for (hexed, what) in cases {
        let bytes = unhex(hexed);
        let out: Result<(), CborError> = decode_strict(&bytes, |d: &mut Decoder<'_>| {
            d.skip()?;
            Ok(())
        });
        assert!(
            out.is_err(),
            "{what} ({hexed}) must be rejected on wasm too"
        );
    }
    let trailing = unhex("0101");
    assert!(matches!(
        decode_strict(&trailing, |d: &mut Decoder<'_>| d.uint().map(|_| ())),
        Err(CborError::TrailingBytes)
    ));
}

#[wasm_bindgen_test]
fn the_cbor_accept_corpus_round_trips_byte_identically_on_wasm() {
    let mut e = Encoder::new();
    e.array(3).uint(1).uint(2).uint(3);
    assert_eq!(hex(&e.into_vec()), "83010203");
    let mut e = Encoder::new();
    e.uint(1_000_000);
    assert_eq!(hex(&e.into_vec()), "1a000f4240");
    let mut e = Encoder::new();
    e.text("IETF");
    assert_eq!(hex(&e.into_vec()), "6449455446");
    let mut e = Encoder::new();
    e.null();
    assert_eq!(hex(&e.into_vec()), "f6");
    let mut e = Encoder::new();
    e.bytes(&[1, 2, 3, 4]);
    assert_eq!(hex(&e.into_vec()), "4401020304");
}

#[wasm_bindgen_test]
fn the_wasm_bindgen_surface_reproduces_the_envelope_vector() {
    let json = envelope_decode_json(&unhex(VECTOR_ENVELOPE_CBOR)).unwrap();
    assert_eq!(hex(&envelope_encode(&json).unwrap()), VECTOR_ENVELOPE_CBOR);
    assert_eq!(
        hex(&envelope_commitment(&unhex(VECTOR_ENVELOPE_CBOR)).unwrap()),
        VECTOR_ENVELOPE_COMMITMENT
    );
}

#[wasm_bindgen_test]
fn the_wasm_bindgen_surface_reproduces_the_sframe_and_identity_vectors() {
    let keys = sframe_derive(&unhex("0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a"), 3, 41).unwrap();
    assert_eq!(hex(&keys.key()), "3fe54e870b67caffa901a88054d2cb6f");
    assert_eq!(hex(&keys.salt()), "f92a07e1770098f68ed24805");
    // `kid` in `sframe.json` is the decimal string "809" (interfaces §2.9), not hex: it is
    // `Kid::new(leaf_index = 3, epoch = 41)` = `(3 << 8) | 41`. `0x809` would be leaf 8 / epoch-low 9.
    assert_eq!(hex(&sframe_header(809, 1).unwrap()), "910329");
    assert_eq!(
        safety_number(
            &unhex("a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1"),
            &unhex("b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2")
        )
        .unwrap(),
        "097797588879462191319159221653839944788022939511249052334637"
    );
    assert_eq!(
        sas(&unhex(
            "c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3"
        ))
        .unwrap(),
        "088546891769712384735671929712"
    );
    assert_eq!(
        recovery_key_base32(&unhex(
            "0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b"
        ))
        .unwrap(),
        "1C5GP2RB1C5GP2RB1C5GP2RB1C5GP2RB1C5GP2RB1C5GP2RB1C5G"
    );
}

/// Every rejection path of the wasm-bindgen surface lives here rather than in task 15's native test
/// module: constructing a `JsError` off wasm goes through `__wbindgen_error_new`, whose non-wasm stub
/// panics, so these assertions can only be made where the intrinsics are real (NV-12).
#[wasm_bindgen_test]
fn errors_cross_the_boundary_as_values_not_panics() {
    assert!(
        envelope_decode_json(&unhex("a0")).is_err(),
        "a CBOR map is not an envelope"
    );
    let mut trailing = unhex(VECTOR_ENVELOPE_CBOR);
    trailing.push(0x01);
    assert!(
        envelope_decode_json(&trailing).is_err(),
        "trailing bytes must not decode"
    );
    assert!(
        sframe_derive(&[0u8; 15], 0, 0).is_err(),
        "a 15-byte base key is not NK"
    );
    assert!(credential_identity_cbor("{}").is_err());
    assert!(
        franking_tag(&[0u8; 32], &[0u8; 16], 1, 1, &[0u8; 16], &[0u8; 31], 0).is_err(),
        "a 31-byte commitment is not a 32-byte one"
    );
}

/// Deviation A2-14 applied to deviation A2-10's probes. `unencrypted_vfs_probe` and
/// `wrong_key_probe` render the failure of
/// `PRAGMA cipher = 'chacha20'; PRAGMA key = 'raw:<64-hex device KEK>';`, and task 17's worker calls
/// the first of them with the real store key and publishes the result on the page, so whatever the
/// helper returns is readable by anything running in that page. `redacted_sqlite_message` is the
/// only renderer either probe may use: it keeps SQLite's own primary message — the string the spike
/// asserts on — and withholds every other variant's `Display`, several of which embed text the
/// caller handed to SQLite. `Error::SqlInputError` is the worst of them (it renders as
/// `"{msg} in {sql} at offset {offset}"`, i.e. the whole statement — rusqlite-0.40.2/src/error.rs
/// lines 346-351, produced by `error_with_offset` at lines 502-509); this build cannot construct it,
/// because `modern_sqlite` is off under the `ffi-sqlite-wasm-rs` backend and the variant is
/// `#[cfg(feature = "modern_sqlite")]`, so `InvalidParameterName` stands in for the whole class.
#[wasm_bindgen_test]
fn a_redacted_probe_message_never_carries_the_statement() {
    const KEK: &str = "0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b";
    let statement = format!("PRAGMA cipher = 'chacha20'; PRAGMA key = 'raw:{KEK}';");

    // The arm the spike depends on: SQLite's primary message, kept verbatim. This is exactly the
    // string task 17's plain-VFS probe asserts on, so redaction must not blunt it.
    let primary = rusqlite::Error::SqliteFailure(
        rusqlite::ffi::Error::new(1),
        Some("Setting key failed. Encryption is not supported by the VFS.".to_owned()),
    );
    assert_eq!(
        redacted_sqlite_message(&primary),
        "Setting key failed. Encryption is not supported by the VFS."
    );

    // Any variant whose Display embeds text handed to SQLite is withheld whole.
    let leaky = rusqlite::Error::InvalidParameterName(statement);
    assert!(
        leaky.to_string().contains(KEK),
        "premise of this test: this variant's Display does carry the statement"
    );
    let rendered = redacted_sqlite_message(&leaky);
    assert!(
        !rendered.contains(KEK),
        "the redacted message leaked the KEK: {rendered}"
    );
    assert!(
        !rendered.contains("PRAGMA"),
        "the redacted message leaked the statement: {rendered}"
    );
}

#[wasm_bindgen_test]
fn the_version_getters_agree_with_dilla_core_on_wasm() {
    assert_eq!(core_version(), dilla_core::CORE_VERSION);
    assert_eq!(u64::from(abi_version()), dilla_core::ABI_VERSION);
}
