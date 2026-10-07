// Native only: every test opens an in-memory SQLite connection.
#![cfg(not(target_arch = "wasm32"))]

//! web-2b task 2 (L-CORE-33…35, L-CORE-39): envelope types 1..6 fold onto their targets in the
//! apply unit; the timeline shows displayable rows only, with the folded body, the reply
//! reference, reactions per user, the pin flag and attachment summaries; pins, own roles and role
//! mentions. Every peer row is a real MLS application message from a `RawPeer`.

mod client_support;

use client_support::*;
use dilla_core::client::{ClientCore, ClientError, mentions_me_with_roles};
use dilla_core::envelope::Attachment;
use dilla_core::envelope::EnvelopeType::{
    self, Delete, Edit, Message, Pin, ReactionAdd, ReactionRemove, Unpin,
};

const PEER_USER: [u8; 16] = [0xe5; 16];
const READER_USER: [u8; 16] = [0xd4; 16];
const TARGET: [u8; 16] = [0x71; 16];
const UNHELD: [u8; 16] = [0xee; 16];
const ROLE: [u8; 16] = [0x3c; 16];
const OTHER_ROLE: [u8; 16] = [0x3d; 16];

/// "me" (alice, 0xa1) created and registered GROUP; the raw peer (user 0xe5, device 0xe6) joined
/// by external commit at seq 1; me applied it (next_seq 2). The parity start of L-CORE-10.
fn fold_start() -> (Instance, Relay, Core, RawPeer) {
    let instance = Instance::generate();
    let mut relay = Relay::new(GROUP);
    let mut me = ready_core(0xa1, "alice");
    me.create_and_register(&mut relay, &instance);
    let mut peer = RawPeer::new(0xe5, 0xe6);
    assert_eq!(
        peer.join_external(&mut relay),
        1,
        "the peer's external commit is seq 1"
    );
    me.sync(&relay);
    (instance, relay, me, peer)
}

/// Another member joins by external commit; the raw members already in merge it; me syncs.
fn join(
    relay: &mut Relay,
    me: &mut Core,
    members: &mut [&mut RawPeer],
    user: u8,
    device: u8,
) -> RawPeer {
    let mut joiner = RawPeer::new(user, device);
    let seq = joiner.join_external(relay);
    for m in members.iter_mut() {
        m.apply_commit(relay, seq);
    }
    me.sync(relay);
    joiner
}

/// One envelope from `peer` with msg id 16 × `msg`; answers its seq.
fn post(
    peer: &mut RawPeer,
    relay: &mut Relay,
    msg: u8,
    kind: EnvelopeType,
    reply_to: Option<[u8; 16]>,
    body: &str,
) -> u64 {
    peer.send_envelope(relay, &fold_envelope([msg; 16], kind, reply_to, body))
}

fn row_at(me: &Core, seq: u64) -> TimelineRow {
    me.timeline(&GROUP)
        .into_iter()
        .find(|r| r.seq == seq)
        .unwrap_or_else(|| panic!("no displayable row at seq {seq}"))
}

fn seqs(me: &Core) -> Vec<u64> {
    me.timeline(&GROUP).into_iter().map(|r| r.seq).collect()
}

fn chips(me: &Core, seq: u64) -> Vec<(String, u64, u64)> {
    row_at(me, seq).reactions
}

fn chip(emoji: &str, count: u64, mine: u64) -> (String, u64, u64) {
    (emoji.to_owned(), count, mine)
}

fn page(me: &Core, before: u64, limit: u32) -> Vec<u64> {
    decode_timeline(&me.core.timeline(&GROUP, before, limit).expect("timeline"))
        .into_iter()
        .map(|r| r.seq)
        .collect()
}

fn count(me: &Core, sql: &str) -> i64 {
    me.probe
        .lock()
        .expect("lock")
        .query_row(sql, [], |r| r.get(0))
        .expect("count")
}

fn pins(me: &Core) -> Vec<PinRow> {
    decode_pins(&me.core.pins(&GROUP).expect("pins"))
}

// ---------------------------------------------------------------------------------------------
// L-CORE-39: the fold parity fixture against the real core.

/// Builds one fold-fixture row; answers its seq. `target` is set by `peer-target`/`own-target`;
/// row `i` of a case carries msg id 16 × (0xa0 + i).
fn build_fold_row(
    what: &str,
    i: usize,
    relay: &mut Relay,
    me: &mut Core,
    peer: &mut RawPeer,
    target: &mut [u8; 16],
) -> u64 {
    let own = 0xa0 + i as u8;
    match what {
        "peer-target" => {
            *target = TARGET;
            post(peer, relay, 0x71, Message, None, "the target")
        }
        "own-target" => {
            let msg_id = me.prepare(&GROUP, "my target", NOW);
            *target = msg_id;
            let (_, body) = me.encrypt(&msg_id);
            seq_of_answer(&relay.post_message(me.device, &body).expect("upload"))
        }
        "peer-edit" => post(peer, relay, own, Edit, Some(*target), "edited by the peer"),
        "peer-react" => post(peer, relay, own, ReactionAdd, Some(*target), "👍"),
        "peer-unreact" => post(peer, relay, own, ReactionRemove, Some(*target), "👍"),
        "peer-delete" => post(peer, relay, own, Delete, Some(*target), ""),
        "peer-pin" => post(peer, relay, own, Pin, Some(*target), ""),
        "peer-react-unheld" => post(peer, relay, own, ReactionAdd, Some(UNHELD), "👍"),
        other => panic!("unknown row kind {other}"),
    }
}

