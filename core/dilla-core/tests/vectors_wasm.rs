// wasm32 only, and only with the `vectors` feature that compiles `dilla_core::vectors` at all.
// On every other target this file is empty, which is why the crate-level attribute is `cfg` and
// not a per-test one: `use wasm_bindgen_test::*` must disappear with the tests, since the crate is
// a wasm32-only dev-dependency.
#![cfg(all(target_arch = "wasm32", feature = "vectors"))]

//! The wasm32-unknown-unknown leg of the cross-target conformance triangle, run by the CI step
//! `cargo test -p dilla-core --target wasm32-unknown-unknown --locked --features vectors`.
//!
//! That step existed before this file did and reported "no tests to run!" for every binary: an
//! ordinary `#[test]` is not collected by `wasm-bindgen-test-runner`, so the gate compiled the
//! crate for wasm32 and then asserted nothing about it. `dilla-core-wasm`'s `tests/node.rs` covers
//! the same suites, but only through the `wasm-bindgen` surface of a *different* crate; nothing
//! ran `dilla_core::vectors` on wasm32 from `dilla-core`'s own test target, which is what the
//! vectors_native / vectors_wasm / wazero triangle is supposed to be.
//!
//! `run_in_node_experimental` rather than a browser mode: the box has no chromedriver, and
//! wasm-bindgen-test's headless path speaks WebDriver (facts/gap-30-ci.md section 1.1 lists this
//! option verbatim from the 0.3.78 docs, and `.cargo/config.toml` already sets
//! `runner = "wasm-bindgen-test-runner"` for this target). The suites are pure computation over
//! `include_str!`-embedded vector files: no DOM, no storage, no crypto intrinsics beyond what
//! `dilla-core` itself uses, so Node is the honest environment for them.

use dilla_core::vectors::run_all;
use wasm_bindgen_test::*;

wasm_bindgen_test_configure!(run_in_node_experimental);

/// The seven suites, in the order `run_all()` builds them (Plan B task 17 added `"frames"`; web-2b
/// task 1 added `"attachment"`). Same
/// golden as `core/dilla-core-wasm/tests/node.rs`: a suite silently dropped from `run_all()` would
/// otherwise leave a green report that checks less than it used to.
const EXPECTED_SUITES: [&str; 7] = [
    "envelope",
    "franking",
    "sframe",
    "identity",
    "frames",
    "attachment",
    "rejects",
];

#[wasm_bindgen_test]
fn every_vector_suite_passes_on_wasm32() {
    let report = run_all();

    let names: Vec<&str> = report.suites.iter().map(|s| s.name).collect();
    assert_eq!(
        names, EXPECTED_SUITES,
        "the wasm32 build must run all seven suites, in order"
    );

    // Named per failing field, not just `failed == 0`: on a target with no `std::fs` and no
    // panic hook worth reading, the assertion message is the whole diagnostic.
    for suite in &report.suites {
        assert!(!suite.cases.is_empty(), "suite {} has no cases", suite.name);
        for case in &suite.cases {
            assert!(
                case.ok,
                "{}: {} / {} expected {} got {}",
                suite.name, case.case, case.field, case.expected, case.actual
            );
        }
    }

    assert_eq!(report.failed, 0, "{}", report.to_text());
    assert!(report.passed > 0, "an empty report is not a passing one");
    assert!(report.is_ok());

    // Every `CaseReport` is one (case, field) check, so the two counters and the case rows must
    // agree. A suite dropped between `run_all()` and the counters survives the name check above
    // only if this also holds.
    let counted: usize = report.suites.iter().map(|s| s.cases.len()).sum();
    assert_eq!(counted, (report.passed + report.failed) as usize);
}

/// The report has to survive the ABI it crosses on this target, so the CBOR encoding is exercised
/// here too rather than only natively: `tests/vectors_native.rs` decodes it back on the host, and
/// a wasm32 divergence in the encoder would otherwise surface first in the browser tier.
#[wasm_bindgen_test]
fn the_report_encodes_on_wasm32() {
    let bytes = run_all().encode();
    assert!(!bytes.is_empty());
    // A definite-length 3-element array head: [passed, failed, suites].
    assert_eq!(bytes[0], 0x83, "the report is a 3-element CBOR array");
}
