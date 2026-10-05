// Native only, like tests/mls_roundtrip.rs: every test opens an in-memory SQLite connection.
#![cfg(not(target_arch = "wasm32"))]

//! The hardening wave after the task 5 security review (`.superpowers/sdd/2026-10-05-dilla-web-1/
//! task-5-security-review.md`): each test states the behaviour a finding asked for, with the
//! finding's number in its comment.

mod client_support;

use client_support::*;
use dilla_core::cbor::{Encoder, decode_strict};

/// The 200 body of POST …/message, as a delivery service would answer it for `seq`.
fn answer_at(seq: u64) -> Vec<u8> {
    let mut e = Encoder::new();
    e.array(3).uint(seq).bytes(&[seq as u8; 32]).uint(NOW + seq);
    e.into_vec()
}

fn row_at(relay: &Relay, seq: u64) -> MsgRow {
    relay
        .messages
        .iter()
        .find(|m| m.seq == seq)
        .expect("a relay row")
        .clone()
}

fn apply(core: &mut Core, messages: &[&MsgRow], through: u64) -> Applied {
    decode_applied(
        &core
            .core
            .group_apply(&GROUP, &[0x80], &encode_messages(messages), through)
            .expect("group_apply"),
    )
}

/// The last-resort KeyPackage `MLSMessage` of a fresh `key_packages(1, true)` call.
fn last_resort_key_package(core: &mut Core) -> Vec<u8> {
    let body = core.core.key_packages(1, true).expect("key_packages");
    decode_strict(&body, |d| {
        d.array(2)?;
        d.array(1)?;
        d.bytes()?;
        Ok(d.bytes()?.to_vec())
    })
    .expect("POST /v1/keypackages body")
}

// ---------------------------------------------------------------------------------------------
// F2: a row at a (group, seq) that already holds a row is skipped, and next_seq never moves back.

#[test]
fn a_foreign_message_served_at_a_seq_already_stored_is_skipped_before_it_is_decrypted() {
    let (_instance, mut relay, mut a, mut b) = alice_and_bob();
    let (_, mine) = b.send(&mut relay, &GROUP, "mine", NOW + 1);
    let (_, theirs) = a.send(&mut relay, &GROUP, "theirs", NOW + 2);
    // The delivery service serves Alice's real ciphertext again, labelled with Bob's own seq.
    let replayed = MsgRow {
        seq: mine,
        ..row_at(&relay, theirs)
    };

    for _ in 0..2 {
        let applied = apply(&mut b, &[&replayed], mine);
        assert_eq!(applied.state, 2);
        assert!(applied.new_seqs.is_empty(), "a skipped row is not listed");
        assert_eq!(applied.next_seq, mine + 1);
    }
    let rows = b.timeline(&GROUP);
    assert_eq!(rows.len(), 1);
    assert_eq!(
        (rows[0].seq, rows[0].status, rows[0].body.as_str()),
        (mine, 0, "mine"),
        "the stored own row is intact"
    );

    // No ratchet step was spent on the skipped copy: the real row still decrypts.
    let applied = b.sync(&relay);
    assert_eq!(applied.new_seqs, vec![theirs]);
    let row = b.timeline(&GROUP).pop().expect("row");
    assert_eq!(
        (row.status, row.body.as_str()),
        (0, "theirs"),
        "reason {:?}",
        row.reason
    );
}

#[test]
fn a_pruned_row_served_at_a_seq_already_stored_is_skipped() {
    let (_instance, mut relay, a, mut b) = alice_and_bob();
    let (_, mine) = b.send(&mut relay, &GROUP, "mine", NOW + 1);
    let pruned = MsgRow {
        seq: mine,
        epoch: 1,
        uploader: a.device,
        blob: None,
        commitment: None,
        franking_tag: [0x01; 32],
        recv_ts: NOW,
        deleted: false,
    };
    let applied = apply(&mut b, &[&pruned], mine);
    assert!(applied.new_seqs.is_empty());
    assert_eq!(applied.next_seq, mine + 1);
    assert_eq!(
        b.timeline(&GROUP)
            .into_iter()
            .map(|r| (r.seq, r.status, r.body))
            .collect::<Vec<_>>(),
        vec![(mine, 0, "mine".to_owned())]
    );
}

#[test]
fn group_joined_never_moves_next_seq_back() {
    let (_instance, mut relay, mut a, mut b) = alice_and_bob();
    for i in 0..4 {
        a.send(&mut relay, &GROUP, "filler", NOW + i);
    }
    let head = b.sync(&relay).next_seq;
    assert!(head > 2);

    let body = b
        .core
        .group_join_external(
            &GROUP,
            &COMMUNITY,
            &CHANNEL,
            POLICY,
            &relay.info_body(),
            &relay.tree_body(),
        )
        .expect("resync body");
    relay.resync(&body).expect("resync");
    // A 200 body whose seq lies below what this device already applied.
    b.core.group_joined(&GROUP, 1).expect("group_joined");
    let row = b.group(&GROUP).expect("row");
    assert_eq!(row.state, 2);
    assert_eq!(row.next_seq, head, "next_seq is not lowered");
}

