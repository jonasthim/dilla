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

/// The verbs task 28 adds, against the stub: a bulk join batched by the creator, an explicit
/// commit, "everything since the last assertion decrypted", a frame assertion on the last actor,
/// and the stub's own clock.
#[test]
fn the_new_verbs_run_green_against_the_stub() {
    run(
        "new-verbs",
        "\
instance dilla
client owner
group chat kind=text target=66666666666666666666666666666666 creator=owner
join_many chat 3
sync owner
commit owner
send owner chat everyone is here
expect_decrypts_all chat-2
expect_frame message.ct
expect_decrypts_all chat-4
expect_frame mls.handshake kind=1
advance_clock 24h
send chat-3 chat back at you
expect_decrypts owner chat back at you
",
    );
}

/// `expect_decrypts_all` vouches for new messages only: a second one with nothing new fails.
#[test]
fn expect_decrypts_all_needs_something_new() {
    let src = "\
instance dilla
client alice
client bob
group chat kind=text target=77777777777777777777777777777777 creator=alice
join bob chat via=welcome
send alice chat once
expect_decrypts_all bob
expect_decrypts_all bob
";
    let scenario = parse(src, "twice").expect("parse");
    let report = Runner::new(0x5eed).run(&scenario).expect("run");
    assert!(!report.is_ok(), "{}", report.to_text());
    let last = report.steps.last().expect("a step");
    assert_eq!(last.line, 8, "{}", report.to_text());
    assert!(last.detail.contains("no message since"), "{}", last.detail);
}

/// A frame that never arrived fails the step and names what did arrive.
#[test]
fn expect_frame_fails_when_no_such_frame_arrived() {
    let src = "\
instance dilla
client alice
client bob
group chat kind=text target=88888888888888888888888888888888 creator=alice
join bob chat via=welcome
sync bob
expect_frame mls.commit_needed
";
    let report = Runner::new(0x5eed)
        .run(&parse(src, "no-frame").expect("parse"))
        .expect("run");
    assert!(!report.is_ok(), "{}", report.to_text());
    let last = report.steps.last().expect("a step");
    assert!(
        last.detail.contains("received no mls.commit_needed"),
        "{}",
        last.detail
    );
}

/// The verbs only the test host's control listener can answer fail loudly against the stub,
/// rather than passing vacuously.
#[test]
fn the_control_listener_verbs_are_refused_by_the_stub() {
    for verb in [
        "kick alice bob",
        "snapshot before",
        "restore_snapshot before",
        "expect_quarantined bob",
        "expect_closed chat",
    ] {
        let src = format!(
            "\
instance dilla
client alice
client bob
group chat kind=text target=99999999999999999999999999999999 creator=alice
{verb}
"
        );
        let report = Runner::new(0x5eed)
            .run(&parse(&src, verb).expect("parse"))
            .expect("run");
        assert!(!report.is_ok(), "{verb}: {}", report.to_text());
        let last = report.steps.last().expect("a step");
        assert!(
            last.detail.contains("testkit unsupported"),
            "{verb}: {}",
            last.detail
        );
    }
}

#[test]
fn the_vector_runner_is_green_from_the_testkit_too() {
    let report = dilla_core::vectors::run_all();
    assert!(report.is_ok(), "{}", report.to_text());
}
