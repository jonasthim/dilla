//! The three committed scenarios, end to end, against the in-memory delivery service.

use dilla_testkit::{Runner, parse};

fn run(name: &str, src: &str) {
    let scenario = parse(src, name).unwrap_or_else(|e| panic!("{name}:{}: {}", e.line, e.message));
    let mut runner = Runner::new(0x5eed);
    let report = runner
        .run(&scenario)
        .unwrap_or_else(|e| panic!("{name}: {e}"));
    assert!(report.is_ok(), "{name}:\n{}", report.to_text());
}

#[test]
fn two_client_text_runs_green() {
    run(
        "two-client-text",
        include_str!("../scenarios/two-client-text.scn"),
    );
}

#[test]
fn external_join_runs_green() {
    run(
        "external-join",
        include_str!("../scenarios/external-join.scn"),
    );
}

#[test]
fn commit_conflict_runs_green() {
    run(
        "commit-conflict",
        include_str!("../scenarios/commit-conflict.scn"),
    );
}

/// `expect_reject` passes only when the inner statement fails with that exact code. A scenario
/// whose inner statement *succeeds* must fail the run, not pass it silently.
#[test]
fn expect_reject_fails_when_the_inner_statement_succeeds() {
    let src = "\
instance dilla
client alice
group chat kind=text target=33333333333333333333333333333333 creator=alice
expect_reject E_BINDING send alice chat hello
";
    let scenario = parse(src, "inverted").expect("parse");
    let mut runner = Runner::new(0x5eed);
    let report = runner.run(&scenario).expect("run");
    assert!(
        !report.is_ok(),
        "an inner statement that succeeded must fail the run"
    );
    assert!(
        report.to_text().contains("E_BINDING"),
        "{}",
        report.to_text()
    );
}

#[test]
fn the_vector_runner_is_green_from_the_testkit_too() {
    let report = dilla_core::vectors::run_all();
    assert!(report.is_ok(), "{}", report.to_text());
}
