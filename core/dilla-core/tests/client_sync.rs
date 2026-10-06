// Native only, like tests/mls_roundtrip.rs: every test opens an in-memory SQLite connection.
#![cfg(not(target_arch = "wasm32"))]

//! Task 6: ordered handshakes, the `through` contract, the handshake tail, commit build, confirm
//! and abort including a lost race, own-leaf removal, an unprocessable commit, the cursor,
//! `message_deleted` (gateway op 21) and the parity fixture of L-CORE-10.

mod client_support;

use client_support::*;
use dilla_core::cbor::{Encoder, decode_strict};
use dilla_core::client::{ClientCore, ClientError};
use dilla_core::envelope::EnvelopeType;

/// (epoch, the devices the Welcomes are addressed to) of a POST …/commit body.
fn commit_body(body: &[u8]) -> (u64, Vec<[u8; 16]>) {
    decode_strict(body, |d| {
        d.array(5)?;
        let epoch = d.uint()?;
        d.bytes()?;
        d.bytes()?;
        let n = d.array_len()?;
        let mut devices = Vec::with_capacity(n);
        for _ in 0..n {
            d.array(2)?;
            devices.push(d.bytes_exact::<16>()?);
            d.bytes()?;
        }
        d.null()?;
        Ok((epoch, devices))
    })
    .expect("commit body shape")
}

/// The same proposals list with every entry marked void.
fn voided(body: &[u8]) -> Vec<u8> {
    let rows = decode_strict(body, |d| {
        let n = d.array_len()?;
        let mut rows = Vec::with_capacity(n);
        for _ in 0..n {
            d.array(5)?;
            rows.push((
                d.bytes()?.to_vec(),
                d.uint()?,
                d.opt_uint()?,
                d.bytes()?.to_vec(),
                d.uint()?,
            ));
        }
        Ok(rows)
    })
    .expect("proposals body shape");
    let mut e = Encoder::new();
    e.array(rows.len());
    for (reference, kind, target, blob, _) in &rows {
        e.array(5)
            .bytes(reference)
            .uint(*kind)
            .opt_uint(*target)
            .bytes(blob)
            .uint(1);
    }
    e.into_vec()
}

fn cursor(core: &ClientCore) -> Option<(u64, u64)> {
    let bytes = core.cursor_body(&GROUP).expect("cursor_body");
    if bytes == [0xf6] {
        return None;
    }
    Some(
        decode_strict(&bytes, |d| {
            d.array(2)?;
            Ok((d.uint()?, d.uint()?))
        })
        .expect("cursor body shape"),
    )
}

fn sql_seq(seq: u64) -> i64 {
    i64::try_from(seq).expect("a seq fits an INTEGER")
}

#[test]
fn group_apply_advances_over_rows_the_caller_declares_complete() {
    let (_instance, mut relay, mut a, mut b) = alice_and_bob();
    let (_, s1) = b.send(&mut relay, &GROUP, "one", NOW + 1);
    let (_, s2) = b.send(&mut relay, &GROUP, "two", NOW + 2);
    let (_, s3) = b.send(&mut relay, &GROUP, "three", NOW + 3);
    let row = |seq: u64| {
        relay
            .messages
            .iter()
            .find(|m| m.seq == seq)
            .expect("row")
            .clone()
    };
    let (r1, r3) = (row(s1), row(s3));

    // The caller declares s1..=s2 complete and hands over s1 and s3: s3 waits, s2 is passed over.
    let applied = decode_applied(
        &a.core
            .group_apply(&GROUP, &[0x80], &encode_messages(&[&r1, &r3]), s2)
            .expect("apply"),
    );
    assert_eq!(applied.new_seqs, vec![s1]);
    assert_eq!(applied.next_seq, s2 + 1);

    let applied = decode_applied(
        &a.core
            .group_apply(&GROUP, &[0x80], &encode_messages(&[&r3]), s3)
            .expect("apply"),
    );
    assert_eq!(applied.new_seqs, vec![s3]);
    assert_eq!(applied.next_seq, s3 + 1);
    assert_eq!(
        a.timeline(&GROUP).iter().map(|r| r.seq).collect::<Vec<_>>(),
        vec![s1, s3]
    );

    // Empty pages declared complete move the head; a bound behind it changes nothing.
    let applied = decode_applied(
        &a.core
            .group_apply(&GROUP, &[0x80], &[0x80], s3 + 9)
            .expect("empty"),
    );
    assert!(applied.new_seqs.is_empty());
    assert_eq!(applied.next_seq, s3 + 10);
    let applied = decode_applied(
        &a.core
            .group_apply(&GROUP, &[0x80], &[0x80], 1)
            .expect("behind"),
    );
    assert_eq!(applied.next_seq, s3 + 10);
}

#[test]
fn a_message_of_the_next_epoch_is_applied_after_its_commit_whatever_the_array_order() {
    let (_instance, mut relay, mut a, mut b) = alice_and_bob();
    b.commit(&mut relay);
    let (_, seq) = b.send(&mut relay, &GROUP, "in the new epoch", NOW + 1);
    let commit = relay.handshakes.last().expect("the commit").clone();
    let message = relay.messages.last().expect("the message").clone();
    assert!(commit.seq < message.seq);

    let applied = decode_applied(
        &a.core
            .group_apply(
                &GROUP,
                &encode_handshakes(&[&commit]),
                &encode_messages(&[&message]),
                relay.through(),
            )
            .expect("apply"),
    );
    assert_eq!(applied.epoch, 2);
    assert_eq!(applied.flags & EPOCH_CHANGED, EPOCH_CHANGED);
    assert_eq!(applied.new_seqs, vec![seq]);
    let row = a.timeline(&GROUP).pop().expect("row");
    assert_eq!(
        row.status, 0,
        "decrypted in the epoch its commit opened; reason {:?}",
        row.reason
    );
    assert_eq!(row.epoch, 2);
}