#[test]
fn the_fold_parity_fixture_holds() {
    let fixture: serde_json::Value =
        serde_json::from_str(include_str!("fixtures/fold_parity.json")).expect("fixture JSON");
    assert_eq!(fixture["v"].as_u64(), Some(1));
    let cases = fixture["cases"].as_array().expect("cases");
    assert_eq!(
        cases.len(),
        6,
        "cases 1-6 of L-CORE-39 (task 3 appends the seventh)"
    );
    for case in cases {
        let name = case["name"].as_str().expect("name");
        let (_instance, mut relay, mut me, mut peer) = fold_start();
        let mut target = [0u8; 16];
        for (i, row) in case["rows"].as_array().expect("rows").iter().enumerate() {
            let what = row["what"].as_str().expect("what");
            let seq = row["seq"].as_u64().expect("seq");
            assert_eq!(
                build_fold_row(what, i, &mut relay, &mut me, &mut peer, &mut target),
                seq,
                "case {name}: {what} lands at seq {seq}"
            );
        }
        let through = case["through"].as_u64().expect("through");
        me.core
            .group_apply(
                &GROUP,
                &relay.handshakes_from(2),
                &relay.messages_from(2),
                through,
            )
            .expect("group_apply");
        let rows = me.timeline(&GROUP);
        for v in case["view"].as_array().expect("view") {
            let v = v.as_array().expect("a view entry");
            let seq = v[0].as_u64().expect("seq");
            let row = rows
                .iter()
                .find(|r| r.seq == seq)
                .unwrap_or_else(|| panic!("case {name}: no row at seq {seq}"));
            let reactions: Vec<(String, u64, u64)> = v[4]
                .as_array()
                .expect("reactions")
                .iter()
                .map(|r| {
                    (
                        r[0].as_str().expect("emoji").to_owned(),
                        r[1].as_u64().expect("count"),
                        r[2].as_u64().expect("mine"),
                    )
                })
                .collect();
            assert_eq!(
                (
                    row.status,
                    row.body.as_str(),
                    row.edited_seq,
                    row.reactions.clone(),
                    row.pinned
                ),
                (
                    v[1].as_u64().expect("status"),
                    v[2].as_str().expect("body"),
                    v[3].as_u64().expect("edited_seq"),
                    reactions,
                    v[5].as_u64().expect("pinned")
                ),
                "case {name}: the row at seq {seq}"
            );
        }
        for h in case["hidden"].as_array().expect("hidden") {
            let seq = h.as_u64().expect("seq");
            assert!(
                rows.iter().all(|r| r.seq != seq),
                "case {name}: seq {seq} is hidden"
            );
        }
    }
}

// ---------------------------------------------------------------------------------------------
// L-CORE-34: the view.

#[test]
fn fold_rows_are_hidden_and_take_no_page_slot() {
    let (_i, mut relay, mut me, mut peer) = fold_start();
    assert_eq!(
        post(&mut peer, &mut relay, 0x71, Message, None, "the target"),
        2
    );
    assert_eq!(
        post(&mut peer, &mut relay, 0xa1, ReactionAdd, Some(TARGET), "👍"),
        3
    );
    assert_eq!(
        post(&mut peer, &mut relay, 0xa2, ReactionAdd, Some(TARGET), "🎉"),
        4
    );
    assert_eq!(post(&mut peer, &mut relay, 0xa3, Pin, Some(TARGET), ""), 5);
    assert_eq!(
        post(
            &mut peer,
            &mut relay,
            0x72,
            Message,
            None,
            "after the folds"
        ),
        6
    );
    me.sync(&relay);
    assert_eq!(
        page(&me, 0, 200),
        vec![2, 6],
        "only type-0 rows are displayable"
    );
    assert_eq!(
        page(&me, 0, 2),
        vec![2, 6],
        "the three fold rows between them take no slot"
    );
    assert_eq!(page(&me, 6, 1), vec![2]);
    assert_eq!(
        count(
            &me,
            "SELECT count(*) FROM app_messages WHERE type IN (3, 5)"
        ),
        3,
        "fold rows are stored"
    );
    // A row of NULL type (cannot read) stays displayable.
    let epoch = relay.epoch();
    let pruned = seq_of_answer(&relay.push_message(peer.device, epoch, None, false));
    me.sync(&relay);
    assert_eq!(page(&me, 0, 200), vec![2, 6, pruned]);
    assert_eq!(row_at(&me, pruned).status, 1);
}

/// L-CORE-33 step 3: the author is a user. Mutation: compare `sender_device` → red here.
#[test]
fn an_edit_from_the_authors_other_device_applies_and_the_highest_seq_wins() {
    let (_i, mut relay, mut me, mut peer) = fold_start();
    let mut twin = join(&mut relay, &mut me, &mut [&mut peer], 0xe5, 0xe7);
    assert_eq!(
        post(&mut peer, &mut relay, 0x71, Message, None, "the target"),
        3
    );
    assert_eq!(
        post(
            &mut twin,
            &mut relay,
            0xa1,
            Edit,
            Some(TARGET),
            "edited on the other device"
        ),
        4
    );
    me.sync(&relay);
    let row = row_at(&me, 3);
    assert_eq!(
        (row.body.as_str(), row.edited_seq),
        ("edited on the other device", 4)
    );
    assert_eq!(
        post(
            &mut peer,
            &mut relay,
            0xa2,
            Edit,
            Some(TARGET),
            "edited again"
        ),
        5
    );
    me.sync(&relay);
    let row = row_at(&me, 3);
    assert_eq!((row.body.as_str(), row.edited_seq), ("edited again", 5));
    assert_eq!(seqs(&me), vec![3]);
    // Ruling 4: an edit never raises a mention.
    let mention = format!("now <@{}>", "a1".repeat(16));
    assert_eq!(
        post(&mut peer, &mut relay, 0xa3, Edit, Some(TARGET), &mention),
        6
    );
    me.sync(&relay);
    assert_eq!((row_at(&me, 3).body, row_at(&me, 3).mention), (mention, 0));
    assert_eq!(
        count(&me, "SELECT count(*) FROM app_messages WHERE mention = 1"),
        0
    );
}