#[test]
fn a_welcome_over_a_stale_row_never_moves_next_seq_back() {
    let (instance, mut relay, mut a, mut c) = carol_added();
    for i in 0..3 {
        a.send(&mut relay, &GROUP, "filler", NOW + i);
    }
    instance.propose_remove(&mut relay, c.device);
    a.sync(&relay);
    a.commit(&mut relay);
    let gone = c.sync(&relay);
    assert_eq!(gone.state, 4);

    // Carol is admitted again; the server labels the new Welcome with a commit_seq far below.
    let kp = c.first_key_package();
    instance.propose_add(&mut relay, &kp);
    a.sync(&relay);
    a.commit(&mut relay);
    let mut latest = relay.welcomes.last().expect("the new Welcome").clone();
    latest.commit_seq = 1;
    relay.welcomes = vec![latest];
    let again = c
        .core
        .welcomes_apply(
            &relay.welcomes_body(c.device),
            &expected_body(&[(GROUP, COMMUNITY, CHANNEL, POLICY)]),
        )
        .expect("welcomes_apply");
    assert_eq!(decode_outcomes(&again)[0].outcome, 0);
    let row = c.group(&GROUP).expect("row");
    assert_eq!(
        (row.state, row.next_seq),
        (2, gone.next_seq),
        "next_seq is not lowered"
    );
}

/// Alice creates GROUP; the instance adds Carol's last-resort KeyPackage (kept by OpenMLS after
/// use, so the Welcome stays openable) and Alice commits it; Carol joins at epoch 1.
fn carol_added() -> (Instance, Relay, Core, Core) {
    let instance = Instance::generate();
    let mut relay = Relay::new(GROUP);
    let mut a = ready_core(0xa1, "alice");
    a.create_and_register(&mut relay, &instance);
    let mut c = ready_core(0xc3, "carol");
    let kp = last_resort_key_package(&mut c);
    instance.propose_add(&mut relay, &kp);
    a.sync(&relay);
    a.commit(&mut relay);
    let joined = c
        .core
        .welcomes_apply(
            &relay.welcomes_body(c.device),
            &expected_body(&[(GROUP, COMMUNITY, CHANNEL, POLICY)]),
        )
        .expect("welcomes_apply");
    assert_eq!(decode_outcomes(&joined)[0].outcome, 0);
    assert_eq!(c.group(&GROUP).map(|g| g.epoch), Some(1));
    (instance, relay, a, c)
}

// ---------------------------------------------------------------------------------------------
// F7: an in-flight row whose seq is already occupied never blocks the group's sends.

#[test]
fn an_own_upload_deleted_before_its_echo_leaves_the_outbox_and_a_late_confirm_reads_it_back() {
    let (_instance, mut relay, mut a, _b) = alice_and_bob();
    let msg_id = a.prepare(&GROUP, "regret", NOW + 1);
    let (_, body) = a.encrypt(&msg_id);
    let answer = relay.post_message(a.device, &body).expect("upload");
    let seq = seq_of_answer(&answer);
    relay.delete_message(seq); // another device of Alice's deletes it before this one hears back

    let applied = a.sync(&relay);
    assert_eq!(applied.new_seqs, vec![seq]);
    assert_eq!(
        applied.flags & OWN_ADOPTED,
        OWN_ADOPTED,
        "the in-flight row was resolved by its echo"
    );
    assert!(a.outbox(&GROUP).is_empty(), "nothing is left to resend");
    let row = a.timeline(&GROUP).pop().expect("row");
    assert_eq!(
        (row.seq, row.status, row.body.as_str(), row.sender_device),
        (seq, 2, "", a.device)
    );
    assert_eq!(row.msg_id, Some(msg_id));

    // The late answer reads the row back.
    assert_eq!(
        decode_confirm(&a.core.send_confirm(&msg_id, &answer).expect("confirm")),
        (GROUP, seq)
    );
    a.send(&mut relay, &GROUP, "the group sends on", NOW + 2);
}

#[test]
fn a_late_confirm_at_the_deleted_marker_of_its_own_upload_completes() {
    let (_instance, mut relay, mut a, _b) = alice_and_bob();
    let msg_id = a.prepare(&GROUP, "regret", NOW + 1);
    let (_, body) = a.encrypt(&msg_id);
    let answer = relay.post_message(a.device, &body).expect("upload");
    let seq = seq_of_answer(&answer);
    relay.delete_message(seq);
    // The marker arrives without a commitment, so it cannot be tied to the upload in flight.
    let marker = MsgRow {
        commitment: None,
        ..row_at(&relay, seq)
    };
    let applied = apply(&mut a, &[&marker], seq);
    assert_eq!(applied.new_seqs, vec![seq]);
    assert_eq!(applied.flags & OWN_ADOPTED, 0);
    assert_eq!(a.outbox(&GROUP)[0].state, 1, "still in flight");

    assert_eq!(
        decode_confirm(&a.core.send_confirm(&msg_id, &answer).expect("confirm")),
        (GROUP, seq)
    );
    assert!(
        a.outbox(&GROUP).is_empty(),
        "the server stored it: never resent"
    );
    let row = a.timeline(&GROUP).pop().expect("row");
    assert_eq!((row.seq, row.status, row.body.as_str()), (seq, 2, ""));
    a.send(&mut relay, &GROUP, "the group sends on", NOW + 2);
}

