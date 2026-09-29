use dilla_core::identity::{Kind, Tier};
use dilla_core::ids::CommunityId;
use dilla_core::mls::GroupKind;

#[derive(Clone, PartialEq, Eq, Debug)]
pub enum Stmt {
    Instance {
        name: String,
    },
    Client {
        name: String,
        tier: Tier,
        kind: Kind,
    },
    Sync {
        client: String,
    },
    Group {
        name: String,
        kind: GroupKind,
        target: [u8; 16],
        community: Option<CommunityId>,
        creator: String,
    },
    Join {
        client: String,
        group: String,
        external: bool,
    },
    Send {
        client: String,
        group: String,
        body: String,
    },
    ExpectDecrypts {
        client: String,
        group: String,
        body: String,
    },
    Remove {
        actor: String,
        group: String,
        target: String,
    },
    GoOffline {
        client: String,
    },
    GoOnline {
        client: String,
    },
    /// `expect_reject <code> <statement…>`, and `expect_425 <statement…>` with `status` set: the
    /// inner statement must fail with that code (and, when given, that HTTP status).
    ExpectReject {
        code: String,
        status: Option<u16>,
        inner: Box<Stmt>,
    },
    /// `ds <url>`: run against the instance at `url` through `HttpDs` instead of `DsStub`. Must
    /// precede the first `client` (NV-B2); the CLI's `--ds` overrides it.
    Ds {
        url: String,
    },
    /// `kick <actor> <target>`: the instance proposes the removal of every device of `target`'s
    /// from each group `target` is in, on `actor`'s authority (invariants 5 and 6).
    Kick {
        actor: String,
        target: String,
    },
    /// `advance_clock <duration>`: `30s`, `5m`, `24h` or `90d`.
    AdvanceClock {
        seconds: u64,
    },
    /// `expect_frame <op> [field=value …]`: the last client that acted has received a frame with
    /// that protocol/02 label whose named payload fields have those values.
    ExpectFrame {
        op: String,
        fields: Vec<(String, String)>,
    },
    Snapshot {
        name: String,
    },
    RestoreSnapshot {
        name: String,
    },
    /// `commit <actor>`: the actor commits for the current epoch of every group it is in.
    Commit {
        actor: String,
    },
    /// `join_many <group> <count>`: `count` new clients join `group`, at most 256 Adds a commit.
    JoinMany {
        group: String,
        count: usize,
    },
    /// `expect_decrypts_all <actor>`: every message the actor received since its last such
    /// assertion decrypts, and there is at least one.
    ExpectDecryptsAll {
        actor: String,
    },
    /// `expect_quarantined <actor>`: the test host reports the actor's device quarantined.
    ExpectQuarantined {
        actor: String,
    },
    /// `expect_closed <group>`: the test host reports the group closed.
    ExpectClosed {
        group: String,
    },
    /// `resync <client> <group>`: the client drops its copy of the group and returns by an
    /// own-leaf external commit (`POST /resync`, invariant 9 and R25).
    Resync {
        client: String,
        group: String,
    },
    /// `fork_report <client> <group>`: the client reports the last commit it received for the
    /// group as one it cannot process (`POST /fork-report`, invariant 9).
    ForkReport {
        client: String,
        group: String,
    },
    /// `heal <client> <group>`: the client uploads its GroupInfo and its handshake tail to a
    /// restored instance (`POST /heal`, invariant 11).
    Heal {
        client: String,
        group: String,
    },
    /// `ack_commit <client>`: the client acknowledges the last `mls.commit_needed` it received
    /// (the `commit_ack` frame, invariant 7) and then does nothing about it.
    AckCommit {
        client: String,
    },
    /// `admit <group> <client>`: the instance proposes adding the client's device to the group
    /// with a KeyPackage from the directory (invariant 6's Add).
    Admit {
        group: String,
        client: String,
    },
}

/// protocol/02's labels for the delivery-service frames a client receives, plus `error`.
const FRAME_LABELS: &[&str] = &[
    "mls.handshake",
    "mls.commit_needed",
    "mls.epoch_changed",
    "message.ct",
    "mls.welcome",
    "message.deleted",
    "error",
];

#[derive(Clone, PartialEq, Eq, Debug)]
pub struct Scenario {
    pub name: String,
    pub stmts: Vec<Stmt>,
    /// The source line each statement came from, parallel to `stmts`. The parser skips comments
    /// and blank lines, so a statement's index is **not** its line; every committed `.scn` file
    /// opens with a comment, and `StepResult::line` has to point at something a reader can find.
    pub lines: Vec<usize>,
}