/// Attacker statement (L-CORE-33): an edit or a delete from anyone but the target's author
/// changes nothing; steps 2-3 compare the MLS-authenticated `sender_user`. Mutation: drop the
/// author comparison of step 2 → red here.
#[test]
fn a_delete_or_an_edit_by_another_user_is_ignored() {
    let (_i, mut relay, mut me, mut peer) = fold_start();
    let mut mallory = join(&mut relay, &mut me, &mut [&mut peer], 0xd4, 0xd5);
    assert_eq!(
        post(&mut peer, &mut relay, 0x71, Message, None, "the target"),
        3
    );
    assert_eq!(
        post(
            &mut mallory,
            &mut relay,
            0xa1,
            Edit,
            Some(TARGET),
            "hijacked"
        ),
        4
    );
    assert_eq!(
        post(&mut mallory, &mut relay, 0xa2, Delete, Some(TARGET), ""),
        5
    );
    assert_eq!(
        post(
            &mut peer,
            &mut relay,
            0x72,
            Message,
            None,
            "the positive control"
        ),
        6
    );
    me.sync(&relay);
    assert_eq!(seqs(&me), vec![3, 6]);
    let row = row_at(&me, 3);
    assert_eq!(
        (row.status, row.body.as_str(), row.edited_seq),
        (0, "the target", 0)
    );
    assert_eq!(
        count(
            &me,
            "SELECT count(*) FROM app_messages WHERE seq = 4 AND status = 0 AND body = 'hijacked'"
        ),
        1,
        "the ignored edit is stored as received"
    );
}

#[test]
fn a_delete_by_the_author_removes_the_target_its_edits_reactions_and_pin() {
    let (_i, mut relay, mut me, mut peer) = fold_start();
    assert_eq!(
        post(&mut peer, &mut relay, 0x71, Message, None, "the target"),
        2
    );
    assert_eq!(
        post(&mut peer, &mut relay, 0xa1, ReactionAdd, Some(TARGET), "👍"),
        3
    );
    assert_eq!(
        post(&mut peer, &mut relay, 0xa2, Edit, Some(TARGET), "edited"),
        4
    );
    assert_eq!(post(&mut peer, &mut relay, 0xa3, Pin, Some(TARGET), ""), 5);
    me.sync(&relay);
    let row = row_at(&me, 2);
    assert_eq!(
        (
            row.body.as_str(),
            row.edited_seq,
            row.reactions.len(),
            row.pinned
        ),
        ("edited", 4, 1, 1)
    );
    assert_eq!(
        post(&mut peer, &mut relay, 0xa4, Delete, Some(TARGET), ""),
        6
    );
    assert_eq!(
        post(&mut peer, &mut relay, 0xa5, ReactionAdd, Some(TARGET), "🎉"),
        7
    );
    me.sync(&relay);
    let row = row_at(&me, 2);
    assert_eq!(
        (
            row.status,
            row.body.as_str(),
            row.edited_seq,
            row.reactions.clone(),
            row.pinned,
            row.attachments.clone()
        ),
        (2, "", 0, vec![], 0, vec![])
    );
    assert_eq!(seqs(&me), vec![2]);
    assert!(pins(&me).is_empty());
    assert_eq!(
        count(
            &me,
            "SELECT count(*) FROM app_messages WHERE seq IN (2, 4) AND envelope IS NULL AND body = ''"
        ),
        2,
        "the target and its edit lose their words"
    );
    assert_eq!(count(&me, "SELECT count(*) FROM app_reactions"), 0);
    assert_eq!(count(&me, "SELECT count(*) FROM app_pins"), 0);
}