#[test]
fn a_confirm_at_a_seq_holding_another_message_fails_the_row_and_the_group_sends_on() {
    let (_instance, mut relay, mut a, mut b) = alice_and_bob();
    let (_, theirs) = b.send(&mut relay, &GROUP, "theirs", NOW + 1);
    a.sync(&relay);
    let msg_id = a.prepare(&GROUP, "mine", NOW + 2);
    a.encrypt(&msg_id);

    // A 200 body naming a seq that already holds Bob's message.
    let err = a
        .core
        .send_confirm(&msg_id, &answer_at(theirs))
        .expect_err("the seq is taken");
    assert_eq!(err.code, "E_CORE_STATE");
    let outbox = a.outbox(&GROUP);
    assert_eq!(
        (outbox[0].msg_id, outbox[0].state, outbox[0].error.as_str()),
        (msg_id, 2, "E_CORE_STATE"),
        "failed, not in flight and not requeued"
    );
    let row = a.timeline(&GROUP).pop().expect("row");
    assert_eq!(
        (row.seq, row.body.as_str()),
        (theirs, "theirs"),
        "the stored row is kept"
    );
    a.send(&mut relay, &GROUP, "the group sends on", NOW + 3);
}

// ---------------------------------------------------------------------------------------------
// F5: an own echo is adopted only for the outbox row whose envelope commitment it carries (the
// row in flight, or an unresolved earlier one: follow-up ruling).

#[test]
fn the_echo_of_an_earlier_upload_is_adopted_as_that_upload_not_as_the_message_in_flight() {
    let (_instance, mut relay, _a, mut b) = alice_and_bob();
    // A is stored by the server, but a proxy answers 502: the engine fails A and sends B.
    let first = b.prepare(&GROUP, "first", NOW + 1);
    let (_, body) = b.encrypt(&first);
    let stored = seq_of_answer(&relay.post_message(b.device, &body).expect("upload"));
    b.core.send_fail(&first, "E_HTTP_502").expect("fail");
    let second = b.prepare(&GROUP, "second", NOW + 2);
    let (_, body) = b.encrypt(&second);

    let applied = b.sync(&relay);
    assert_eq!(applied.new_seqs, vec![stored]);
    assert_eq!(
        applied.flags & OWN_ADOPTED,
        OWN_ADOPTED,
        "A's echo resolves A"
    );
    let rows = b.timeline(&GROUP);
    assert_eq!(
        rows.len(),
        1,
        "one stored own message, no E_OWN_UNKNOWN row"
    );
    let row = &rows[0];
    assert_eq!(
        (row.seq, row.status, row.reason.as_str(), row.body.as_str()),
        (stored, 0, "", "first")
    );
    assert_eq!(row.msg_id, Some(first));
    let states: Vec<([u8; 16], u64)> = b
        .outbox(&GROUP)
        .into_iter()
        .map(|o| (o.msg_id, o.state))
        .collect();
    assert_eq!(
        states,
        vec![(second, 1)],
        "A is not left to retry; B stays in flight"
    );

    // B's own echo is adopted at its own seq.
    let seq = seq_of_answer(&relay.post_message(b.device, &body).expect("upload"));
    let applied = b.sync(&relay);
    assert_eq!(applied.flags & OWN_ADOPTED, OWN_ADOPTED);
    let row = b.timeline(&GROUP).pop().expect("row");
    assert_eq!((row.seq, row.status, row.body.as_str()), (seq, 0, "second"));
}

#[test]
fn a_failed_row_whose_commitment_no_echo_carries_is_untouched() {
    let (_instance, mut relay, _a, mut b) = alice_and_bob();
    // A was never stored: the request did not reach the server.
    let first = b.prepare(&GROUP, "first", NOW + 1);
    b.encrypt(&first);
    b.core.send_fail(&first, "E_NETWORK").expect("fail");
    // B's echo, and an own upload this device cannot place, arrive.
    let second = b.prepare(&GROUP, "second", NOW + 2);
    let (_, body) = b.encrypt(&second);
    let seq = seq_of_answer(&relay.post_message(b.device, &body).expect("upload"));
    let epoch = relay.epoch();
    let unknown =
        seq_of_answer(&relay.push_message(b.device, epoch, Some(vec![0x00, 0x01]), false));

    let applied = b.sync(&relay);
    assert_eq!(applied.new_seqs, vec![seq, unknown]);
    let rows: Vec<(u64, u64, String)> = b
        .timeline(&GROUP)
        .into_iter()
        .map(|r| (r.seq, r.status, r.body))
        .collect();
    assert_eq!(
        rows,
        vec![(seq, 0, "second".to_owned()), (unknown, 1, String::new())]
    );
    let outbox = b.outbox(&GROUP);
    assert_eq!(
        outbox
            .iter()
            .map(|o| (o.msg_id, o.state, o.error.as_str()))
            .collect::<Vec<_>>(),
        vec![(first, 2, "E_NETWORK")],
        "A stays failed, for the person to retry"
    );
}