#[derive(Clone, PartialEq, Eq, Debug, thiserror::Error)]
#[error("line {line}: {message}")]
pub struct ParseError {
    pub line: usize,
    pub message: String,
}

fn err(line: usize, message: impl Into<String>) -> ParseError {
    ParseError {
        line,
        message: message.into(),
    }
}

fn hex16(s: &str, line: usize) -> Result<[u8; 16], ParseError> {
    if s.len() != 32 {
        return Err(err(
            line,
            format!("expected 32 lowercase hex digits, got {s:?}"),
        ));
    }
    let mut out = [0u8; 16];
    for (i, b) in out.iter_mut().enumerate() {
        *b = u8::from_str_radix(&s[2 * i..2 * i + 2], 16)
            .map_err(|_| err(line, format!("not hex: {s:?}")))?;
    }
    Ok(out)
}

fn named<'a>(args: &[&'a str], key: &str) -> Option<&'a str> {
    args.iter().find_map(|a| a.strip_prefix(key))
}

/// `30s`, `5m`, `24h`, `90d`: a scenario never writes a bare number of seconds for a 90-day window.
fn duration_seconds(s: &str, line: usize) -> Result<u64, ParseError> {
    let bad = || {
        err(
            line,
            format!("expected a duration like 30s, 5m, 24h or 90d, got {s:?}"),
        )
    };
    let (digits, unit) = s.split_at(s.find(|c: char| !c.is_ascii_digit()).ok_or_else(bad)?);
    let n: u64 = digits.parse().map_err(|_| bad())?;
    let scale = match unit {
        "s" => 1,
        "m" => 60,
        "h" => 3_600,
        "d" => 86_400,
        _ => return Err(bad()),
    };
    n.checked_mul(scale).ok_or_else(bad)
}

fn op_name(s: &str, line: usize) -> Result<String, ParseError> {
    if FRAME_LABELS.contains(&s) {
        Ok(s.to_owned())
    } else {
        Err(err(
            line,
            format!("unknown frame {s:?}; expected one of {FRAME_LABELS:?}"),
        ))
    }
}

fn key_values(args: &[&str], line: usize) -> Result<Vec<(String, String)>, ParseError> {
    args.iter()
        .map(|a| match a.split_once('=') {
            Some((k, v)) if !k.is_empty() && !v.is_empty() => Ok((k.to_owned(), v.to_owned())),
            _ => Err(err(line, format!("expected field=value, got {a:?}"))),
        })
        .collect()
}