/// L-CORE-33 step 4 and its attacker statement: a reaction is the user's, from any of their
/// devices; nobody removes another user's reaction. Mutation: key reactions by device → red here.
#[test]
fn reactions_are_kept_per_user() {
    let (_i, mut relay, mut me, mut peer) = fold_start();
    let mut twin = join(&mut relay, &mut me, &mut [&mut peer], 0xe5, 0xe7);
    let mut reader = join(&mut relay, &mut me, &mut [&mut peer, &mut twin], 0xd4, 0xd5);
    assert_eq!(
        post(&mut peer, &mut relay, 0x71, Message, None, "the target"),
        4
    );
    assert_eq!(
        post(&mut peer, &mut relay, 0xa1, ReactionAdd, Some(TARGET), "👍"),
        5
    );
    assert_eq!(
        post(&mut twin, &mut relay, 0xa2, ReactionAdd, Some(TARGET), "👍"),
        6
    );
    me.sync(&relay);
    assert_eq!(
        chips(&me, 4),
        vec![chip("👍", 1, 0)],
        "two devices of one user are one reaction"
    );
    assert_eq!(
        post(
            &mut reader,
            &mut relay,
            0xa3,
            ReactionAdd,
            Some(TARGET),
            "🎉"
        ),
        7
    );
    assert_eq!(
        post(
            &mut reader,
            &mut relay,
            0xa4,
            ReactionAdd,
            Some(TARGET),
            "👍"
        ),
        8
    );
    me.sync(&relay);
    assert_eq!(chips(&me, 4), vec![chip("👍", 2, 0), chip("🎉", 1, 0)]);
    assert_eq!(
        post(
            &mut twin,
            &mut relay,
            0xa5,
            ReactionRemove,
            Some(TARGET),
            "👍"
        ),
        9
    );
    me.sync(&relay);
    assert_eq!(
        chips(&me, 4),
        vec![chip("🎉", 1, 0), chip("👍", 1, 0)],
        "the user's removal from the other device wins by seq; chips order by their first present seq"
    );
    assert_eq!(
        post(
            &mut peer,
            &mut relay,
            0xa6,
            ReactionRemove,
            Some(TARGET),
            "🎉"
        ),
        10
    );
    me.sync(&relay);
    assert_eq!(
        chips(&me, 4),
        vec![chip("🎉", 1, 0), chip("👍", 1, 0)],
        "nobody removes another user's reaction"
    );
    assert_eq!(
        post(
            &mut reader,
            &mut relay,
            0xa7,
            ReactionRemove,
            Some(TARGET),
            "🎉"
        ),
        11
    );
    assert_eq!(
        post(
            &mut reader,
            &mut relay,
            0xa8,
            ReactionAdd,
            Some(TARGET),
            "🎉"
        ),
        12
    );
    me.sync(&relay);
    assert_eq!(chips(&me, 4), vec![chip("👍", 1, 0), chip("🎉", 1, 0)]);
    assert_eq!(
        count(
            &me,
            "SELECT count(*) FROM app_reactions WHERE user_id = x'e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5'"
        ),
        0
    );
}

#[test]
fn a_reply_shows_its_target_held_missing_or_deleted() {
    const DOOMED: [u8; 16] = [0x74; 16];
    let (_i, mut relay, mut me, mut peer) = fold_start();
    assert_eq!(
        post(
            &mut peer,
            &mut relay,
            0x71,
            Message,
            None,
            "first line\nsecond\rthird"
        ),
        2
    );
    assert_eq!(
        post(
            &mut peer,
            &mut relay,
            0x72,
            Message,
            Some(TARGET),
            "re held"
        ),
        3
    );
    assert_eq!(
        post(
            &mut peer,
            &mut relay,
            0x73,
            Message,
            Some(UNHELD),
            "re missing"
        ),
        4
    );
    assert_eq!(
        post(&mut peer, &mut relay, 0x74, Message, None, "doomed"),
        5
    );
    assert_eq!(
        post(
            &mut peer,
            &mut relay,
            0x75,
            Message,
            Some(DOOMED),
            "re deleted"
        ),
        6
    );
    assert_eq!(
        post(&mut peer, &mut relay, 0xa1, Delete, Some(DOOMED), ""),
        7
    );
    me.sync(&relay);
    assert_eq!(row_at(&me, 2).reply, None);
    assert_eq!(
        row_at(&me, 3).reply,
        Some(Reply {
            reply_to: TARGET,
            target_seq: Some(2),
            target_user: Some(PEER_USER),
            excerpt: "first line second third".into(),
            state: 0
        })
    );
    assert_eq!(
        row_at(&me, 4).reply,
        Some(Reply {
            reply_to: UNHELD,
            target_seq: None,
            target_user: None,
            excerpt: String::new(),
            state: 1
        })
    );
    assert_eq!(
        row_at(&me, 6).reply,
        Some(Reply {
            reply_to: DOOMED,
            target_seq: Some(5),
            target_user: Some(PEER_USER),
            excerpt: String::new(),
            state: 2
        })
    );
    assert_eq!(
        post(
            &mut peer,
            &mut relay,
            0xa2,
            Edit,
            Some(TARGET),
            "edited target"
        ),
        8
    );
    me.sync(&relay);
    assert_eq!(
        row_at(&me, 3).reply.expect("a reply").excerpt,
        "edited target"
    );
}

#[test]
fn the_excerpt_is_the_first_120_scalar_values_with_line_breaks_as_spaces() {
    let (_i, mut relay, mut me, mut peer) = fold_start();
    let long = format!("{}\n{}", "å".repeat(119), "ö".repeat(20));
    assert_eq!(post(&mut peer, &mut relay, 0x71, Message, None, &long), 2);
    assert_eq!(
        post(&mut peer, &mut relay, 0x72, Message, Some(TARGET), "re"),
        3
    );
    assert_eq!(post(&mut peer, &mut relay, 0xa1, Pin, Some(TARGET), ""), 4);
    me.sync(&relay);
    let want = format!("{} ", "å".repeat(119));
    let reply = row_at(&me, 3).reply.expect("a reply");
    assert_eq!(reply.excerpt, want);
    assert_eq!(reply.excerpt.chars().count(), 120);
    assert_eq!(pins(&me)[0].excerpt, want);
    assert_eq!(
        row_at(&me, 2).body,
        long,
        "the row itself shows its whole body"
    );
}