#[test]
fn the_deleted_echo_of_a_failed_upload_resolves_it() {
    let (_instance, mut relay, _a, mut b) = alice_and_bob();
    let first = b.prepare(&GROUP, "regret", NOW + 1);
    let (_, body) = b.encrypt(&first);
    let stored = seq_of_answer(&relay.post_message(b.device, &body).expect("upload"));
    b.core.send_fail(&first, "E_HTTP_502").expect("fail");
    relay.delete_message(stored);

    let applied = b.sync(&relay);
    assert_eq!(applied.flags & OWN_ADOPTED, OWN_ADOPTED);
    assert!(b.outbox(&GROUP).is_empty(), "nothing is left to retry");
    let row = b.timeline(&GROUP).pop().expect("row");
    assert_eq!((row.seq, row.status, row.msg_id), (stored, 2, Some(first)));
}

#[test]
fn an_own_echo_without_a_served_commitment_is_judged_by_its_ciphertext() {
    let (_instance, mut relay, _a, mut b) = alice_and_bob();
    let first = b.prepare(&GROUP, "first", NOW + 1);
    let (_, body) = b.encrypt(&first);
    let stored = seq_of_answer(&relay.post_message(b.device, &body).expect("upload"));
    // A live op-19 frame carries no commitment: the one in the blob's authenticated data counts.
    let live = MsgRow {
        commitment: None,
        ..row_at(&relay, stored)
    };
    b.core.send_fail(&first, "E_HTTP_502").expect("fail");
    let second = b.prepare(&GROUP, "second", NOW + 2);
    let (_, body) = b.encrypt(&second);
    let applied = apply(&mut b, &[&live], stored);
    assert_eq!(
        applied.flags & OWN_ADOPTED,
        OWN_ADOPTED,
        "the failed first row is resolved"
    );
    assert_eq!(
        b.timeline(&GROUP).pop().map(|r| (r.status, r.body)),
        Some((0, "first".to_owned()))
    );
    assert_eq!(b.outbox(&GROUP).len(), 1, "B stays in flight");

    let seq = seq_of_answer(&relay.post_message(b.device, &body).expect("upload"));
    let live = MsgRow {
        commitment: None,
        ..row_at(&relay, seq)
    };
    let applied = apply(&mut b, &[&live], seq);
    assert_eq!(applied.flags & OWN_ADOPTED, OWN_ADOPTED);
    let row = b.timeline(&GROUP).pop().expect("row");
    assert_eq!((row.seq, row.status, row.body.as_str()), (seq, 0, "second"));
    assert!(b.outbox(&GROUP).is_empty(), "both rows are resolved");

    // A served commitment that names the row in flight does not outvote a ciphertext that
    // carries another one.
    let third = b.prepare(&GROUP, "third", NOW + 3);
    let (_, body) = b.encrypt(&third);
    let in_flight = commitment_of(
        &decode_strict(&body, |d| {
            d.array(2)?;
            d.uint()?;
            Ok(d.bytes()?.to_vec())
        })
        .expect("message body"),
    );
    let mixed = MsgRow {
        seq: seq + 1,
        commitment: in_flight,
        ..row_at(&relay, stored)
    };
    let applied = apply(&mut b, &[&mixed], seq + 1);
    assert_eq!(applied.flags & OWN_ADOPTED, 0);
    assert_eq!(b.outbox(&GROUP).last().map(|o| o.state), Some(1));
}

// ---------------------------------------------------------------------------------------------
// F1: the MLS group id and a stored row's binding are fixed; a stored group must match its row.

/// `core` creates and registers the relay's group, bound to `channel`.
fn register_on(core: &mut Core, relay: &mut Relay, channel: [u8; 16], instance: &Instance) {
    let body = core
        .core
        .group_create(
            &relay.group_id,
            &COMMUNITY,
            &channel,
            POLICY,
            &instance.public(),
        )
        .expect("group_create");
    let created = relay.register(&body).expect("register");
    let next_seq = decode_strict(&created, |d| {
        d.array(2)?;
        d.bytes_exact::<16>()?;
        d.uint()
    })
    .expect("201 body");
    core.core
        .group_registered(&relay.group_id, next_seq)
        .expect("group_registered");
}

#[test]
fn a_group_info_of_another_group_id_is_refused_before_it_is_joined() {
    // OTHER_GROUP is bound to CHANNEL; the join asks for GROUP on OTHER_CHANNEL. Joining first
    // would refuse with the binding; the id is compared before anything is joined or written.
    let instance = Instance::generate();
    let mut relay = Relay::new(OTHER_GROUP);
    let mut creator = ready_core(0xa1, "alice");
    creator.create_and_register(&mut relay, &instance);
    let mut joiner = ready_core(0xb2, "bob");
    let err = joiner
        .core
        .group_join_external(
            &GROUP,
            &COMMUNITY,
            &OTHER_CHANNEL,
            POLICY,
            &relay.info_body(),
            &relay.tree_body(),
        )
        .expect_err("another group's GroupInfo");
    assert_eq!(err.code, "E_CORE_INPUT");
    assert!(!err.detail.is_empty());
    assert!(groups(&joiner.core).is_empty());
}

