//! The native leg of the cross-target conformance triangle. The other two are
//! `cargo test -p dilla-core --target wasm32-unknown-unknown` (task 16) and the Go wazero test
//! (Plan B task 4); all three drive this same module.

use dilla_core::cbor::decode_strict;
use dilla_core::vectors::{
    run_all, run_envelope, run_franking, run_identity, run_rejects, run_sframe,
};

#[test]
fn every_suite_passes() {
    let report = run_all();
    assert!(report.is_ok(), "{}", report.to_text());
    assert_eq!(report.failed, 0);
    assert!(report.passed > 0);
    assert_eq!(report.suites.len(), 5);
}

#[test]
fn each_suite_reports_the_expected_number_of_cases() {
    // 4 envelope cases x 3 fields; 3 franking cases x 1 field; 4 sframe cases x 6 fields;
    // 8 identity cases (5 identity fields, the credential CBOR, and the two credential signatures
    // checked separately - interfaces.md section 2.9); the reject corpus.
    assert_eq!(run_envelope().cases.len(), 12);
    assert_eq!(run_franking().cases.len(), 3);
    assert_eq!(run_sframe().cases.len(), 24);
    assert_eq!(run_identity().cases.len(), 8);
    // The reject suite is pinned exactly, not `>=`: 33 deterministic-CBOR corpus inputs, 3
    // envelope decode refusals, 2 body-limit refusals, every `rejects` entry of envelope.json
    // (1 today: the delete tombstone with a non-empty body), and the short `authenticated_data`.
    // A `>=` here would let a vector-file reject case silently stop being run.
    let rejects = run_rejects();
    assert_eq!(rejects.cases.len(), 40);
    assert!(
        rejects
            .cases
            .iter()
            .any(|c| c.case == "envelope reject: delete tombstone with a non-empty body"),
        "envelope.json's reject vectors must be driven by the runner"
    );
    for suite in [
        run_envelope(),
        run_franking(),
        run_sframe(),
        run_identity(),
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
        vec!["envelope", "franking", "sframe", "identity", "rejects"]
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
    for name in ["envelope", "franking", "sframe", "identity", "rejects"] {
        assert!(text.contains(name), "{text}");
    }
}