/// L-CORE-33 step 1: a fold whose target is not held is kept, hidden, and applied on arrival.
#[test]
fn a_fold_waits_for_its_target_and_applies_when_it_arrives() {
    const LATE: [u8; 16] = [0x72; 16];
    let (_i, mut relay, mut me, mut peer) = fold_start();
    assert_eq!(
        post(&mut peer, &mut relay, 0xa1, ReactionAdd, Some(LATE), "👍"),
        2
    );
    assert_eq!(
        post(
            &mut peer,
            &mut relay,
            0xa2,
            Edit,
            Some(LATE),
            "edited before it arrived"
        ),
        3
    );
    me.sync(&relay);
    assert!(me.timeline(&GROUP).is_empty(), "nothing displayable yet");
    assert_eq!(count(&me, "SELECT count(*) FROM app_reactions"), 0);
    assert_eq!(
        count(
            &me,
            "SELECT count(*) FROM app_messages WHERE type IN (1, 3)"
        ),
        2
    );
    assert_eq!(
        post(&mut peer, &mut relay, 0x72, Message, None, "late target"),
        4
    );
    me.sync(&relay);
    let row = row_at(&me, 4);
    assert_eq!(
        (row.body.as_str(), row.edited_seq, row.reactions.clone()),
        ("edited before it arrived", 3, vec![chip("👍", 1, 0)])
    );
}

/// Card 20 of web-1 and (ruled: AI-4): a later type-0 row that repeats a msg id is its own
/// message and never a target.
#[test]
fn a_replayed_msg_id_is_its_own_message_and_never_a_target() {
    let (_i, mut relay, mut me, mut peer) = fold_start();
    assert_eq!(
        post(&mut peer, &mut relay, 0x71, Message, None, "original"),
        2
    );
    assert_eq!(
        post(&mut peer, &mut relay, 0x71, Message, None, "replay"),
        3
    );
    assert_eq!(
        post(&mut peer, &mut relay, 0xa1, Edit, Some(TARGET), "edited"),
        4
    );
    assert_eq!(
        post(&mut peer, &mut relay, 0xa2, ReactionAdd, Some(TARGET), "👍"),
        5
    );
    assert_eq!(post(&mut peer, &mut relay, 0xa3, Pin, Some(TARGET), ""), 6);
    me.sync(&relay);
    let first = row_at(&me, 2);
    assert_eq!(
        (
            first.body.as_str(),
            first.edited_seq,
            first.reactions.len(),
            first.pinned
        ),
        ("edited", 4, 1, 1)
    );
    let replay = row_at(&me, 3);
    assert_eq!(
        (
            replay.body.as_str(),
            replay.edited_seq,
            replay.reactions.len(),
            replay.pinned
        ),
        ("replay", 0, 0, 0)
    );
    assert_eq!(
        post(&mut peer, &mut relay, 0xa4, Delete, Some(TARGET), ""),
        7
    );
    me.sync(&relay);
    assert_eq!(
        (
            row_at(&me, 2).status,
            row_at(&me, 3).status,
            row_at(&me, 3).body
        ),
        (2, 0, "replay".to_owned())
    );
}

/// The delivery service's deletion (gateway op 21) of a fold row or of the target refolds.
#[test]
fn a_delivery_service_delete_refolds_what_the_row_touched() {
    let (_i, mut relay, mut me, mut peer) = fold_start();
    assert_eq!(
        post(&mut peer, &mut relay, 0x71, Message, None, "the target"),
        2
    );
    assert_eq!(
        post(&mut peer, &mut relay, 0xa1, ReactionAdd, Some(TARGET), "👍"),
        3
    );
    assert_eq!(post(&mut peer, &mut relay, 0xa2, Pin, Some(TARGET), ""), 4);
    assert_eq!(
        post(&mut peer, &mut relay, 0xa3, Edit, Some(TARGET), "edited"),
        5
    );
    me.sync(&relay);
    assert_eq!(
        decode_applied(&me.core.message_deleted(&GROUP, 3).expect("op 21")).new_seqs,
        vec![3]
    );
    assert!(
        chips(&me, 2).is_empty(),
        "the deleted reaction row no longer counts"
    );
    me.core.message_deleted(&GROUP, 5).expect("op 21");
    let row = row_at(&me, 2);
    assert_eq!(
        (row.body.as_str(), row.edited_seq, row.pinned),
        ("the target", 0, 1),
        "the original body shows again"
    );
    me.core.message_deleted(&GROUP, 2).expect("op 21");
    let row = row_at(&me, 2);
    assert_eq!(
        (row.status, row.pinned),
        (2, 0),
        "the tombstone deletes the target and its pin"
    );
    assert_eq!(count(&me, "SELECT count(*) FROM app_pins"), 0);
    assert_eq!(
        post(&mut peer, &mut relay, 0xa4, Delete, Some(TARGET), ""),
        6
    );
    me.sync(&relay);
    assert_eq!(
        row_at(&me, 2).status,
        2,
        "a type 2 after the tombstone changes nothing more"
    );
}

/// Rule 2 on an own row confirmed ahead of next_seq: the served deletion refolds its target.
#[test]
fn a_served_deletion_of_an_own_row_stored_ahead_deletes_its_folds() {
    let (_i, mut relay, mut me, mut peer) = fold_start();
    let mine = me.prepare(&GROUP, "mine", NOW);
    assert_eq!(
        post(&mut peer, &mut relay, 0xa1, ReactionAdd, Some(mine), "👍"),
        2
    );
    let (_, body) = me.encrypt(&mine);
    let answer = relay.post_message(me.device, &body).expect("upload");
    assert_eq!(seq_of_answer(&answer), 3);
    me.core.send_confirm(&mine, &answer).expect("send_confirm");
    relay.delete_message(3);
    me.sync(&relay);
    let row = row_at(&me, 3);
    assert_eq!((row.status, row.reactions.len()), (2, 0));
    assert_eq!(count(&me, "SELECT count(*) FROM app_reactions"), 0);
}

