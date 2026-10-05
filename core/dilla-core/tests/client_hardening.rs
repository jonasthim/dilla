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
    let instance = Instance::generate();
    let mut relay = Relay::new(GROUP);
    let mut peer = RawPeer::new(0xe5, 0xe6);
    peer.create(&mut relay, &instance);
    let mut c = ready_core(0xc3, "carol");
    let kp = last_resort_key_package(&mut c);
    peer.add(&mut relay, &[kp.as_slice()]);
    let welcomes = relay.welcomes_body(c.device);
    let expected = expected_body(&[(GROUP, COMMUNITY, CHANNEL, POLICY)]);
    let joined = c
        .core
        .welcomes_apply(&welcomes, &expected)
        .expect("welcomes_apply");
    assert_eq!(decode_outcomes(&joined)[0].outcome, 0);
    for _ in 0..3 {
        peer.send(&mut relay, "filler");
    }
    let bad = relay.push_handshake(1, vec![0xde, 0xad]);
    let stopped = c.sync(&relay);
    assert_eq!((stopped.state, stopped.next_seq), (3, bad));

    // The same Welcome again (its commit_seq lies far below): the row rejoins, next_seq stays.
    let again = c
        .core
        .welcomes_apply(&welcomes, &expected)
        .expect("welcomes_apply");
    assert_eq!(decode_outcomes(&again)[0].outcome, 0);
    let row = c.group(&GROUP).expect("row");
    assert_eq!(
        (row.state, row.next_seq),
        (2, bad),
        "next_seq is not lowered"
    );
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
// F5: an own echo is adopted only when its commitment is the in-flight envelope's.

#[test]
fn the_echo_of_an_earlier_upload_is_not_adopted_as_the_message_in_flight() {
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
    assert_eq!(applied.flags & OWN_ADOPTED, 0, "nothing was adopted");
    let row = b.timeline(&GROUP).pop().expect("row");
    assert_eq!(
        (row.seq, row.status, row.reason.as_str(), row.body.as_str()),
        (stored, 1, "E_OWN_UNKNOWN", "")
    );
    let states: Vec<([u8; 16], u64)> = b
        .outbox(&GROUP)
        .into_iter()
        .map(|o| (o.msg_id, o.state))
        .collect();
    assert_eq!(states, vec![(first, 2), (second, 1)], "B stays in flight");

    // B's own echo is adopted at its own seq.
    let seq = seq_of_answer(&relay.post_message(b.device, &body).expect("upload"));
    let applied = b.sync(&relay);
    assert_eq!(applied.flags & OWN_ADOPTED, OWN_ADOPTED);
    let row = b.timeline(&GROUP).pop().expect("row");
    assert_eq!((row.seq, row.status, row.body.as_str()), (seq, 0, "second"));
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
    assert_eq!(applied.flags & OWN_ADOPTED, 0);
    assert_eq!(b.timeline(&GROUP).pop().map(|r| r.status), Some(1));

    let seq = seq_of_answer(&relay.post_message(b.device, &body).expect("upload"));
    let live = MsgRow {
        commitment: None,
        ..row_at(&relay, seq)
    };
    let applied = apply(&mut b, &[&live], seq);
    assert_eq!(applied.flags & OWN_ADOPTED, OWN_ADOPTED);
    let row = b.timeline(&GROUP).pop().expect("row");
    assert_eq!((row.seq, row.status, row.body.as_str()), (seq, 0, "second"));
    assert_eq!(
        b.outbox(&GROUP).len(),
        1,
        "only the failed first row is left"
    );

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
