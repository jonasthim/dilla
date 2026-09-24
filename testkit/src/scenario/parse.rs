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
    ExpectReject {
        code: String,
        inner: Box<Stmt>,
    },
}

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
                inner: Box::new(parse_stmt(line_no, &inner_tokens, &inner_rest)?),
            }
        }
        other => return Err(err(line_no, format!("unknown statement {other:?}"))),
    })
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
    for (index, raw) in src.lines().enumerate() {
        let line_no = index + 1;
        let line = raw.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let tokens: Vec<&str> = line.split_whitespace().collect();
        // Everything after the third token, used as the free-text body of send/expect_decrypts.
        let rest = rest_after(line, 3);
        stmts.push(parse_stmt(line_no, &tokens, &rest)?);
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
            Stmt::ExpectReject { code, inner } => {
                assert_eq!(code, "E_BINDING");
                assert!(matches!(**inner, Stmt::Join { .. }));
            }
            other => panic!("{other:?}"),
        }
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
        ] {
            parse(src, file).unwrap_or_else(|e| panic!("{file}:{}: {}", e.line, e.message));
        }
    }
}