#[test]
fn an_external_join_never_rebinds_an_existing_row_to_another_channel() {
    let (instance, _relay, _a, mut b) = alice_and_bob();
    // A group with Bob's group id, bound to OTHER_CHANNEL, served for a "resync".
    let mut forged = Relay::new(GROUP);
    let mut carol = ready_core(0xc3, "carol");
    register_on(&mut carol, &mut forged, OTHER_CHANNEL, &instance);
    let before = b.group(&GROUP).expect("row");
    let err = b
        .core
        .group_join_external(
            &GROUP,
            &COMMUNITY,
            &OTHER_CHANNEL,
            POLICY,
            &forged.info_body(),
            &forged.tree_body(),
        )
        .expect_err("the row is bound to CHANNEL");
    assert_eq!(err.code, "E_CORE_STATE");
    assert_eq!(
        b.group(&GROUP),
        Some(before.clone()),
        "row and group unchanged"
    );
    assert_eq!(b.reopen().group(&GROUP), Some(before));
}

#[test]
fn a_welcome_never_rebinds_an_existing_row_to_another_channel() {
    let instance = Instance::generate();
    let mut relay = Relay::new(GROUP);
    let mut peer = RawPeer::new(0xe5, 0xe6);
    peer.create(&mut relay, &instance);
    let mut c = ready_core(0xc3, "carol");
    let kp = c.first_key_package();
    peer.add(&mut relay, &[kp.as_slice()]);
    let joined = c
        .core
        .welcomes_apply(
            &relay.welcomes_body(c.device),
            &expected_body(&[(GROUP, COMMUNITY, CHANNEL, POLICY)]),
        )
        .expect("welcomes_apply");
    assert_eq!(decode_outcomes(&joined)[0].outcome, 0);
    relay.push_handshake(1, vec![0xde, 0xad]);
    assert_eq!(c.sync(&relay).state, 3);
    let before = c.group(&GROUP).expect("row");

    // Another group under the same id, bound to OTHER_CHANNEL, welcomes Carol.
    let mut forged = Relay::new(GROUP);
    let mut dave = ready_core(0xd4, "dave");
    register_on(&mut dave, &mut forged, OTHER_CHANNEL, &instance);
    let kp = c.first_key_package();
    instance.propose_add(&mut forged, &kp);
    dave.sync(&forged);
    dave.commit(&mut forged);
    let outcome = c
        .core
        .welcomes_apply(
            &forged.welcomes_body(c.device),
            &expected_body(&[(GROUP, COMMUNITY, OTHER_CHANNEL, POLICY)]),
        )
        .expect("welcomes_apply");
    assert_eq!(
        decode_outcomes(&outcome),
        vec![WelcomeOutcome {
            welcome_id: 1,
            group_id: GROUP,
            outcome: 2,
            reason: "E_CORE_STATE".to_owned(),
        }]
    );
    assert_eq!(c.group(&GROUP), Some(before));
}

#[test]
fn a_refused_mislabelled_welcome_leaves_the_key_package_usable() {
    let instance = Instance::generate();
    let mut other = Relay::new(OTHER_GROUP);
    let mut peer = RawPeer::new(0xe5, 0xe6);
    peer.create(&mut other, &instance);
    let mut c = ready_core(0xc3, "carol");
    let kp = c.first_key_package();
    peer.add(&mut other, &[kp.as_slice()]);
    let honest = other.welcomes_body(c.device);
    other.group_id = GROUP; // the delivery service labels OTHER_GROUP's Welcome as GROUP's
    let refused = c
        .core
        .welcomes_apply(
            &other.welcomes_body(c.device),
            &expected_body(&[(GROUP, COMMUNITY, CHANNEL, POLICY)]),
        )
        .expect("welcomes_apply");
    assert_eq!(decode_outcomes(&refused)[0].outcome, 2);
    assert!(groups(&c.core).is_empty(), "no row and no group");

    let joined = c
        .core
        .welcomes_apply(
            &honest,
            &expected_body(&[(OTHER_GROUP, COMMUNITY, CHANNEL, POLICY)]),
        )
        .expect("welcomes_apply");
    assert_eq!(
        decode_outcomes(&joined)[0].outcome,
        0,
        "the refusal consumed nothing"
    );
}