#[test]
fn an_own_message_confirmed_after_a_fold_named_it_applies_the_fold() {
    let (_i, mut relay, mut me, mut peer) = fold_start();
    let mine = me.prepare(&GROUP, "mine", NOW);
    assert_eq!(
        post(&mut peer, &mut relay, 0xa1, ReactionAdd, Some(mine), "👍"),
        2
    );
    me.sync(&relay);
    assert!(seqs(&me).is_empty(), "the reaction waits, hidden");
    let (_, body) = me.encrypt(&mine);
    let answer = relay.post_message(me.device, &body).expect("upload");
    assert_eq!(seq_of_answer(&answer), 3);
    me.core.send_confirm(&mine, &answer).expect("send_confirm");
    assert_eq!(
        chips(&me, 3),
        vec![chip("👍", 1, 0)],
        "the confirm folds the waiting reaction in its unit"
    );
}

// ---------------------------------------------------------------------------------------------
// L-CORE-35: pins, own roles, role mentions.

/// Attacker statement (Q20): a pin or unpin from any member is accepted; `pins` names who pinned.
#[test]
fn pins_list_newest_first_and_name_who_pinned() {
    const A: [u8; 16] = [0x72; 16];
    const B: [u8; 16] = [0x73; 16];
    let (_i, mut relay, mut me, mut peer) = fold_start();
    let mut reader = join(&mut relay, &mut me, &mut [&mut peer], 0xd4, 0xd5);
    assert_eq!(
        post(&mut peer, &mut relay, 0x72, Message, None, "first pinned"),
        3
    );
    assert_eq!(
        post(&mut peer, &mut relay, 0x73, Message, None, "second pinned"),
        4
    );
    assert_eq!(post(&mut reader, &mut relay, 0xa1, Pin, Some(A), ""), 5);
    assert_eq!(post(&mut peer, &mut relay, 0xa2, Pin, Some(B), ""), 6);
    me.sync(&relay);
    let a_ts = row_at(&me, 3).recv_ts;
    let pin_b = PinRow {
        target_seq: 4,
        msg_id: B,
        pinned_seq: 6,
        by_user: PEER_USER,
        author: Some(PEER_USER),
        excerpt: "second pinned".into(),
        target_ts: row_at(&me, 4).recv_ts,
    };
    assert_eq!(
        pins(&me),
        vec![
            pin_b.clone(),
            PinRow {
                target_seq: 3,
                msg_id: A,
                pinned_seq: 5,
                by_user: READER_USER,
                author: Some(PEER_USER),
                excerpt: "first pinned".into(),
                target_ts: a_ts
            },
        ]
    );
    assert_eq!(post(&mut peer, &mut relay, 0xa3, Unpin, Some(A), ""), 7);
    me.sync(&relay);
    assert_eq!(pins(&me), vec![pin_b.clone()], "any member unpins");
    assert_eq!(row_at(&me, 3).pinned, 0);
    assert_eq!(post(&mut reader, &mut relay, 0xa4, Pin, Some(A), ""), 8);
    me.sync(&relay);
    assert_eq!(
        pins(&me),
        vec![
            PinRow {
                target_seq: 3,
                msg_id: A,
                pinned_seq: 8,
                by_user: READER_USER,
                author: Some(PEER_USER),
                excerpt: "first pinned".into(),
                target_ts: a_ts
            },
            pin_b,
        ]
    );
    assert_eq!(code(me.core.pins(&OTHER_GROUP)), "E_CORE_NOT_FOUND");
}

/// Q20, ruling 12: role mentions count for the roles learned before the row is applied; no backfill.
#[test]
fn own_roles_flag_role_mentions_from_then_on() {
    let (_i, mut relay, mut me, mut peer) = fold_start();
    let role_body = format!("standup <@{}>", "3c".repeat(16));
    assert_eq!(
        post(&mut peer, &mut relay, 0x71, Message, None, &role_body),
        2
    );
    me.sync(&relay);
    me.core
        .own_roles_set(&COMMUNITY, &[ROLE, [0x3e; 16]].concat())
        .expect("own_roles_set");
    assert_eq!(
        row_at(&me, 2).mention,
        0,
        "a row applied before the roles were known keeps its flag"
    );
    assert_eq!(
        post(&mut peer, &mut relay, 0x72, Message, None, &role_body),
        3
    );
    assert_eq!(
        post(
            &mut peer,
            &mut relay,
            0x73,
            Message,
            None,
            &format!("ops <@{}>", "3d".repeat(16))
        ),
        4
    );
    assert_eq!(
        post(
            &mut peer,
            &mut relay,
            0x74,
            Message,
            None,
            &format!("shout <@{}>", "3C".repeat(16))
        ),
        5
    );
    me.sync(&relay);
    assert_eq!(
        (
            row_at(&me, 3).mention,
            row_at(&me, 4).mention,
            row_at(&me, 5).mention
        ),
        (1, 0, 0)
    );
    assert_eq!(count(&me, "SELECT count(*) FROM app_roles"), 2);
    me.core.own_roles_set(&COMMUNITY, &[]).expect("cleared");
    assert_eq!(
        count(&me, "SELECT count(*) FROM app_roles"),
        0,
        "the set is replaced, not merged"
    );
    assert_eq!(
        post(&mut peer, &mut relay, 0x75, Message, None, &role_body),
        6
    );
    me.sync(&relay);
    assert_eq!(row_at(&me, 6).mention, 0);
    me.core
        .own_roles_set(&[0x23; 16], &ROLE)
        .expect("another community");
    assert_eq!(
        post(&mut peer, &mut relay, 0x76, Message, None, &role_body),
        7
    );
    me.sync(&relay);
    assert_eq!(
        row_at(&me, 7).mention,
        0,
        "a role of another community does not count here"
    );
    for bad in [vec![0u8; 17], vec![0u8; 1040]] {
        assert_eq!(
            me.core.own_roles_set(&COMMUNITY, &bad),
            Err(ClientError {
                code: "E_CORE_INPUT",
                detail: "role_ids must be 0..=64 ids of 16 bytes".into()
            })
        );
    }
    let sixty_four: Vec<u8> = (0..64u8).flat_map(|i| [i; 16]).collect();
    me.core
        .own_roles_set(&COMMUNITY, &sixty_four)
        .expect("64 ids");
    assert_eq!(count(&me, "SELECT count(*) FROM app_roles"), 65);
}