fn parse_stmt(line_no: usize, tokens: &[&str], rest: &str) -> Result<Stmt, ParseError> {
    let verb = tokens[0];
    let args = &tokens[1..];
    let need = |n: usize| -> Result<(), ParseError> {
        if args.len() < n {
            Err(err(line_no, format!("{verb} needs {n} argument(s)")))
        } else {
            Ok(())
        }
    };

    Ok(match verb {
        "instance" => {
            need(1)?;
            Stmt::Instance {
                name: args[0].to_owned(),
            }
        }
        "client" => {
            need(1)?;
            let tier = match named(args, "tier=") {
                None | Some("native") => Tier::Native,
                Some("browser") => Tier::Browser,
                Some(other) => return Err(err(line_no, format!("unknown tier {other:?}"))),
            };
            let kind = match named(args, "kind=") {
                None | Some("user") => Kind::User,
                Some("bot") => Kind::Bot,
                Some(other) => return Err(err(line_no, format!("unknown kind {other:?}"))),
            };
            Stmt::Client {
                name: args[0].to_owned(),
                tier,
                kind,
            }
        }
        "sync" => {
            need(1)?;
            Stmt::Sync {
                client: args[0].to_owned(),
            }
        }
        "group" => {
            need(1)?;
            let kind = match named(args, "kind=") {
                Some("text") => GroupKind::Text,
                Some("call") => GroupKind::Call,
                Some("pairing") => GroupKind::Pairing,
                Some("interaction") => GroupKind::Interaction,
                Some(other) => return Err(err(line_no, format!("unknown group kind {other:?}"))),
                None => return Err(err(line_no, "group needs kind=")),
            };
            let target = hex16(
                named(args, "target=").ok_or_else(|| err(line_no, "group needs target="))?,
                line_no,
            )?;
            let community = match named(args, "community=") {
                None | Some("none") => None,
                Some(hex) => Some(CommunityId::from_bytes(hex16(hex, line_no)?)),
            };
            let creator = named(args, "creator=")
                .ok_or_else(|| err(line_no, "group needs creator="))?
                .to_owned();
            Stmt::Group {
                name: args[0].to_owned(),
                kind,
                target,
                community,
                creator,
            }
        }
        "join" => {
            need(2)?;
            let external = matches!(named(args, "via="), Some("external"));
            if let Some(via) = named(args, "via=")
                && via != "welcome"
                && via != "external"
            {
                return Err(err(line_no, format!("unknown via= {via:?}")));
            }
            Stmt::Join {
                client: args[0].to_owned(),
                group: args[1].to_owned(),
                external,
            }
        }
        "external_join" => {
            need(2)?;
            Stmt::Join {
                client: args[0].to_owned(),
                group: args[1].to_owned(),
                external: true,
            }
        }
        "send" | "expect_decrypts" => {
            need(2)?;
            let body = rest.trim().to_owned();
            if body.is_empty() {
                return Err(err(line_no, format!("{verb} needs a body")));
            }
            if verb == "send" {
                Stmt::Send {
                    client: args[0].to_owned(),
                    group: args[1].to_owned(),
                    body,
                }
            } else {
                Stmt::ExpectDecrypts {
                    client: args[0].to_owned(),
                    group: args[1].to_owned(),
                    body,
                }
            }
        }
        "remove" => {
            need(3)?;
            Stmt::Remove {
                actor: args[0].to_owned(),
                group: args[1].to_owned(),
                target: args[2].to_owned(),
            }
        }
        "go_offline" => {
            need(1)?;
            Stmt::GoOffline {
                client: args[0].to_owned(),
            }
        }
        "go_online" => {
            need(1)?;
            Stmt::GoOnline {
                client: args[0].to_owned(),
            }
        }
        "expect_reject" => {
            need(2)?;
            let inner_tokens: Vec<&str> = tokens[2..].to_vec();
            // `rest` is the tail after the outer line's first three tokens
            // (`expect_reject <code> <inner verb>`). The inner statement's own free-text body
            // starts after *its* first three tokens, which is two tokens further along; skipping
            // only one would hand `send`/`expect_decrypts` a body with the group name glued to
            // the front.
            let inner_rest = rest_after(rest, 2);
            Stmt::ExpectReject {
                code: args[0].to_owned(),
                status: None,
                inner: Box::new(parse_inner(line_no, &inner_tokens, &inner_rest)?),
            }
        }
        // Sugar over `expect_reject E_COMMIT_REQUIRED <statement…>` that also pins the status:
        // invariant 5's freeze answers 425 Too Early.
        "expect_425" => {
            need(1)?;
            let inner_tokens: Vec<&str> = tokens[1..].to_vec();
            // The inner verb is one token earlier than under `expect_reject`, so its free-text
            // body starts one token after the outer line's `rest`.
            let inner_rest = rest_after(rest, 1);
            Stmt::ExpectReject {
                code: "E_COMMIT_REQUIRED".to_owned(),
                status: Some(425),
                inner: Box::new(parse_inner(line_no, &inner_tokens, &inner_rest)?),
            }
        }
        "ds" => {
            need(1)?;
            if !args[0].starts_with("http://") {
                return Err(err(
                    line_no,
                    format!(
                        "ds needs an http:// URL (the testkit speaks to loopback only), got {:?}",
                        args[0]
                    ),
                ));
            }
            Stmt::Ds {
                url: args[0].to_owned(),
            }
        }
        "kick" => {
            need(2)?;
            Stmt::Kick {
                actor: args[0].to_owned(),
                target: args[1].to_owned(),
            }
        }
        "advance_clock" => {
            need(1)?;
            Stmt::AdvanceClock {
                seconds: duration_seconds(args[0], line_no)?,
            }
        }
        "expect_frame" => {
            need(1)?;
            Stmt::ExpectFrame {
                op: op_name(args[0], line_no)?,
                fields: key_values(&args[1..], line_no)?,
            }
        }
        "snapshot" => {
            need(1)?;
            Stmt::Snapshot {
                name: args[0].to_owned(),
            }
        }
        "restore_snapshot" => {
            need(1)?;
            Stmt::RestoreSnapshot {
                name: args[0].to_owned(),
            }
        }
        // The five verbs task 29's scenarios use beyond the vocabulary above: a scenario has no
        // other way to commit without an implicit commit hiding inside `send`, to join in bulk, or
        // to assert on state only the test host can see.
        "commit" => {
            need(1)?;
            Stmt::Commit {
                actor: args[0].to_owned(),
            }
        }
        "join_many" => {
            need(2)?;
            let count = args[1]
                .parse::<usize>()
                .ok()
                .filter(|n| *n > 0)
                .ok_or_else(|| {
                    err(
                        line_no,
                        format!("join_many needs a positive count, got {:?}", args[1]),
                    )
                })?;
            Stmt::JoinMany {
                group: args[0].to_owned(),
                count,
            }
        }
        "expect_decrypts_all" => {
            need(1)?;
            Stmt::ExpectDecryptsAll {
                actor: args[0].to_owned(),
            }
        }
        "expect_quarantined" => {
            need(1)?;
            Stmt::ExpectQuarantined {
                actor: args[0].to_owned(),
            }
        }
        "expect_closed" => {
            need(1)?;
            Stmt::ExpectClosed {
                group: args[0].to_owned(),
            }
        }
        // Task 29's five: a scenario has no other way to resync, report a fork, heal, acknowledge
        // an election or have the instance propose an Add.
        "resync" | "fork_report" | "heal" => {
            need(2)?;
            let (client, group) = (args[0].to_owned(), args[1].to_owned());
            match verb {
                "resync" => Stmt::Resync { client, group },
                "fork_report" => Stmt::ForkReport { client, group },
                _ => Stmt::Heal { client, group },
            }
        }
        "ack_commit" => {
            need(1)?;
            Stmt::AckCommit {
                client: args[0].to_owned(),
            }
        }
        "admit" => {
            need(2)?;
            Stmt::Admit {
                group: args[0].to_owned(),
                client: args[1].to_owned(),
            }
        }
        other => return Err(err(line_no, format!("unknown statement {other:?}"))),
    })
}