/// Replaces the MLS group stored under `group_id` in `core`'s database by a fresh group with the
/// same id bound to `channel`: the state a join without the id check could leave behind.
fn plant_group(core: &Core, group_id: [u8; 16], channel: [u8; 16]) {
    use dilla_core::mls::{CIPHERSUITE, DillaGroup, DillaProvider};
    use openmls::prelude::{BasicCredential, CredentialWithKey, GroupId};
    use openmls_basic_credential::SignatureKeyPair;
    let provider = DillaProvider::new(std::sync::Arc::clone(&core.probe));
    let id = GroupId::from_slice(&group_id);
    if let Some(mut g) = DillaGroup::load(&provider, &id).expect("load") {
        g.delete(&provider).expect("delete");
    }
    let signer = SignatureKeyPair::new(CIPHERSUITE.signature_algorithm()).expect("keygen");
    signer.store(provider.storage()).expect("store signer");
    let credential = CredentialWithKey {
        credential: BasicCredential::new(b"planted".to_vec()).into(),
        signature_key: signer.public().into(),
    };
    DillaGroup::create(
        &provider,
        &signer,
        credential,
        id,
        text_binding(channel),
        None,
    )
    .expect("create");
}

#[test]
fn a_stored_group_whose_binding_is_not_its_rows_is_refused_until_a_resync() {
    let (_instance, mut relay, mut a, b) = alice_and_bob();
    plant_group(&b, GROUP, OTHER_CHANNEL);
    let mut b = b.reopen();
    a.send(&mut relay, &GROUP, "after the swap", NOW + 1);

    let err = b
        .try_sync(&relay)
        .expect_err("the stored group is not the row's");
    assert_eq!(err.code, "E_CORE_STATE");
    assert!(err.detail.contains("resync"), "detail {:?}", err.detail);
    let msg = b.prepare(&GROUP, "not under that group", NOW + 2);
    assert_eq!(code(b.core.send_encrypt(&msg)), "E_CORE_STATE");
    assert_eq!(b.outbox(&GROUP)[0].state, 0, "nothing was framed");

    // A resync replaces the stored group and the row works again.
    b.join_external(&mut relay);
    assert_eq!(
        b.group(&GROUP).map(|g| (g.state, g.target_id)),
        Some((2, CHANNEL))
    );
    a.sync(&relay);
    let (_, seq) = a.send(&mut relay, &GROUP, "after the resync", NOW + 3);
    assert!(b.sync(&relay).new_seqs.contains(&seq));
}

// ---------------------------------------------------------------------------------------------
// F4: a refused rejoin never deletes history.

/// Alice and Bob talk, Bob queues a message, the instance removes Bob and Alice commits it: Bob's
/// row is gone (state 4) with its timeline and its outbox.
fn bob_removed() -> (Instance, Relay, Core, Core) {
    let (instance, mut relay, mut a, mut b) = alice_and_bob();
    a.send(&mut relay, &GROUP, "before the removal", NOW + 1);
    b.sync(&relay);
    b.prepare(&GROUP, "never sent", NOW + 2);
    instance.propose_remove(&mut relay, b.device);
    a.sync(&relay);
    a.commit(&mut relay);
    assert_eq!(b.sync(&relay).state, 4);
    (instance, relay, a, b)
}

#[test]
fn a_discarded_rejoin_of_a_gone_group_returns_it_to_gone_with_its_history() {
    let (_instance, relay, _a, mut b) = bob_removed();
    let row = b.group(&GROUP).expect("row");
    let timeline = b.timeline(&GROUP);
    let outbox = b.outbox(&GROUP);
    assert_eq!(timeline.len(), 1);
    assert_eq!(outbox.len(), 1);

    // The device is admitted again; its join is refused (425 or 403) and the engine discards it.
    b.core
        .group_join_external(
            &GROUP,
            &COMMUNITY,
            &CHANNEL,
            POLICY,
            &relay.info_body(),
            &relay.tree_body(),
        )
        .expect("rejoin body");
    assert_eq!(b.group(&GROUP).map(|g| g.state), Some(1));
    b.core.group_discard(&GROUP).expect("discard");

    assert_eq!(b.group(&GROUP), Some(row), "back to gone, as it was");
    assert_eq!(b.timeline(&GROUP), timeline, "the history is kept");
    assert_eq!(b.outbox(&GROUP), outbox, "and the outbox");

    // A later rejoin that succeeds still works.
    let mut relay = relay;
    b.join_external(&mut relay);
    assert_eq!(b.group(&GROUP).map(|g| g.state), Some(2));
    assert_eq!(b.timeline(&GROUP), timeline);
}

#[test]
fn a_discarded_join_that_created_its_row_leaves_nothing() {
    let (_instance, relay, _a, _b) = alice_and_bob();
    let mut c = ready_core(0xc3, "carol");
    c.core
        .group_join_external(
            &GROUP,
            &COMMUNITY,
            &CHANNEL,
            POLICY,
            &relay.info_body(),
            &relay.tree_body(),
        )
        .expect("join body");
    c.core.group_discard(&GROUP).expect("discard");
    assert!(groups(&c.core).is_empty());
}

// ---------------------------------------------------------------------------------------------
// F6: no rejoin below the highest epoch this device has held for the group.