#[test]
fn the_handshake_tail_keeps_the_newest_64_rows() {
    let (_instance, mut relay, mut a, mut b) = alice_and_bob();
    for _ in 0..70 {
        b.commit(&mut relay);
    }
    let applied = a.sync(&relay);
    assert_eq!(applied.epoch, 71);

    let conn = a.probe.lock().expect("probe");
    let (count, low, high): (i64, i64, i64) = conn
        .query_row(
            "SELECT COUNT(*), MIN(seq), MAX(seq) FROM app_handshake_tail WHERE group_id = ?1",
            [GROUP.as_slice()],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .expect("tail");
    assert_eq!(count, 64);
    assert_eq!(high, sql_seq(relay.through()));
    assert_eq!(low, high - 63);

    let last = relay.handshakes.last().expect("a commit");
    let stored: (i64, i64, Option<i64>, Vec<u8>) = conn
        .query_row(
            "SELECT epoch, kind, sender, blob FROM app_handshake_tail WHERE group_id = ?1 AND seq = ?2",
            rusqlite::params![GROUP.as_slice(), high],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .expect("the newest row");
    assert_eq!(
        stored,
        (
            sql_seq(last.epoch),
            1,
            last.sender.map(sql_seq),
            last.blob.clone()
        )
    );
}

#[test]
fn an_instance_add_seen_twice_is_queued_once_and_its_commit_welcomes_the_device() {
    let (instance, mut relay, mut a, mut b) = alice_and_bob();
    let mut c = ready_core(0xc3, "carol");
    let kp = c.first_key_package();
    instance.propose_add(&mut relay, &kp);

    let seen = a.sync(&relay);
    assert_eq!(seen.proposals_pending, 1);
    let blocked = a.prepare(&GROUP, "blocked", NOW + 1);
    assert_eq!(
        code(a.core.send_encrypt(&blocked)),
        "E_CORE_STATE",
        "no message while a proposal is pending"
    );
    a.core.send_discard(&blocked).expect("discard");

    let body = a
        .core
        .commit_build(&GROUP, &relay.proposals_body())
        .expect("commit_build");
    let row = a.group(&GROUP).expect("row");
    assert_eq!(
        (row.proposals_pending, row.pending_commit),
        (1, 1),
        "the listed copy is the proposal already queued"
    );
    assert_eq!(commit_body(&body), (1, vec![c.device]));
    relay
        .commit(&body)
        .expect("the commit references the outstanding proposal exactly once");
    let confirmed = decode_applied(&a.core.commit_confirm(&GROUP).expect("commit_confirm"));
    assert_eq!(
        confirmed,
        Applied {
            state: 2,
            epoch: 2,
            next_seq: seen.next_seq,
            new_seqs: vec![],
            proposals_pending: 0,
            flags: EPOCH_CHANGED,
        }
    );

    // Bob queues the proposal and merges the commit that references it, in one call, in seq order.
    let applied = b.sync(&relay);
    assert_eq!((applied.epoch, applied.proposals_pending), (2, 0));
    assert_eq!(applied.flags & EPOCH_CHANGED, EPOCH_CHANGED);

    let joined = c
        .core
        .welcomes_apply(
            &relay.welcomes_body(c.device),
            &expected_body(&[(GROUP, COMMUNITY, CHANNEL, POLICY)]),
        )
        .expect("welcomes_apply");
    assert_eq!(decode_outcomes(&joined)[0].outcome, 0);
    assert_eq!(c.group(&GROUP).map(|g| g.epoch), Some(2));

    let (_, seq) = a.send(&mut relay, &GROUP, "three of us", NOW + 2);
    for member in [&mut b, &mut c] {
        assert_eq!(member.sync(&relay).new_seqs, vec![seq]);
        assert_eq!(
            member.timeline(&GROUP).pop().map(|r| (r.status, r.body)),
            Some((0, "three of us".to_owned()))
        );
    }
}

#[test]
fn the_echo_of_an_own_commit_before_its_confirm_merges_it_and_confirm_is_a_no_op() {
    let (_instance, mut relay, mut a, mut b) = alice_and_bob();
    let body = a
        .core
        .commit_build(&GROUP, &relay.proposals_body())
        .expect("commit_build");
    relay.commit(&body).expect("accepted");

    let applied = a.sync(&relay);
    assert_eq!(applied.epoch, 2);
    assert_eq!(applied.flags & EPOCH_CHANGED, EPOCH_CHANGED);
    assert!(applied.new_seqs.is_empty());
    assert_eq!(a.group(&GROUP).map(|g| g.pending_commit), Some(0));

    let confirmed = decode_applied(&a.core.commit_confirm(&GROUP).expect("commit_confirm"));
    assert_eq!(
        confirmed,
        Applied {
            state: 2,
            epoch: 2,
            next_seq: applied.next_seq,
            new_seqs: vec![],
            proposals_pending: 0,
            flags: EPOCH_CHANGED,
        }
    );

    assert_eq!(b.sync(&relay).epoch, 2);
    let (_, seq) = a.send(&mut relay, &GROUP, "after my own commit", NOW + 1);
    assert_eq!(b.sync(&relay).new_seqs, vec![seq]);
    assert_eq!(b.timeline(&GROUP).pop().map(|r| r.status), Some(0));
}

#[test]
fn the_loser_of_a_commit_race_aborts_applies_the_winner_and_commits_again() {
    let (instance, mut relay, mut a, mut b) = alice_and_bob();
    let mut c = ready_core(0xc3, "carol");
    let kp = c.first_key_package();
    instance.propose_add(&mut relay, &kp);
    a.sync(&relay);
    b.sync(&relay);

    let mine = a
        .core
        .commit_build(&GROUP, &relay.proposals_body())
        .expect("alice builds");
    let theirs = b
        .core
        .commit_build(&GROUP, &relay.proposals_body())
        .expect("bob builds");
    relay.commit(&theirs).expect("bob wins");
    assert_eq!(
        relay.commit(&mine).expect_err("alice loses"),
        "E_COMMIT_CONFLICT"
    );
    b.core.commit_confirm(&GROUP).expect("bob confirms");

    a.core.commit_abort(&GROUP).expect("abort");
    let row = a.group(&GROUP).expect("row");
    assert_eq!(row.pending_commit, 0, "abort clears the pending commit");
    assert_eq!(row.proposals_pending, 1, "the queued proposal stays queued");
    assert_eq!(row.epoch, 1);

    let applied = a.sync(&relay);
    assert_eq!((applied.epoch, applied.proposals_pending), (2, 0));
    assert_eq!(applied.flags & EPOCH_CHANGED, EPOCH_CHANGED);
    let again = a
        .core
        .commit_build(&GROUP, &relay.proposals_body())
        .expect("alice builds again");
    relay.commit(&again).expect("accepted at the new epoch");
    a.core.commit_confirm(&GROUP).expect("confirm");
    a.core
        .commit_abort(&GROUP)
        .expect("an abort without a pending commit is a no-op");

    assert_eq!(b.sync(&relay).epoch, 3);
    let joined = c
        .core
        .welcomes_apply(
            &relay.welcomes_body(c.device),
            &expected_body(&[(GROUP, COMMUNITY, CHANNEL, POLICY)]),
        )
        .expect("welcomes_apply");
    assert_eq!(decode_outcomes(&joined)[0].outcome, 0);
    assert_eq!(c.sync(&relay).epoch, 3);

    let (_, seq) = a.send(&mut relay, &GROUP, "after the race", NOW + 1);
    for member in [&mut b, &mut c] {
        assert_eq!(member.sync(&relay).new_seqs, vec![seq]);
    }
}

#[test]
fn a_commit_that_cannot_be_processed_stops_the_group_in_needs_resync() {
    let (_instance, mut relay, mut a, mut b) = alice_and_bob();
    let junk_proposal = relay.push_handshake(0, b"not an mls message".to_vec());
    let junk_commit = relay.push_handshake(1, b"not an mls commit either".to_vec());
    b.send(&mut relay, &GROUP, "behind the bad commit", NOW + 1);

    let applied = a.sync(&relay);
    assert_eq!(applied.state, 3);
    assert_eq!(
        applied.next_seq, junk_commit,
        "next_seq stays on the commit that failed"
    );
    assert_eq!(
        junk_commit,
        junk_proposal + 1,
        "the bad proposal before it was passed over"
    );
    assert!(
        applied.new_seqs.is_empty(),
        "nothing after the commit was applied"
    );
    assert_eq!(applied.epoch, 1);
    assert_eq!(a.group(&GROUP).map(|g| g.state), Some(3));
    let kept: i64 = a
        .probe
        .lock()
        .expect("probe")
        .query_row(
            "SELECT COUNT(*) FROM app_handshake_tail WHERE group_id = ?1 AND seq IN (?2, ?3)",
            rusqlite::params![
                GROUP.as_slice(),
                sql_seq(junk_proposal),
                sql_seq(junk_commit)
            ],
            |r| r.get(0),
        )
        .expect("tail");
    assert_eq!(kept, 2, "both rows are kept for a heal or a fork report");
    assert_eq!(code(a.try_sync(&relay)), "E_CORE_STATE");
    assert_eq!(code(a.core.send_prepare(&GROUP, "x", NOW)), "E_CORE_STATE");

    // An external join brings the group back.
    a.join_external(&mut relay);
    assert_eq!(a.group(&GROUP).map(|g| (g.state, g.epoch)), Some((2, 2)));
    a.send(&mut relay, &GROUP, "back again", NOW + 2);
}

#[test]
fn a_commit_that_removes_this_device_marks_the_group_gone_and_keeps_its_history() {
    let (instance, mut relay, mut a, mut b) = alice_and_bob();
    a.send(&mut relay, &GROUP, "before the removal", NOW + 1);
    b.sync(&relay);
    instance.propose_remove(&mut relay, b.device);
    a.sync(&relay);
    a.commit(&mut relay);
    let commit_seq = relay.through();
    a.send(&mut relay, &GROUP, "after the removal", NOW + 2);

    let applied = b.sync(&relay);
    assert_eq!(applied.state, 4);
    assert_eq!(applied.epoch, 0);
    assert_eq!(applied.flags & EPOCH_CHANGED, EPOCH_CHANGED);
    assert_eq!(applied.next_seq, commit_seq + 1);
    assert!(
        applied.new_seqs.is_empty(),
        "nothing after the removing commit is applied"
    );
    let row = b.group(&GROUP).expect("the row stays");
    assert_eq!(
        (
            row.state,
            row.epoch,
            row.pending_commit,
            row.proposals_pending
        ),
        (4, 0, 0, 0)
    );
    let bodies: Vec<String> = b.timeline(&GROUP).into_iter().map(|r| r.body).collect();
    assert_eq!(bodies, vec!["before the removal"]);

    assert_eq!(code(b.try_sync(&relay)), "E_CORE_STATE");
    assert_eq!(code(b.core.send_prepare(&GROUP, "x", NOW)), "E_CORE_STATE");
    assert_eq!(code(b.core.cursor_body(&GROUP)), "E_CORE_STATE");
    assert_eq!(code(b.core.commit_build(&GROUP, &[0x80])), "E_CORE_STATE");
    assert_eq!(
        code(b.core.message_deleted(&GROUP, commit_seq)),
        "E_CORE_STATE",
        "op 21 is refused for a gone group"
    );
    b.core
        .group_create(
            &OTHER_GROUP,
            Some(&COMMUNITY),
            &CHANNEL,
            POLICY,
            &instance.public(),
        )
        .expect("a gone group frees its channel");
}

#[test]
fn the_cursor_body_names_the_applied_head_until_it_is_acknowledged() {
    let (_instance, mut relay, mut a, mut b) = alice_and_bob();
    let head = a.group(&GROUP).expect("row").next_seq - 1;
    assert_eq!(cursor(&a.core), Some((head, 1)));
    a.core.cursor_acked(&GROUP, head, 1).expect("acked");
    assert_eq!(cursor(&a.core), None);
    assert_eq!(
        code(a.core.cursor_acked(&GROUP, head + 1, 1)),
        "E_CORE_INPUT",
        "beyond the applied head"
    );
    a.core
        .cursor_acked(&GROUP, 0, 0)
        .expect("an older acknowledgement is accepted");
    assert_eq!(cursor(&a.core), None, "and moves nothing back");

    let (_, seq) = b.send(&mut relay, &GROUP, "one more", NOW + 1);
    a.sync(&relay);
    assert_eq!(cursor(&a.core), Some((seq, 1)));
    assert_eq!(code(a.core.cursor_body(&OTHER_GROUP)), "E_CORE_NOT_FOUND");
    assert_eq!(
        code(a.core.cursor_acked(&OTHER_GROUP, 0, 0)),
        "E_CORE_NOT_FOUND"
    );
}

#[test]
fn commit_build_needs_an_active_group_without_a_pending_commit() {
    let instance = Instance::generate();
    let mut relay = Relay::new(GROUP);
    let mut a = ready_core(0xa1, "alice");
    a.create_and_register(&mut relay, &instance);
    let mut c = ready_core(0xc3, "carol");
    let kp = c.first_key_package();
    instance.propose_add(&mut relay, &kp);

    // A void proposal is left out.
    let body = a
        .core
        .commit_build(&GROUP, &voided(&relay.proposals_body()))
        .expect("commit_build");
    assert_eq!(commit_body(&body), (0, vec![]));
    assert_eq!(
        a.group(&GROUP)
            .map(|g| (g.proposals_pending, g.pending_commit)),
        Some((0, 1))
    );
    assert_eq!(
        code(a.core.commit_build(&GROUP, &[0x80])),
        "E_CORE_STATE",
        "a commit is pending"
    );
    let msg = a.prepare(&GROUP, "while committing", NOW);
    assert_eq!(code(a.core.send_encrypt(&msg)), "E_CORE_STATE");
    a.core.commit_abort(&GROUP).expect("abort");
    a.core
        .commit_abort(&GROUP)
        .expect("a second abort is a no-op");
    assert_eq!(a.group(&GROUP).map(|g| g.pending_commit), Some(0));

    // The listed proposal is queued and committed, and its Welcome is addressed.
    let body = a
        .core
        .commit_build(&GROUP, &relay.proposals_body())
        .expect("commit_build");
    assert_eq!(commit_body(&body), (0, vec![c.device]));
    assert_eq!(a.group(&GROUP).map(|g| g.proposals_pending), Some(1));
    a.core.commit_abort(&GROUP).expect("abort");
    assert_eq!(a.group(&GROUP).map(|g| g.proposals_pending), Some(1));

    assert_eq!(code(a.core.commit_build(&GROUP, &[0xff])), "E_CORE_INPUT");
    assert_eq!(
        code(a.core.commit_build(&OTHER_GROUP, &[0x80])),
        "E_CORE_NOT_FOUND"
    );
    assert_eq!(
        code(a.core.commit_confirm(&OTHER_GROUP)),
        "E_CORE_NOT_FOUND"
    );
    assert_eq!(code(a.core.commit_abort(&OTHER_GROUP)), "E_CORE_NOT_FOUND");
    a.core
        .group_create(
            &OTHER_GROUP,
            Some(&COMMUNITY),
            &OTHER_CHANNEL,
            POLICY,
            &instance.public(),
        )
        .expect("create");
    assert_eq!(
        code(a.core.commit_build(&OTHER_GROUP, &[0x80])),
        "E_CORE_STATE"
    );
    assert_eq!(code(a.core.commit_confirm(&OTHER_GROUP)), "E_CORE_STATE");
}

/// L-CORE-21: every writer keeps app_groups.epoch and pending_commit equal to the stored MLS
/// group, through create, external join, merged and lost commits, an own commit's echo, a resync
/// discarded and completed, a Welcome, a removal and a discarded rejoin of the gone row.
#[test]
fn every_writer_keeps_the_persisted_epoch_and_pending_commit_equal_to_the_mls_group() {
    let instance = Instance::generate();
    let mut relay = Relay::new(GROUP);
    let mut a = ready_core(0xa1, "alice");
    let mut b = ready_core(0xb2, "bob");
    let body = a
        .core
        .group_create(
            &GROUP,
            Some(&COMMUNITY),
            &CHANNEL,
            POLICY,
            &instance.public(),
        )
        .expect("group_create");
    a.check_columns("group_create");
    let created = relay.register(&body).expect("register");
    let next_seq = decode_strict(&created, |d| {
        d.array(2)?;
        d.bytes_exact::<16>()?;
        d.uint()
    })
    .expect("201 body");
    a.core
        .group_registered(&GROUP, next_seq)
        .expect("group_registered");
    a.check_columns("group_registered");

    let join = b
        .core
        .group_join_external(
            &GROUP,
            Some(&COMMUNITY),
            &CHANNEL,
            POLICY,
            &relay.info_body(),
            &relay.tree_body(),
        )
        .expect("group_join_external");
    assert_eq!(
        b.group(&GROUP)
            .map(|g| (g.state, g.epoch, g.pending_commit)),
        Some((1, 1, 0)),
        "the external commit is merged when the join returns"
    );
    b.check_columns("group_join_external");
    let answer = relay.resync(&join).expect("resync");
    let seq = decode_strict(&answer, |d| {
        d.array(2)?;
        let seq = d.uint()?;
        d.uint()?;
        Ok(seq)
    })
    .expect("200 body");
    b.core.group_joined(&GROUP, seq).expect("group_joined");
    b.check_columns("group_joined");
    a.sync(&relay);
    assert_eq!(a.group(&GROUP).map(|g| g.epoch), Some(1));
    a.check_columns("a merged external commit");

    a.core
        .commit_build(&GROUP, &relay.proposals_body())
        .expect("commit_build");
    assert_eq!(a.group(&GROUP).map(|g| g.pending_commit), Some(1));
    a.check_columns("commit_build");
    a.core.commit_abort(&GROUP).expect("commit_abort");
    a.check_columns("commit_abort");
    a.commit(&mut relay);
    assert_eq!(
        a.group(&GROUP).map(|g| (g.epoch, g.pending_commit)),
        Some((2, 0))
    );
    a.check_columns("commit_confirm");
    b.sync(&relay);
    b.check_columns("a staged commit");

    // A commit that loses the race: Alice's merged commit clears Bob's pending one.
    b.core
        .commit_build(&GROUP, &relay.proposals_body())
        .expect("commit_build");
    b.check_columns("a second commit_build");
    a.commit(&mut relay);
    b.sync(&relay);
    assert_eq!(
        b.group(&GROUP).map(|g| (g.epoch, g.pending_commit)),
        Some((3, 0))
    );
    b.check_columns("a lost race");

    // The echo of an own commit is merged by group_apply.
    let body = b
        .core
        .commit_build(&GROUP, &relay.proposals_body())
        .expect("commit_build");
    relay.commit(&body).expect("accepted");
    b.sync(&relay);
    assert_eq!(
        b.group(&GROUP).map(|g| (g.epoch, g.pending_commit)),
        Some((4, 0))
    );
    b.check_columns("an own commit's echo");
    a.sync(&relay);
    a.check_columns("Bob's commit");

    // A resync begun and discarded, then completed.
    b.core
        .group_join_external(
            &GROUP,
            Some(&COMMUNITY),
            &CHANNEL,
            POLICY,
            &relay.info_body(),
            &relay.tree_body(),
        )
        .expect("resync body");
    b.check_columns("a resync begun");
    b.core.group_discard(&GROUP).expect("discard");
    assert_eq!(
        b.group(&GROUP)
            .map(|g| (g.state, g.epoch, g.pending_commit)),
        Some((3, 0, 0))
    );
    b.check_columns("a discarded resync");
    b.join_external(&mut relay);
    b.check_columns("a completed resync");
    a.sync(&relay);
    a.check_columns("Bob's resync");

    // A Welcome, a removal, and a discarded rejoin of the gone row.
    let mut c = ready_core(0xc3, "carol");
    let kp = c.first_key_package();
    instance.propose_add(&mut relay, &kp);
    a.sync(&relay);
    a.commit(&mut relay);
    let outcomes = decode_outcomes(
        &c.core
            .welcomes_apply(
                &relay.welcomes_body(c.device),
                &expected_body(&[(GROUP, COMMUNITY, CHANNEL, POLICY)]),
            )
            .expect("welcomes_apply"),
    );
    assert_eq!(outcomes[0].outcome, 0);
    c.check_columns("welcomes_apply");
    b.sync(&relay);
    instance.propose_remove(&mut relay, b.device);
    a.sync(&relay);
    a.commit(&mut relay);
    assert_eq!(b.sync(&relay).state, 4);
    assert_eq!(
        b.group(&GROUP)
            .map(|g| (g.state, g.epoch, g.pending_commit)),
        Some((4, 0, 0))
    );
    b.check_columns("the removal");
    b.core
        .group_join_external(
            &GROUP,
            Some(&COMMUNITY),
            &CHANNEL,
            POLICY,
            &relay.info_body(),
            &relay.tree_body(),
        )
        .expect("rejoin body");
    b.check_columns("a rejoin begun");
    b.core.group_discard(&GROUP).expect("discard");
    assert_eq!(b.group(&GROUP).map(|g| (g.state, g.epoch)), Some((4, 0)));
    b.check_columns("a discarded rejoin");

    // Nothing above lives only in the cache.
    let before = groups(&a.core);
    let a = a.reopen();
    assert_eq!(groups(&a.core), before);
    a.check_columns("a reload");
}

/// L-CORE-21: groups(), group_row and cursor_body answer from app_groups even when the stored
/// MLS group is gone (web-1 loaded it and answered epoch 0 or an error).
#[test]
fn groups_and_the_cursor_body_read_the_row_without_loading_the_mls_group() {
    let (_instance, _relay, a, _b) = alice_and_bob();
    let a = a.reopen();
    let head = a.group(&GROUP).expect("row").next_seq - 1;
    a.probe
        .lock()
        .expect("lock")
        .execute("DELETE FROM openmls_group_data", [])
        .expect("drop the stored MLS group");
    assert_eq!(
        a.group(&GROUP)
            .map(|g| (g.state, g.epoch, g.pending_commit)),
        Some((2, 1, 0)),
        "groups() is a query over app_groups"
    );
    assert_eq!(group_row_of(&a.core, &GROUP), a.group(&GROUP));
    assert_eq!(group_row_of(&a.core, &OTHER_GROUP), None);
    assert_eq!(a.core.group_row(&OTHER_GROUP).expect("group_row"), [0xf6]);
    assert_eq!(
        cursor(&a.core),
        Some((head, 1)),
        "cursor_body reads app_groups.epoch"
    );
}

/// L-CORE-21: after a discarded resync the state-3 row has no stored MLS group and epoch 0, and
/// cursor_body answers [next_seq − 1, 0] from the row (web-1 answered E_CORE_STATE "group state 3").
/// Pinned so the change is deliberate.
#[test]
fn a_discarded_resync_answers_the_cursor_from_the_row_with_epoch_0() {
    let (_instance, mut relay, mut a, mut b) = alice_and_bob();
    a.send(&mut relay, &GROUP, "before the resync", NOW + 1);
    b.sync(&relay);
    b.core
        .group_join_external(
            &GROUP,
            Some(&COMMUNITY),
            &CHANNEL,
            POLICY,
            &relay.info_body(),
            &relay.tree_body(),
        )
        .expect("resync body");
    b.core.group_discard(&GROUP).expect("discard");
    let row = b.group(&GROUP).expect("the row stays");
    assert_eq!((row.state, row.epoch, row.pending_commit), (3, 0, 0));
    assert!(
        row.next_seq > 2,
        "Bob applied Alice's message before the resync"
    );
    assert_eq!(cursor(&b.core), Some((row.next_seq - 1, 0)));
    b.check_columns("a discarded resync");
}

#[test]
fn a_deleted_frame_clears_a_stored_row() {
    let (_instance, mut relay, mut a, mut b) = alice_and_bob();
    let (_, s) = b.send(&mut relay, &GROUP, "take this back", NOW + 1);
    a.sync(&relay);
    let stored = a.timeline(&GROUP).pop().expect("row");
    assert_eq!(
        (stored.seq, stored.status, stored.body.as_str()),
        (s, 0, "take this back")
    );
    let before = a.group(&GROUP).expect("row").next_seq;

    // (a) The stored row is cleared and listed; the cursor does not move.
    let cleared = decode_applied(&a.core.message_deleted(&GROUP, s).expect("message_deleted"));
    assert_eq!(cleared.new_seqs, vec![s]);
    assert_eq!(cleared.next_seq, before, "next_seq is not touched");
    assert_eq!(
        (
            cleared.state,
            cleared.epoch,
            cleared.proposals_pending,
            cleared.flags
        ),
        (2, 1, 0, 0)
    );
    let row = a.timeline(&GROUP).pop().expect("row");
    assert_eq!(
        (row.seq, row.status, row.body.as_str(), row.reason.as_str()),
        (s, 2, "", "")
    );
    assert_eq!(row.sender_device, b.device, "the sender columns are kept");
    let envelope_cleared: i64 = a
        .probe
        .lock()
        .expect("probe")
        .query_row(
            "SELECT envelope IS NULL FROM app_messages WHERE group_id = ?1 AND seq = ?2",
            rusqlite::params![GROUP.as_slice(), sql_seq(s)],
            |r| r.get(0),
        )
        .expect("the row");
    assert_eq!(envelope_cleared, 1, "the envelope and its k_f are gone");

    // (b) The same frame again changes nothing.
    let again = decode_applied(&a.core.message_deleted(&GROUP, s).expect("again"));
    assert!(
        again.new_seqs.is_empty(),
        "an already deleted row is not listed again"
    );
    assert_eq!(again.next_seq, before);

    // (c) A seq this device has not fetched inserts nothing.
    let unfetched = decode_applied(
        &a.core
            .message_deleted(&GROUP, s + 100)
            .expect("unfetched seq"),
    );
    assert!(unfetched.new_seqs.is_empty());
    assert_eq!(unfetched.next_seq, before);
    let inserted: i64 = a
        .probe
        .lock()
        .expect("probe")
        .query_row(
            "SELECT count(*) FROM app_messages WHERE group_id = ?1 AND seq = ?2",
            rusqlite::params![GROUP.as_slice(), sql_seq(s + 100)],
            |r| r.get(0),
        )
        .expect("count");
    assert_eq!(inserted, 0, "no row is inserted for an unfetched seq");

    // (d) An unknown group.
    assert_eq!(
        code(a.core.message_deleted(&OTHER_GROUP, s)),
        "E_CORE_NOT_FOUND"
    );
}

// ---------------------------------------------------------------------------------------------
// L-CORE-10: the parity fixture, asserted against the real core.

/// The common start of every parity case: "me" created and registered GROUP (the relay answers
/// next_seq = 1), a raw peer joined by external commit at seq 1, and "me" applied it.
fn parity_start() -> (Instance, Relay, Core, RawPeer) {
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
    let row = me.group(&GROUP).expect("row");
    assert_eq!(
        (
            row.state,
            row.epoch,
            row.next_seq,
            row.proposals_pending,
            row.pending_commit
        ),
        (2, 1, 2, 0, 0),
        "the common start"
    );
    assert!(me.outbox(&GROUP).is_empty());
    (instance, relay, me, peer)
}

/// The stream a row kind of the fixture belongs to.
fn stream_of(what: &str) -> &'static str {
    match what {
        "peer-commit" | "bad-commit" | "add-proposal" => "h",
        "peer-message" | "own-echo" | "pruned" | "deleted" => "m",
        other => panic!("unknown row kind {other}"),
    }
}

/// Builds one fixture row on the relay; answers the seq the relay gave it.
fn build_row(
    what: &str,
    instance: &Instance,
    relay: &mut Relay,
    me: &mut Core,
    peer: &mut RawPeer,
) -> u64 {
    match what {
        "peer-message" => peer.send(relay, "parity"),
        "peer-commit" => peer.self_update(relay),
        "bad-commit" => relay.push_handshake(1, vec![0xde, 0xad]),
        "own-echo" => {
            let msg_id = me.prepare(&GROUP, "parity echo", NOW);
            let (_, body) = me.encrypt(&msg_id);
            seq_of_answer(&relay.post_message(me.device, &body).expect("upload"))
        }
        "pruned" => {
            let epoch = relay.epoch();
            seq_of_answer(&relay.push_message(peer.device, epoch, None, false))
        }
        "deleted" => {
            let epoch = relay.epoch();
            seq_of_answer(&relay.push_message(peer.device, epoch, None, true))
        }
        "add-proposal" => {
            let mut third = ready_core(0xc3, "carol");
            let kp = third.first_key_package();
            instance.propose_add(relay, &kp)
        }
        other => panic!("unknown row kind {other}"),
    }
}

#[test]
fn the_parity_fixture_holds() {
    let fixture: serde_json::Value =
        serde_json::from_str(include_str!("fixtures/group_apply_parity.json"))
            .expect("fixture JSON");
    assert_eq!(fixture["v"].as_u64(), Some(1));
    let cases = fixture["cases"].as_array().expect("cases");
    assert_eq!(cases.len(), 8, "the eight cases of L-CORE-10");

    for case in cases {
        let name = case["name"].as_str().expect("name");
        let rows: Vec<(String, u64, String)> = case["rows"]
            .as_array()
            .expect("rows")
            .iter()
            .map(|r| {
                (
                    r["stream"].as_str().expect("stream").to_owned(),
                    r["seq"].as_u64().expect("seq"),
                    r["what"].as_str().expect("what").to_owned(),
                )
            })
            .collect();
        let through = case["through"].as_u64().expect("through");

        let (instance, mut relay, mut me, mut peer) = parity_start();
        let mut by_seq = rows.clone();
        by_seq.sort_by_key(|r| r.1);
        for (stream, seq, what) in &by_seq {
            assert_eq!(
                stream.as_str(),
                stream_of(what),
                "case {name}: stream of {what}"
            );
            let got = build_row(what, &instance, &mut relay, &mut me, &mut peer);
            assert_eq!(got, *seq, "case {name}: {what} lands at seq {seq}");
        }

        let mut hs: Vec<HsRow> = Vec::new();
        let mut ms: Vec<MsgRow> = Vec::new();
        for (stream, seq, _) in &rows {
            match stream.as_str() {
                "h" => hs.push(
                    relay
                        .handshakes
                        .iter()
                        .find(|h| h.seq == *seq)
                        .expect("handshake row")
                        .clone(),
                ),
                _ => ms.push(
                    relay
                        .messages
                        .iter()
                        .find(|m| m.seq == *seq)
                        .expect("message row")
                        .clone(),
                ),
            }
        }
        let hs_refs: Vec<&HsRow> = hs.iter().collect();
        let ms_refs: Vec<&MsgRow> = ms.iter().collect();
        let bytes = me
            .core
            .group_apply(
                &GROUP,
                &encode_handshakes(&hs_refs),
                &encode_messages(&ms_refs),
                through,
            )
            .expect("group_apply");

        let e = &case["expect"];
        let expect = Applied {
            state: e["state"].as_u64().expect("state"),
            epoch: e["epoch"].as_u64().expect("epoch"),
            next_seq: e["next_seq"].as_u64().expect("next_seq"),
            new_seqs: e["new_seqs"]
                .as_array()
                .expect("new_seqs")
                .iter()
                .map(|v| v.as_u64().expect("a seq"))
                .collect(),
            proposals_pending: e["proposals_pending"].as_u64().expect("proposals_pending"),
            flags: e["flags"].as_u64().expect("flags"),
        };
        assert_eq!(
            decode_applied(&bytes),
            expect,
            "case {name}: the decoded tuple"
        );
        assert_eq!(
            hex::encode(&bytes),
            case["result"].as_str().expect("result"),
            "case {name}: the returned bytes"
        );
    }
}

fn flagged_seqs(core: &Core, group: &[u8; 16]) -> Vec<u64> {
    let c = core.probe.lock().expect("lock");
    let mut stmt = c
        .prepare("SELECT seq FROM app_messages WHERE group_id = ?1 AND mention = 1 ORDER BY seq")
        .expect("prepare");
    stmt.query_map([group.as_slice()], |r| r.get::<_, i64>(0))
        .expect("query")
        .map(|s| s.map(|s| s as u64))
        .collect::<Result<Vec<_>, _>>()
        .expect("rows")
}

fn read_marker(core: &Core, group: &[u8; 16]) -> Option<(i64, i64)> {
    use rusqlite::OptionalExtension;
    let c = core.probe.lock().expect("lock");
    c.query_row(
        "SELECT last_read_seq, last_read_at FROM app_read_state WHERE group_id = ?1",
        [group.as_slice()],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )
    .optional()
    .expect("app_read_state")
}

/// The own user's rows are excluded by user (ruling 29): Alice's confirmed message from this device
/// and a mentioning message from Alice's other device (user 0xa1, device 0x5e) neither count nor
/// carry the flag; the other user's status-0 type-0 rows after the marker do.
#[test]
fn activity_excludes_the_own_users_rows_from_this_device_and_from_another_device() {
    let instance = Instance::generate();
    let mut relay = Relay::new(GROUP);
    let mut a = ready_core(0xa1, "alice");
    a.create_and_register(&mut relay, &instance);
    let alice = "a1".repeat(16);
    // Alice's other browser joins first and sends at its epoch, before Bob's peer joins.
    let mut twin = RawPeer::new(0xa1, 0x5e);
    twin.join_external(&mut relay);
    let twin_named = twin.send(&mut relay, &format!("from my other browser <@{alice}>"));
    let mut peer = RawPeer::new(0xe5, 0xe6);
    peer.join_external(&mut relay);
    a.sync(&relay);
    let twin_row: (Vec<u8>, Vec<u8>, i64, i64) = a
        .probe
        .lock()
        .expect("lock")
        .query_row(
            "SELECT sender_user, sender_device, status, type FROM app_messages \
             WHERE group_id = ?1 AND seq = ?2",
            rusqlite::params![GROUP.as_slice(), twin_named as i64],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .expect("the other device's row");
    assert_eq!(
        twin_row,
        (vec![0xa1; 16], vec![0x5e; 16], 0, 0),
        "a readable type-0 row of the own user from another device"
    );
    let plain = peer.send(&mut relay, "plain");
    let named = peer.send(&mut relay, &format!("hi <@{alice}>"));
    let shouted = peer.send(&mut relay, &format!("hi <@{}>", "A1".repeat(16)));
    let everyone = peer.send(&mut relay, "<@everyone> standup");
    let here = peer.send(&mut relay, "anyone <@here>");
    let edit = peer.send_typed(
        &mut relay,
        EnvelopeType::Edit,
        &format!("edited <@{alice}>"),
    );
    let epoch = relay.epoch();
    let pruned = seq_of_answer(&relay.push_message(peer.device, epoch, None, false));
    a.send(
        &mut relay,
        &GROUP,
        &format!("note to self <@{alice}>"),
        NOW + 1,
    );
    a.sync(&relay);
    assert!(twin_named < plain);
    assert!(plain < named && named < shouted && shouted < everyone && everyone < here);
    assert!(here < edit && edit < pruned);

    let first = Activity {
        group_id: GROUP,
        unread: 5,
        mentions: 3,
        last_seq: here,
        last_ts: NOW + here,
        last_read_seq: 0,
    };
    assert_eq!(
        activity(&a.core),
        vec![first.clone()],
        "the own user's rows (this device and the other device), the type-1 row and the unreadable row are not counted"
    );
    assert_eq!(
        flagged_seqs(&a, &GROUP),
        vec![named, everyone, here],
        "only status-0 type-0 rows of other users carry the flag; the other device's mention does not"
    );

    a.core
        .mark_read(&GROUP, named, NOW + 10)
        .expect("mark_read");
    assert_eq!(
        activity(&a.core),
        vec![Activity {
            unread: 3,
            mentions: 2,
            last_read_seq: named,
            ..first.clone()
        }]
    );
    a.core
        .mark_read(&GROUP, plain, NOW + 11)
        .expect("an older marker");
    assert_eq!(
        activity(&a.core)[0].last_read_seq,
        named,
        "the marker never moves back"
    );
    assert_eq!(
        read_marker(&a, &GROUP),
        Some((named as i64, (NOW + 11) as i64))
    );
    a.core
        .mark_read(&GROUP, u64::MAX, NOW + 12)
        .expect("beyond the head");
    let head = a.group(&GROUP).expect("row").next_seq - 1;
    assert_eq!(
        activity(&a.core),
        vec![Activity {
            group_id: GROUP,
            unread: 0,
            mentions: 0,
            last_seq: 0,
            last_ts: 0,
            last_read_seq: head
        }],
        "clamped to next_seq - 1"
    );
    assert_eq!(
        code(a.core.mark_read(&GROUP, 1, u64::MAX)),
        "E_CORE_INPUT",
        "now out of range"
    );
    let _ = shouted;
}

#[test]
fn mark_read_and_activity_follow_the_group_states_and_the_phase() {
    let (instance, mut relay, mut a, mut b) = alice_and_bob();

    // A registering group may be marked (clamped to 0) and is not listed; a discard takes the marker.
    a.core
        .group_create(
            &OTHER_GROUP,
            Some(&COMMUNITY),
            &OTHER_CHANNEL,
            POLICY,
            &instance.public(),
        )
        .expect("group_create");
    a.core
        .mark_read(&OTHER_GROUP, 5, NOW)
        .expect("state 0 may be marked");
    assert_eq!(read_marker(&a, &OTHER_GROUP), Some((0, NOW as i64)));
    assert_eq!(
        activity(&a.core)
            .iter()
            .map(|r| r.group_id)
            .collect::<Vec<_>>(),
        vec![GROUP]
    );
    a.core.group_discard(&OTHER_GROUP).expect("discard");
    assert_eq!(
        read_marker(&a, &OTHER_GROUP),
        None,
        "a discarded group's marker goes with it"
    );

    // Two active groups are listed in group_id order.
    let mut other = Relay::new(OTHER_GROUP);
    let body = a
        .core
        .group_create(
            &OTHER_GROUP,
            Some(&COMMUNITY),
            &OTHER_CHANNEL,
            POLICY,
            &instance.public(),
        )
        .expect("group_create");
    let created = other.register(&body).expect("register");
    let next_seq = decode_strict(&created, |d| {
        d.array(2)?;
        d.bytes_exact::<16>()?;
        d.uint()
    })
    .expect("201 body");
    a.core
        .group_registered(&OTHER_GROUP, next_seq)
        .expect("group_registered");
    assert_eq!(
        activity(&a.core)
            .iter()
            .map(|r| r.group_id)
            .collect::<Vec<_>>(),
        vec![GROUP, OTHER_GROUP]
    );

    // A gone group is not listed and cannot be marked.
    instance.propose_remove(&mut relay, b.device);
    a.sync(&relay);
    a.commit(&mut relay);
    assert_eq!(b.sync(&relay).state, 4);
    assert!(activity(&b.core).is_empty());
    assert_eq!(
        b.core.mark_read(&GROUP, 1, NOW),
        Err(ClientError {
            code: "E_CORE_STATE",
            detail: "group state 4".into()
        })
    );
    assert_eq!(
        code(a.core.mark_read(&[0x77; 16], 1, NOW)),
        "E_CORE_NOT_FOUND"
    );

    // Without an identity there is no own user to exclude.
    let mut fresh = ClientCore::open(memory()).expect("open");
    assert_eq!(code(fresh.activity()), "E_CORE_NO_IDENTITY");
    assert_eq!(code(fresh.mark_read(&GROUP, 1, NOW)), "E_CORE_NO_IDENTITY");
}

#[test]
fn settings_are_bounded_ordered_and_answer_in_every_phase() {
    let conn = memory();
    let probe = std::sync::Arc::clone(&conn);
    let mut core = ClientCore::open(conn).expect("open");
    assert!(settings_of(&core).is_empty());
    core.setting_put("b", "2").expect("phase 0");
    core.setting_put("a", "").expect("an empty value");
    core.setting_put("b", "two").expect("upsert");
    assert_eq!(
        settings_of(&core),
        vec![
            ("a".to_owned(), String::new()),
            ("b".to_owned(), "two".to_owned())
        ]
    );
    core.signup_begin(&INSTANCE).expect("phase 1");
    core.setting_put("c", "3").expect("phase 1");
    core.signup_complete(&[0x42; 16], "alice", NOW)
        .expect("phase 2");
    core.setting_delete("a").expect("delete");
    core.setting_delete("absent").expect("absent is a no-op");
    let key = "k".repeat(128);
    let value = "v".repeat(1024);
    core.setting_put(&key, &value).expect("at the bounds");
    let bad_key = ClientError {
        code: "E_CORE_INPUT",
        detail: "key must be 1..=128 bytes".into(),
    };
    for k in [String::new(), "k".repeat(129), "é".repeat(65)] {
        assert_eq!(
            core.setting_put(&k, "x"),
            Err(bad_key.clone()),
            "{} bytes",
            k.len()
        );
    }
    let bad_value = ClientError {
        code: "E_CORE_INPUT",
        detail: "value must be at most 1024 bytes".into(),
    };
    assert_eq!(
        core.setting_put("d", &"v".repeat(1025)),
        Err(bad_value.clone())
    );
    assert_eq!(core.setting_put("d", &"é".repeat(513)), Err(bad_value));
    drop(core);
    let core = ClientCore::open(probe).expect("reopen");
    assert_eq!(
        settings_of(&core),
        vec![
            ("b".to_owned(), "two".to_owned()),
            ("c".to_owned(), "3".to_owned()),
            (key, value)
        ]
    );
}