#[test]
fn mentions_me_with_roles_matches_the_tokens_literally() {
    let me = [0xa1; 16];
    let roles = [ROLE, OTHER_ROLE];
    for (body, want) in [
        (format!("<@{}>", "a1".repeat(16)), true),
        (format!("hey <@{}> team", "3c".repeat(16)), true),
        (format!("<@{}>", "3d".repeat(16)), true),
        (format!("<@{}>", "3e".repeat(16)), false),
        (format!("<@{}>", "3C".repeat(16)), false),
        ("<@everyone>".to_owned(), true),
        ("<@here>".to_owned(), true),
        (format!("<@{}", "3c".repeat(16)), false),
        (String::new(), false),
    ] {
        assert_eq!(mentions_me_with_roles(&body, &me, &roles), want, "{body:?}");
    }
    assert!(!mentions_me_with_roles(
        &format!("<@{}>", "3c".repeat(16)),
        &me,
        &[]
    ));
}

#[test]
fn an_attachment_summary_is_read_from_the_envelope() {
    let (_i, mut relay, mut me, mut peer) = fold_start();
    let mut env = fold_envelope([0x72; 16], Message, None, "");
    env.attachments = vec![
        Attachment {
            blob_id: [0x43; 32],
            key: [0x44; 32],
            nonce: [0x45; 12],
            size: 1234,
            mime: "image/png".into(),
            w: Some(640),
            h: Some(480),
            thumb: Some(vec![0x01; 42]),
            name: "map.png".into(),
        },
        Attachment {
            blob_id: [0x53; 32],
            key: [0x54; 32],
            nonce: [0x55; 12],
            size: 70_000,
            mime: "application/pdf".into(),
            w: None,
            h: None,
            thumb: None,
            name: String::new(),
        },
    ];
    let seq = peer.send_envelope(&mut relay, &env);
    me.sync(&relay);
    assert_eq!(
        row_at(&me, seq).attachments,
        vec![
            AttachmentSummary {
                index: 0,
                size: 1234,
                mime: "image/png".into(),
                w: Some(640),
                h: Some(480),
                has_thumb: 1,
                name: "map.png".into()
            },
            AttachmentSummary {
                index: 1,
                size: 70_000,
                mime: "application/pdf".into(),
                w: None,
                h: None,
                has_thumb: 0,
                name: String::new()
            },
        ],
        "an attachment-only message (empty body) shows its files"
    );
    me.core.message_deleted(&GROUP, seq).expect("op 21");
    assert!(row_at(&me, seq).attachments.is_empty());
}

#[test]
fn the_views_need_an_identity() {
    let mut core = ClientCore::open(memory()).expect("open");
    assert_eq!(code(core.timeline(&GROUP, 0, 10)), "E_CORE_NO_IDENTITY");
    assert_eq!(code(core.pins(&GROUP)), "E_CORE_NO_IDENTITY");
    assert_eq!(
        code(core.own_roles_set(&COMMUNITY, &[])),
        "E_CORE_NO_IDENTITY"
    );
}

/// FACTS-SECURITY-03 and lesson e: a device that never held the target (the delivery service's
/// tombstone reached it first) still drops the author's edits named by the author's delete. Only
/// a user's own delete blanks only that user's words: another user's edit keeps its body.
#[test]
fn a_delete_of_a_target_never_held_blanks_its_authors_edits() {
    let (_i, mut relay, mut me, mut peer) = fold_start();
    let mut reader = join(&mut relay, &mut me, &mut [&mut peer], 0xd4, 0xd5);
    assert_eq!(
        post(&mut peer, &mut relay, 0x71, Message, None, "the target"),
        3
    );
    assert_eq!(
        post(
            &mut peer,
            &mut relay,
            0xa1,
            Edit,
            Some(TARGET),
            "secret words"
        ),
        4
    );
    assert_eq!(
        post(
            &mut reader,
            &mut relay,
            0xa2,
            Edit,
            Some(TARGET),
            "reader words"
        ),
        5
    );
    assert_eq!(
        post(&mut peer, &mut relay, 0xa3, Delete, Some(TARGET), ""),
        6
    );
    relay.delete_message(3);
    me.sync(&relay);
    assert_eq!(
        row_at(&me, 3).status,
        2,
        "the tombstoned target is a deleted row"
    );
    assert_eq!(
        count(
            &me,
            "SELECT count(*) FROM app_messages WHERE seq = 4 AND body = '' AND envelope IS NULL"
        ),
        1,
        "the author's edit of a target never held is blanked by the author's delete"
    );
    assert_eq!(
        count(
            &me,
            "SELECT count(*) FROM app_messages WHERE seq = 5 AND body = 'reader words' AND envelope IS NOT NULL"
        ),
        1,
        "another user's edit is not blanked by the author's delete"
    );
}