#[test]
fn a_resync_from_a_group_info_older_than_the_local_group_is_refused() {
    let (_instance, mut relay, mut a, mut b) = alice_and_bob();
    let (old_info, old_tree) = (relay.info_body(), relay.tree_body()); // epoch 1
    a.commit(&mut relay);
    a.commit(&mut relay);
    assert_eq!(b.sync(&relay).epoch, 3);
    relay.push_handshake(1, vec![0xde, 0xad]);
    assert_eq!(b.sync(&relay).state, 3);
    let before = b.group(&GROUP).expect("row");

    let err = b
        .core
        .group_join_external(&GROUP, &COMMUNITY, &CHANNEL, POLICY, &old_info, &old_tree)
        .expect_err("a GroupInfo of epoch 1 under a group at epoch 3");
    assert_eq!(err.code, "E_CORE_INPUT");
    assert_eq!(b.group(&GROUP), Some(before));

    b.join_external(&mut relay);
    assert_eq!(b.group(&GROUP).map(|g| (g.state, g.epoch)), Some((2, 4)));
}

#[test]
fn a_rejoin_of_a_gone_group_from_an_older_group_info_is_refused() {
    let (instance, mut relay, mut a, mut b) = alice_and_bob();
    let (old_info, old_tree) = (relay.info_body(), relay.tree_body()); // epoch 1
    a.commit(&mut relay);
    a.commit(&mut relay);
    assert_eq!(b.sync(&relay).epoch, 3);
    instance.propose_remove(&mut relay, b.device);
    a.sync(&relay);
    a.commit(&mut relay);
    assert_eq!(b.sync(&relay).state, 4, "Bob held epoch 3 last");
    let before = b.group(&GROUP).expect("row");

    let err = b
        .core
        .group_join_external(&GROUP, &COMMUNITY, &CHANNEL, POLICY, &old_info, &old_tree)
        .expect_err("a GroupInfo of epoch 1 after holding epoch 3");
    assert_eq!(err.code, "E_CORE_INPUT");
    assert_eq!(b.group(&GROUP), Some(before.clone()));
    assert_eq!(
        b.reopen().group(&GROUP),
        Some(before),
        "the floor is stored"
    );
}

#[test]
fn a_replayed_welcome_older_than_the_local_group_is_refused() {
    let instance = Instance::generate();
    let mut relay = Relay::new(GROUP);
    let mut peer = RawPeer::new(0xe5, 0xe6);
    peer.create(&mut relay, &instance);
    let mut c = ready_core(0xc3, "carol");
    let kp = last_resort_key_package(&mut c); // kept by OpenMLS after use: the Welcome stays openable
    peer.add(&mut relay, &[kp.as_slice()]);
    let old = relay.welcomes_body(c.device); // epoch 1
    let expected = expected_body(&[(GROUP, COMMUNITY, CHANNEL, POLICY)]);
    let joined = c
        .core
        .welcomes_apply(&old, &expected)
        .expect("welcomes_apply");
    assert_eq!(decode_outcomes(&joined)[0].outcome, 0);
    peer.self_update(&mut relay);
    peer.self_update(&mut relay);
    assert_eq!(c.sync(&relay).epoch, 3);
    relay.push_handshake(1, vec![0xde, 0xad]);
    assert_eq!(c.sync(&relay).state, 3);
    let before = c.group(&GROUP).expect("row");

    let replayed = c
        .core
        .welcomes_apply(&old, &expected)
        .expect("welcomes_apply");
    assert_eq!(
        decode_outcomes(&replayed),
        vec![WelcomeOutcome {
            welcome_id: 1,
            group_id: GROUP,
            outcome: 2,
            reason: "E_CORE_INPUT".to_owned(),
        }]
    );
    assert_eq!(c.group(&GROUP), Some(before));
}

#[test]
fn a_replayed_welcome_after_a_removal_is_refused() {
    let instance = Instance::generate();
    let mut relay = Relay::new(GROUP);
    let mut a = ready_core(0xa1, "alice");
    a.create_and_register(&mut relay, &instance);
    let mut c = ready_core(0xc3, "carol");
    let kp = last_resort_key_package(&mut c);
    instance.propose_add(&mut relay, &kp);
    a.sync(&relay);
    a.commit(&mut relay);
    let old = relay.welcomes_body(c.device); // epoch 1
    let expected = expected_body(&[(GROUP, COMMUNITY, CHANNEL, POLICY)]);
    let joined = c
        .core
        .welcomes_apply(&old, &expected)
        .expect("welcomes_apply");
    assert_eq!(decode_outcomes(&joined)[0].outcome, 0);
    a.commit(&mut relay);
    a.commit(&mut relay);
    assert_eq!(c.sync(&relay).epoch, 3);
    instance.propose_remove(&mut relay, c.device);
    a.sync(&relay);
    a.commit(&mut relay);
    assert_eq!(c.sync(&relay).state, 4);
    let before = c.group(&GROUP).expect("row");

    let replayed = c
        .core
        .welcomes_apply(&old, &expected)
        .expect("welcomes_apply");
    assert_eq!(decode_outcomes(&replayed)[0].outcome, 2);
    assert_eq!(decode_outcomes(&replayed)[0].reason, "E_CORE_INPUT");
    assert_eq!(c.group(&GROUP), Some(before));
}

