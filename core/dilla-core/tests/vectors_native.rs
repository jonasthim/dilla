//! The native leg of the cross-target conformance triangle. The other two are
//! `cargo test -p dilla-core --target wasm32-unknown-unknown` (task 16) and the Go wazero test
//! (Plan B task 4); all three drive this same module.

use dilla_core::cbor::decode_strict;
use dilla_core::vectors::{
    run_all, run_envelope, run_frames, run_franking, run_identity, run_rejects, run_sframe,
};

#[test]
fn every_suite_passes() {
    let report = run_all();
    assert!(report.is_ok(), "{}", report.to_text());
    assert_eq!(report.failed, 0);
    assert!(report.passed > 0);
    assert_eq!(report.suites.len(), 6);
}

#[test]
fn each_suite_reports_the_expected_number_of_cases() {
    // 4 envelope cases x 3 fields; the franking file's own `envelope_cbor` -> commitment, plus
    // 3 franking cases x 1 field; sframe: 4 key-schedule cases x 6 fields, 34 RFC 9605 C.1 headers
    // x 2, the C.3 frame x 5, 10 media frames x 3, 8 escapes x 2 and the 30 `decrypt` steps of the
    // 10 `receiver` scripts (24 + 68 + 5 + 30 + 16 + 30 = 173; CRYPTO-2 added 6 H.264 frames and
    // the scripts); 8 identity cases (5 identity fields,
    // the credential CBOR, and the two credential signatures checked separately - interfaces.md
    // section 2.9); the reject corpus.
    assert_eq!(run_envelope().cases.len(), 12);
    assert_eq!(run_franking().cases.len(), 4);
    assert_eq!(run_sframe().cases.len(), 173);
    assert_eq!(run_identity().cases.len(), 8);
    // The gateway frame corpus: one case per opcode of protocol/02's catalogue plus the second
    // `mls.handshake` (instance-sent, `sender = null`), checked as one `frame` field each. Pinned
    // exactly, for the same reason the reject suite is.
    assert_eq!(run_frames().cases.len(), 25);
    // The reject suite is pinned exactly, not `>=`: 33 deterministic-CBOR corpus inputs, 3
    // envelope decode refusals, 2 body-limit refusals, every `rejects` entry of envelope.json
    // (9 today: interfaces.md §2.8's tightened per-field limits, one case per bound plus the
    // pre-existing delete tombstone with a non-empty body), the short `authenticated_data`, and
    // sframe.json's 37 `rejects` (13 non-minimal or truncated headers, 3 headers with a KID of
    // 2^24 or more, 5 AEAD, 1 codec prefix, 1 frame sealed under a non-canonical KID, and
    // CRYPTO-2's 14 H.264 prefix refusals) and its 6 `sender_rejects`.
    // A `>=` here would let a vector-file reject case silently stop being run.
    let rejects = run_rejects();
    assert_eq!(rejects.cases.len(), 91);
    for (name, code) in [
        (
            "sframe sender reject: h264 sps a libwebrtc receiver would rewrite",
            "E_SFRAME_NON_CANONICAL_SPS",
        ),
        (
            "sframe sender reject: sequence number 2^52",
            "E_SFRAME_COUNTER_EXHAUSTED",
        ),
        (
            "sframe reject: h264 pic_parameter_set_id 256",
            "E_SFRAME_MALFORMED_PREFIX",
        ),
    ] {
        assert!(
            rejects
                .cases
                .iter()
                .any(|c| c.case == name && c.actual == code),
            "{name} must be refused with {code}"
        );
    }
    let sframe = run_sframe();
    assert!(
        sframe.cases.iter().any(
            |c| c.case == "receiver a member the newest epoch removed step 2"
                && c.actual == "E_SFRAME_SENDER_MISMATCH"
        ),
        "sframe.json's receiver scripts must be driven by the runner"
    );
    for name in [
        "sframe reject: non-canonical kid 2^24",
        "sframe reject: non-canonical kid: leaf 1 epoch 41 with bit 24 set",
        "sframe reject: non-canonical kid 2^64 - 1",
        "sframe reject: opus frame sealed under a non-canonical kid",
    ] {
        assert!(
            rejects
                .cases
                .iter()
                .any(|c| c.case == name && c.actual == "E_SFRAME_NON_CANONICAL_KID"),
            "{name} must be refused as non-canonical"
        );
    }
    assert!(
        rejects
            .cases
            .iter()
            .any(|c| c.case == "envelope reject: delete tombstone with a non-empty body"),
        "envelope.json's reject vectors must be driven by the runner"
    );
    assert!(
        rejects
            .cases
            .iter()
            .any(|c| c.case == "sframe reject: prefix byte changed" && c.actual == "E_SFRAME_AUTH"),
        "sframe.json's reject vectors must be driven by the runner"
    );
    for suite in [
        run_envelope(),
        run_franking(),
        run_sframe(),
        run_identity(),
        run_frames(),
        run_rejects(),
    ] {
        for case in &suite.cases {
            assert!(
                case.ok,
                "{}: {} expected {} got {}",
                suite.name, case.case, case.expected, case.actual
            );
        }
    }
}

#[test]
fn the_report_encodes_as_deterministic_cbor_and_decodes_back() {
    let report = run_all();
    let bytes = report.encode();
    let decoded = decode_strict(&bytes, |d| {
        d.array(3)?;
        let passed = d.uint()?;
        let failed = d.uint()?;
        let suites = d.array_len()?;
        let mut names = Vec::with_capacity(suites);
        for _ in 0..suites {
            d.array(2)?;
            names.push(d.text()?.to_owned());
            let cases = d.array_len()?;
            for _ in 0..cases {
                d.array(5)?;
                let _case = d.text()?;
                let _field = d.text()?;
                let ok = d.uint()?;
                assert!(ok <= 1, "ok is encoded as 0 or 1");
                let _expected = d.text()?;
                let _actual = d.text()?;
            }
        }
        Ok((passed, failed, names))
    })
    .expect("the report must be strict deterministic CBOR");

    assert_eq!(decoded.0, u64::from(report.passed));
    assert_eq!(decoded.1, u64::from(report.failed));
    assert_eq!(
        decoded.2,
        vec![
            "envelope", "franking", "sframe", "identity", "frames", "rejects"
        ]
    );
}

#[test]
fn a_corrupted_case_makes_the_report_fail() {
    let mut report = run_all();
    assert!(report.is_ok());
    report.suites[0].cases[0].ok = false;
    report.failed += 1;
    report.passed -= 1;
    assert!(!report.is_ok());
    assert!(report.to_text().contains("FAIL"));
}

#[test]
fn to_text_names_every_suite() {
    let text = run_all().to_text();
    for name in [
        "envelope", "franking", "sframe", "identity", "frames", "rejects",
    ] {
        assert!(text.contains(name), "{text}");
    }
}