/// FACTS-SECURITY-02: the view bounds the chips a member can make; the most counted stay.
#[test]
fn the_view_shows_at_most_twenty_reactions_most_counted_first() {
    let (_i, mut relay, mut me, mut peer) = fold_start();
    let mut reader = join(&mut relay, &mut me, &mut [&mut peer], 0xd4, 0xd5);
    assert_eq!(
        post(&mut peer, &mut relay, 0x71, Message, None, "the target"),
        3
    );
    for i in 0..25u8 {
        post(
            &mut peer,
            &mut relay,
            0xb0 + i,
            ReactionAdd,
            Some(TARGET),
            &format!("r{i:02}"),
        );
    }
    post(
        &mut reader,
        &mut relay,
        0xa1,
        ReactionAdd,
        Some(TARGET),
        "r24",
    );
    me.sync(&relay);
    let mut want: Vec<(String, u64, u64)> =
        (0..19).map(|i| chip(&format!("r{i:02}"), 1, 0)).collect();
    want.push(chip("r24", 2, 0));
    assert_eq!(chips(&me, 3), want);
}

/// FACTS-SECURITY-02: a long catch-up of one member's reactions on one target folds to the
/// right state (the cost bound itself is `fold::tests::every_fold_statement_is_an_index_search`).
#[test]
fn a_thousand_reaction_rows_on_one_target_fold() {
    let (_i, mut relay, mut me, mut peer) = fold_start();
    assert_eq!(
        post(&mut peer, &mut relay, 0x71, Message, None, "the target"),
        2
    );
    for i in 0..1000u32 {
        let kind = if i % 2 == 0 {
            ReactionAdd
        } else {
            ReactionRemove
        };
        post(&mut peer, &mut relay, 0xb0, kind, Some(TARGET), "👍");
    }
    post(&mut peer, &mut relay, 0xb1, ReactionAdd, Some(TARGET), "👍");
    me.sync(&relay);
    assert_eq!(chips(&me, 2), vec![chip("👍", 1, 0)]);
    assert_eq!(count(&me, "SELECT count(*) FROM app_reactions"), 1);
}

/// S1: an attacker can park rows on an unheld id or a deleted message. Each later insert
/// writes only its own row and the cursor, independent of those parked rows.
#[test]
fn parked_and_deleted_targets_touch_at_most_three_rows_per_insert() {
    use rusqlite::params;
    let (_i, mut relay, mut me, mut peer) = fold_start();
    let mut mallory = join(&mut relay, &mut me, &mut [&mut peer], 0xd4, 0xd5);
    assert_eq!(
        post(&mut peer, &mut relay, 0x71, Message, None, "doomed"),
        3
    );
    assert_eq!(
        post(&mut peer, &mut relay, 0xa1, Delete, Some(TARGET), ""),
        4
    );
    me.sync(&relay);
    {
        let c = me.probe.lock().expect("lock");
        for (which, target) in [TARGET, UNHELD].iter().enumerate() {
            for i in 0..200i64 {
                for ty in [1i64, 2] {
                    let seq = -1 - (which as i64 * 400 + i * 2 + ty - 1);
                    c.execute("INSERT INTO app_messages (group_id,seq,epoch,recv_ts,status,sender_user,sender_device,type,reply_to,body,franking_tag) VALUES (?1,?2,0,0,0,?3,?4,?5,?6,?7,?8)",
                        params![GROUP.as_slice(), seq, READER_USER.as_slice(), mallory.device.as_slice(), ty, target.as_slice(), if ty == 1 { "ignored" } else { "" }, [0u8; 32].as_slice()]).expect("park a fold row");
                }
            }
        }
    }
    let before = me.probe.lock().expect("lock").total_changes();
    let edit_seq = post(
        &mut mallory,
        &mut relay,
        0xb3,
        Edit,
        Some(TARGET),
        "late edit",
    );
    me.sync(&relay);
    let c = me.probe.lock().expect("lock");
    let (body, envelope): (String, Option<Vec<u8>>) = c
        .query_row(
            "SELECT body, envelope FROM app_messages WHERE group_id = ?1 AND seq = ?2",
            params![GROUP.as_slice(), edit_seq as i64],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .expect("stored late edit");
    assert_eq!(body, "", "late edit of a deleted target is blanked");
    assert!(envelope.is_none(), "late edit envelope is blanked");
    let after = c.total_changes();
    drop(c);
    assert!(
        after - before <= 4,
        "deleted target edit changed {} rows",
        after - before
    );
    let before = after;
    post(
        &mut mallory,
        &mut relay,
        0xb1,
        ReactionAdd,
        Some(TARGET),
        "👍",
    );
    me.sync(&relay);
    let after = me.probe.lock().expect("lock").total_changes();
    assert!(
        after - before <= 3,
        "deleted target changed {} rows",
        after - before
    );
    let before = after;
    post(&mut mallory, &mut relay, 0xb2, Delete, Some(UNHELD), "");
    me.sync(&relay);
    let after = me.probe.lock().expect("lock").total_changes();
    assert!(
        after - before <= 3,
        "unheld target changed {} rows",
        after - before
    );
}