// The boundaries of the floor (controller ruling): a Welcome is refused at or below the highest
// epoch held, a GroupInfo at e (which lands the device in e + 1) only below it.

fn welcome_outcome(c: &mut Core, welcomes: &[u8]) -> (u64, String) {
    let out = c
        .core
        .welcomes_apply(
            welcomes,
            &expected_body(&[(GROUP, COMMUNITY, CHANNEL, POLICY)]),
        )
        .expect("welcomes_apply");
    let o = decode_outcomes(&out).pop().expect("one outcome");
    (o.outcome, o.reason)
}

#[test]
fn a_welcome_one_below_the_floor_is_refused() {
    let (_instance, mut relay, mut a, mut c) = carol_added();
    let w1 = relay.welcomes_body(c.device); // epoch 1
    a.commit(&mut relay);
    assert_eq!(c.sync(&relay).epoch, 2, "floor 2");
    relay.push_handshake(1, vec![0xde, 0xad]);
    assert_eq!(c.sync(&relay).state, 3);
    let before = c.group(&GROUP);
    assert_eq!(welcome_outcome(&mut c, &w1), (2, "E_CORE_INPUT".into()));
    assert_eq!(c.group(&GROUP), before);
}

#[test]
fn a_welcome_at_the_floor_is_refused() {
    let (_instance, mut relay, _a, mut c) = carol_added();
    let w1 = relay.welcomes_body(c.device); // epoch 1 = the floor
    relay.push_handshake(1, vec![0xde, 0xad]);
    assert_eq!(c.sync(&relay).state, 3);
    let before = c.group(&GROUP);
    assert_eq!(welcome_outcome(&mut c, &w1), (2, "E_CORE_INPUT".into()));
    assert_eq!(c.group(&GROUP), before);
}

#[test]
fn a_welcome_one_above_the_floor_rejoins() {
    let (instance, mut relay, mut a, mut c) = carol_added();
    a.commit(&mut relay);
    assert_eq!(c.sync(&relay).epoch, 2, "floor 2");
    // One commit removes Carol's leaf and adds her again: its Welcome is for epoch 3.
    let kp = c.first_key_package();
    instance.propose_remove(&mut relay, c.device);
    instance.propose_add(&mut relay, &kp);
    a.sync(&relay);
    a.commit(&mut relay);
    assert_eq!(c.sync(&relay).state, 4);
    let latest = relay.welcomes.last().expect("the new Welcome").clone();
    assert_eq!(latest.epoch, 3);
    relay.welcomes = vec![latest];
    let welcomes = relay.welcomes_body(c.device);
    assert_eq!(welcome_outcome(&mut c, &welcomes), (0, String::new()));
    assert_eq!(c.group(&GROUP).map(|g| (g.state, g.epoch)), Some((2, 3)));
}

#[test]
fn a_group_info_one_below_the_floor_is_refused_and_one_at_it_rejoins() {
    let (_instance, mut relay, mut a, mut b) = alice_and_bob();
    let (info1, tree1) = (relay.info_body(), relay.tree_body()); // epoch 1
    a.commit(&mut relay);
    assert_eq!(b.sync(&relay).epoch, 2, "floor 2");
    relay.push_handshake(1, vec![0xde, 0xad]);
    assert_eq!(b.sync(&relay).state, 3);
    let before = b.group(&GROUP);

    assert_eq!(
        code(
            b.core
                .group_join_external(&GROUP, &COMMUNITY, &CHANNEL, POLICY, &info1, &tree1)
        ),
        "E_CORE_INPUT",
        "epoch 1 would land in 2, the floor"
    );
    assert_eq!(b.group(&GROUP), before);

    // The relay's GroupInfo is at epoch 2, the floor: the join lands in 3.
    b.join_external(&mut relay);
    assert_eq!(b.group(&GROUP).map(|g| (g.state, g.epoch)), Some((2, 3)));
}

#[test]
fn the_floor_survives_a_discarded_rejoin() {
    let (instance, mut relay, mut a, mut b) = alice_and_bob();
    let (info1, tree1) = (relay.info_body(), relay.tree_body()); // epoch 1
    a.commit(&mut relay);
    assert_eq!(b.sync(&relay).epoch, 2);
    instance.propose_remove(&mut relay, b.device);
    a.sync(&relay);
    a.commit(&mut relay);
    assert_eq!(b.sync(&relay).state, 4);

    b.core
        .group_join_external(
            &GROUP,
            &COMMUNITY,
            &CHANNEL,
            POLICY,
            &relay.info_body(),
            &relay.tree_body(),
        )
        .expect("rejoin body");
    b.core.group_discard(&GROUP).expect("discard");
    assert_eq!(b.group(&GROUP).map(|g| g.state), Some(4));
    assert_eq!(
        code(
            b.core
                .group_join_external(&GROUP, &COMMUNITY, &CHANNEL, POLICY, &info1, &tree1)
        ),
        "E_CORE_INPUT"
    );
}