/// The statement an `expect_reject` or `expect_425` wraps. `ds` is a directive, not something
/// that can fail, so it is refused here as it is anywhere after the first `client`.
fn parse_inner(line_no: usize, tokens: &[&str], rest: &str) -> Result<Stmt, ParseError> {
    if tokens.first() == Some(&"ds") {
        return Err(err(
            line_no,
            "`ds <url>` cannot be wrapped in an expectation",
        ));
    }
    parse_stmt(line_no, tokens, rest)
}

/// The tail of a line after `skip` further whitespace-separated tokens.
fn rest_after(rest: &str, skip: usize) -> String {
    let mut remaining = rest.trim_start();
    for _ in 0..skip {
        match remaining.find(char::is_whitespace) {
            Some(at) => remaining = remaining[at..].trim_start(),
            None => return String::new(),
        }
    }
    remaining.to_owned()
}

pub fn parse(src: &str, name: &str) -> Result<Scenario, ParseError> {
    let mut stmts = Vec::new();
    let mut lines = Vec::new();
    let mut saw_client = false;
    for (index, raw) in src.lines().enumerate() {
        let line_no = index + 1;
        let line = raw.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let tokens: Vec<&str> = line.split_whitespace().collect();
        // NV-B2: `ds` is an ordinary statement, but it selects the delivery service every client
        // is enrolled with, so it must come before the first one.
        if tokens[0] == "ds" && saw_client {
            return Err(err(line_no, "`ds <url>` must precede the first `client`"));
        }
        // Everything after the third token, used as the free-text body of send/expect_decrypts.
        let rest = rest_after(line, 3);
        let stmt = parse_stmt(line_no, &tokens, &rest)?;
        saw_client |= matches!(stmt, Stmt::Client { .. } | Stmt::JoinMany { .. });
        stmts.push(stmt);
        lines.push(line_no);
    }
    Ok(Scenario {
        name: name.to_owned(),
        stmts,
        lines,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_every_verb_of_the_grammar() {
        let src = "\
# a comment, and the blank line below is ignored

instance dilla
client alice tier=native kind=user
client bob tier=browser
group chat kind=text target=33333333333333333333333333333333 community=none creator=alice
join bob chat
join bob chat via=external
external_join bob chat
send alice chat On my way. Grab the wolf capes.
expect_decrypts bob chat On my way. Grab the wolf capes.
remove alice chat bob
go_offline bob
go_online bob
sync alice
expect_reject E_BINDING join bob chat
";
        let s = parse(src, "grammar").expect("parse");
        assert_eq!(s.name, "grammar");
        assert_eq!(s.stmts.len(), 14);
        assert_eq!(s.lines.len(), s.stmts.len());
        // The first statement is on source line 3: line 1 is a comment and line 2 is blank.
        assert_eq!(s.lines[0], 3);
        assert!(matches!(s.stmts[0], Stmt::Instance { .. }));
        assert!(matches!(
            &s.stmts[1],
            Stmt::Client {
                tier: Tier::Native,
                kind: Kind::User,
                ..
            }
        ));
        assert!(matches!(
            &s.stmts[2],
            Stmt::Client {
                tier: Tier::Browser,
                kind: Kind::User,
                ..
            }
        ));
        match &s.stmts[3] {
            Stmt::Group {
                name,
                kind,
                target,
                community,
                creator,
            } => {
                assert_eq!(name, "chat");
                assert_eq!(*kind, GroupKind::Text);
                assert_eq!(*target, [0x33; 16]);
                assert!(community.is_none());
                assert_eq!(creator, "alice");
            }
            other => panic!("{other:?}"),
        }
        assert!(matches!(
            &s.stmts[4],
            Stmt::Join {
                external: false,
                ..
            }
        ));
        assert!(matches!(&s.stmts[5], Stmt::Join { external: true, .. }));
        assert!(matches!(&s.stmts[6], Stmt::Join { external: true, .. }));
        match &s.stmts[7] {
            Stmt::Send { body, .. } => assert_eq!(body, "On my way. Grab the wolf capes."),
            other => panic!("{other:?}"),
        }
        assert!(matches!(&s.stmts[9], Stmt::Remove { .. }));
        assert!(matches!(&s.stmts[10], Stmt::GoOffline { .. }));
        assert!(matches!(&s.stmts[11], Stmt::GoOnline { .. }));
        assert!(matches!(&s.stmts[12], Stmt::Sync { .. }));
        match &s.stmts[13] {
            Stmt::ExpectReject {
                code,
                status,
                inner,
            } => {
                assert_eq!(code, "E_BINDING");
                assert_eq!(*status, None);
                assert!(matches!(**inner, Stmt::Join { .. }));
            }
            other => panic!("{other:?}"),
        }
    }

    fn one(line: &str) -> Result<Stmt, ParseError> {
        parse(line, "one").map(|s| s.stmts.into_iter().next().expect("one statement"))
    }

    fn refused(line: &str, needle: &str) {
        let e = one(line).expect_err(line);
        assert_eq!(e.line, 1, "{line}");
        assert!(e.message.contains(needle), "{line}: {}", e.message);
    }

    #[test]
    fn ds_selects_the_remote_delivery_service_before_the_first_client_only() {
        let s = parse(
            "ds http://127.0.0.1:4567\ninstance dilla\nclient alice\n",
            "ds",
        )
        .unwrap();
        assert_eq!(
            s.stmts[0],
            Stmt::Ds {
                url: "http://127.0.0.1:4567".into()
            }
        );
        let e = parse(
            "instance dilla\nclient alice\nds http://127.0.0.1:1\n",
            "late",
        )
        .unwrap_err();
        assert_eq!(e.line, 3);
        assert!(
            e.message.contains("precede the first `client`"),
            "{}",
            e.message
        );
        refused("ds https://dilla.example", "http://");
        refused("ds", "ds needs 1");
        refused(
            "expect_reject E_X ds http://127.0.0.1:1",
            "cannot be wrapped",
        );
    }

    #[test]
    fn kick_names_an_actor_and_a_target() {
        assert_eq!(
            one("kick alice bob").unwrap(),
            Stmt::Kick {
                actor: "alice".into(),
                target: "bob".into()
            }
        );
        refused("kick alice", "kick needs 2");
    }

    #[test]
    fn advance_clock_takes_a_duration_with_a_unit() {
        for (text, seconds) in [
            ("30s", 30),
            ("5m", 300),
            ("24h", 86_400),
            ("90d", 7_776_000),
        ] {
            assert_eq!(
                one(&format!("advance_clock {text}")).unwrap(),
                Stmt::AdvanceClock { seconds },
                "{text}"
            );
        }
        refused("advance_clock 90", "duration");
        refused("advance_clock 2w", "duration");
        refused("advance_clock h", "duration");
        refused("advance_clock", "advance_clock needs 1");
    }

    #[test]
    fn expect_frame_names_a_protocol_02_label_and_field_values() {
        assert_eq!(
            one("expect_frame mls.commit_needed epoch=3 round=1").unwrap(),
            Stmt::ExpectFrame {
                op: "mls.commit_needed".into(),
                fields: vec![("epoch".into(), "3".into()), ("round".into(), "1".into())],
            }
        );
        assert!(matches!(
            one("expect_frame message.ct").unwrap(),
            Stmt::ExpectFrame { fields, .. } if fields.is_empty()
        ));
        refused("expect_frame mls.nonsense", "unknown frame");
        refused("expect_frame mls.handshake epoch", "field=value");
    }

    #[test]
    fn expect_425_is_expect_reject_e_commit_required_at_status_425() {
        match one("expect_425 send alice chat hold on there").unwrap() {
            Stmt::ExpectReject {
                code,
                status,
                inner,
            } => {
                assert_eq!(code, "E_COMMIT_REQUIRED");
                assert_eq!(status, Some(425));
                assert_eq!(
                    *inner,
                    Stmt::Send {
                        client: "alice".into(),
                        group: "chat".into(),
                        body: "hold on there".into()
                    }
                );
            }
            other => panic!("{other:?}"),
        }
        refused("expect_425", "expect_425 needs 1");
    }

    #[test]
    fn snapshot_and_restore_snapshot_name_the_snapshot() {
        assert_eq!(
            one("snapshot before").unwrap(),
            Stmt::Snapshot {
                name: "before".into()
            }
        );
        assert_eq!(
            one("restore_snapshot before").unwrap(),
            Stmt::RestoreSnapshot {
                name: "before".into()
            }
        );
        refused("snapshot", "snapshot needs 1");
        refused("restore_snapshot", "restore_snapshot needs 1");
    }

    #[test]
    fn commit_names_its_actor() {
        assert_eq!(
            one("commit alice").unwrap(),
            Stmt::Commit {
                actor: "alice".into()
            }
        );
        refused("commit", "commit needs 1");
    }

    #[test]
    fn join_many_takes_a_group_and_a_positive_count() {
        assert_eq!(
            one("join_many chat 1000").unwrap(),
            Stmt::JoinMany {
                group: "chat".into(),
                count: 1000
            }
        );
        refused("join_many chat 0", "positive count");
        refused("join_many chat many", "positive count");
        refused("join_many chat", "join_many needs 2");
    }

    #[test]
    fn the_three_state_assertions_name_what_they_assert_on() {
        assert_eq!(
            one("expect_decrypts_all bob").unwrap(),
            Stmt::ExpectDecryptsAll {
                actor: "bob".into()
            }
        );
        assert_eq!(
            one("expect_quarantined bob").unwrap(),
            Stmt::ExpectQuarantined {
                actor: "bob".into()
            }
        );
        assert_eq!(
            one("expect_closed chat").unwrap(),
            Stmt::ExpectClosed {
                group: "chat".into()
            }
        );
        refused("expect_decrypts_all", "expect_decrypts_all needs 1");
        refused("expect_quarantined", "expect_quarantined needs 1");
        refused("expect_closed", "expect_closed needs 1");
    }

    /// The five member and instance actions task 29's chaos scenarios need beyond task 28's
    /// vocabulary: a resync (invariant 9, R25), a fork report (invariant 9), a heal (invariant 11),
    /// a commit_ack (invariant 7) and an instance-issued Add (invariant 6).
    #[test]
    fn the_member_and_instance_actions_name_who_acts_on_what() {
        assert_eq!(
            one("resync bob chat").unwrap(),
            Stmt::Resync {
                client: "bob".into(),
                group: "chat".into()
            }
        );
        assert_eq!(
            one("fork_report bob chat").unwrap(),
            Stmt::ForkReport {
                client: "bob".into(),
                group: "chat".into()
            }
        );
        assert_eq!(
            one("heal alice chat").unwrap(),
            Stmt::Heal {
                client: "alice".into(),
                group: "chat".into()
            }
        );
        assert_eq!(
            one("ack_commit alice").unwrap(),
            Stmt::AckCommit {
                client: "alice".into()
            }
        );
        assert_eq!(
            one("admit chat bob").unwrap(),
            Stmt::Admit {
                group: "chat".into(),
                client: "bob".into()
            }
        );
        refused("resync bob", "resync needs 2");
        refused("fork_report bob", "fork_report needs 2");
        refused("heal alice", "heal needs 2");
        refused("ack_commit", "ack_commit needs 1");
        refused("admit chat", "admit needs 2");
    }

    #[test]
    fn reports_the_line_number_of_a_syntax_error() {
        let err = parse("instance dilla\nclient alice\nnope alice\n", "bad").unwrap_err();
        assert_eq!(err.line, 3);
        assert!(err.message.contains("nope"), "{}", err.message);

        let err = parse("group chat kind=text\n", "bad").unwrap_err();
        assert_eq!(err.line, 1);

        let err = parse("client alice tier=quantum\n", "bad").unwrap_err();
        assert_eq!(err.line, 1);
        assert!(err.message.contains("tier"), "{}", err.message);

        let err = parse("group chat kind=text target=zz creator=alice\n", "bad").unwrap_err();
        assert_eq!(err.line, 1);
    }

    /// The inner statement of an `expect_reject` keeps its own free-text body: the tail is taken
    /// after the inner verb's three tokens, not the outer line's.
    #[test]
    fn expect_reject_hands_the_inner_statement_its_own_body() {
        let s = parse(
            "expect_reject E_BINDING send alice chat hello there\n",
            "inner",
        )
        .expect("parse");
        match &s.stmts[0] {
            Stmt::ExpectReject { inner, .. } => match &**inner {
                Stmt::Send {
                    client,
                    group,
                    body,
                } => {
                    assert_eq!(client, "alice");
                    assert_eq!(group, "chat");
                    assert_eq!(body, "hello there");
                }
                other => panic!("{other:?}"),
            },
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn every_committed_scenario_parses() {
        for (file, src) in [
            (
                "two-client-text.scn",
                include_str!("../../scenarios/two-client-text.scn"),
            ),
            (
                "external-join.scn",
                include_str!("../../scenarios/external-join.scn"),
            ),
            (
                "commit-conflict.scn",
                include_str!("../../scenarios/commit-conflict.scn"),
            ),
            (
                "concurrent_commits_5.scn",
                include_str!("../../scenarios/concurrent_commits_5.scn"),
            ),
            (
                "kick_while_offline_then_join.scn",
                include_str!("../../scenarios/kick_while_offline_then_join.scn"),
            ),
            (
                "external_commit_during_freeze_online.scn",
                include_str!("../../scenarios/external_commit_during_freeze_online.scn"),
            ),
            (
                "external_commit_during_freeze_offline.scn",
                include_str!("../../scenarios/external_commit_during_freeze_offline.scn"),
            ),
            (
                "expired_keypackage_void.scn",
                include_str!("../../scenarios/expired_keypackage_void.scn"),
            ),
            (
                "remove_gone_leaf.scn",
                include_str!("../../scenarios/remove_gone_leaf.scn"),
            ),
            (
                "malformed_commit_fork_report.scn",
                include_str!("../../scenarios/malformed_commit_fork_report.scn"),
            ),
            (
                "resync_to_head.scn",
                include_str!("../../scenarios/resync_to_head.scn"),
            ),
            (
                "watchdog_three_lost_rounds.scn",
                include_str!("../../scenarios/watchdog_three_lost_rounds.scn"),
            ),
            (
                "restore_heal_from_tail.scn",
                include_str!("../../scenarios/restore_heal_from_tail.scn"),
            ),
            (
                "restore_force_recreate.scn",
                include_str!("../../scenarios/restore_force_recreate.scn"),
            ),
            (
                "inactivity_remove_90d.scn",
                include_str!("../../scenarios/inactivity_remove_90d.scn"),
            ),
            (
                "join_storm_256_batched.scn",
                include_str!("../../scenarios/join_storm_256_batched.scn"),
            ),
            (
                "resume_always_refused.scn",
                include_str!("../../scenarios/resume_always_refused.scn"),
            ),
            (
                "retention_prune_then_resync.scn",
                include_str!("../../scenarios/retention_prune_then_resync.scn"),
            ),
        ] {
            parse(src, file).unwrap_or_else(|e| panic!("{file}:{}: {}", e.line, e.message));
        }
    }
}
