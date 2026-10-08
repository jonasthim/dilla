#![cfg(not(target_arch = "wasm32"))]
mod client_support;
use client_support::*;
use dilla_core::cbor::decode_strict;

type Pending = ([u8; 16], u32, [u8; 16], u64, String);

fn pending(bytes: &[u8]) -> Vec<Pending> {
    decode_strict(bytes, |d| {
        let n = d.array_len()?;
        let mut out = Vec::new();
        for _ in 0..n {
            d.array(5)?;
            let group = d.bytes_exact::<16>()?;
            let leaf = u32::try_from(d.uint()?).expect("leaf index");
            out.push((
                group,
                leaf,
                d.bytes_exact::<16>()?,
                d.uint()?,
                d.text()?.to_owned(),
            ));
        }
        Ok(out)
    })
    .expect("pending leaves CBOR")
}

#[test]
fn pending_leaves_are_core_owned_and_bounded() {
    let (_, relay, alice, bob) = alice_and_bob();
    let rows = pending(&alice.core.pending_leaves().expect("pending"));
    assert!(rows.len() <= 4096);
    assert!(
        rows.iter()
            .any(|r| r.0 == GROUP && r.2 == bob.user && r.1 == relay.leaf_of(bob.device))
    );
    assert!(
        rows.iter()
            .all(|r| ["ready-refresh", "unknown", "changed"].contains(&r.4.as_str()))
    );
}

#[test]
fn malformed_history_cannot_pin_a_real_current_leaf() {
    let (_, relay, mut alice, bob) = alice_and_bob();
    let leaf = relay.leaf_of(bob.device);
    let err = alice
        .core
        .device_list_ingest(&GROUP, leaf, &bob.user, &[0x80], &[0x80], NOW)
        .expect_err("empty history");
    assert!(["E_DEVICE_LIST_STALE", "E_CREDENTIAL"].contains(&err.code));
    assert_eq!(alice.core.trust_state().expect("state"), [0x80]);
}

#[test]
fn another_users_requested_id_never_creates_a_pin() {
    let (_, relay, mut alice, bob) = alice_and_bob();
    let wrong = [0xee; 16];
    let err = alice
        .core
        .device_list_ingest(
            &GROUP,
            relay.leaf_of(bob.device),
            &wrong,
            &[0x80],
            &[0x80],
            NOW,
        )
        .expect_err("wrong user");
    assert_eq!(err.code, "E_CREDENTIAL");
    assert_eq!(alice.core.trust_state().expect("state"), [0x80]);
}

#[test]
fn missing_shared_contact_has_no_safety_number() {
    let (_, _, alice, _) = alice_and_bob();
    assert_eq!(
        code(alice.core.safety_number_for(&[0xee; 16])),
        "E_CORE_NOT_FOUND"
    );
}
use dilla_core::cbor::Encoder;
use dilla_core::identity::{
    DeviceEntry, DeviceList, DeviceListUnsigned, SskSigner, Tier, UmkSigner,
};
use dilla_core::ids::{DeviceId, UserId};

fn list_wire(peer: &Core) -> (Vec<u8>, Vec<u8>) {
    let put = peer.core.device_list_body().expect("own PUT body");
    let (version, blob, sig, prev) = decode_strict(&put, |d| {
        d.array(4)?;
        Ok((
            d.uint()?,
            d.bytes()?.to_vec(),
            d.bytes_exact::<64>()?,
            d.bytes_exact::<32>()?,
        ))
    })
    .expect("PUT [version,blob,signature,prev_hash]");
    let mut history = Encoder::new();
    history
        .array(1)
        .array(4)
        .uint(version)
        .bytes(&blob)
        .bytes(&sig)
        .bytes(&prev);
    (history.into_vec(), blob)
}

#[test]
fn exact_signed_history_pins_real_leaf_and_formats_pairwise_number() {
    let (_, relay, mut alice, bob) = alice_and_bob();
    let (history, head) = list_wire(&bob);
    let answer = alice
        .core
        .device_list_ingest(
            &GROUP,
            relay.leaf_of(bob.device),
            &bob.user,
            &history,
            &head,
            NOW,
        )
        .expect("ingest");
    let (version, changed, quarantined) = decode_strict(&answer, |d| {
        d.array(3)?;
        Ok((d.uint()?, d.uint()?, d.uint()?))
    })
    .expect("verdict");
    assert_eq!((version, changed, quarantined), (1, 0, 0));
    let number = alice.core.safety_number_for(&bob.user).expect("number");
    assert_eq!(number.split(' ').count(), 12);
    assert!(
        number
            .split(' ')
            .all(|g| g.len() == 5 && g.bytes().all(|b| b.is_ascii_digit()))
    );
}

#[test]
fn wrong_head_bytes_and_missing_group_do_not_pin() {
    let (_, relay, mut alice, bob) = alice_and_bob();
    let (history, mut head) = list_wire(&bob);
    head[0] ^= 1;
    assert_eq!(
        code(alice.core.device_list_ingest(
            &GROUP,
            relay.leaf_of(bob.device),
            &bob.user,
            &history,
            &head,
            NOW
        )),
        "E_DEVICE_LIST_STALE"
    );
    assert_eq!(
        code(
            alice
                .core
                .device_list_ingest(&OTHER_GROUP, 0, &bob.user, &history, &head, NOW)
        ),
        "E_CORE_NOT_FOUND"
    );
    assert_eq!(alice.core.trust_state().expect("state"), [0x80]);
}

#[test]
fn a_sender_without_signed_history_stays_pending_and_unsearchable() {
    let (_, mut relay, mut alice, mut bob) = alice_and_bob();
    let (_, seq) = bob.send(&mut relay, &GROUP, "untrusted comet", NOW + 1);
    alice.sync(&relay);
    let row = alice.row_at(&GROUP, seq);
    assert_eq!(
        (row.status, row.reason.as_str(), row.body.as_str()),
        (1, "E_DEVICE_LIST_STALE", "")
    );
    assert!(
        alice
            .core
            .search(2, None, "untrusted comet", None, 50)
            .expect("search")
            == [0x80]
    );
}

#[test]
fn untrusted_message_does_not_abort_a_batch_with_an_honest_message() {
    let (_, mut relay, mut alice, mut bob) = alice_and_bob();
    let (_, bad_seq) = bob.send(&mut relay, &GROUP, "untrusted first", NOW + 1);
    let (_, good_seq) = alice.send(&mut relay, &GROUP, "honest second", NOW + 2);
    let applied = alice.sync(&relay);
    assert!(applied.next_seq > good_seq);
    let bad = alice.row_at(&GROUP, bad_seq);
    assert_eq!(
        (bad.status, bad.reason.as_str(), bad.body.as_str()),
        (1, "E_DEVICE_LIST_STALE", "")
    );
    assert_eq!(alice.row_at(&GROUP, good_seq).body, "honest second");
}

#[test]
fn signed_history_revalidates_a_previously_neutral_message() {
    let (_, mut relay, mut alice, mut bob) = alice_and_bob();
    let (_, seq) = bob.send(&mut relay, &GROUP, "late signed comet", NOW + 1);
    alice.sync(&relay);
    assert_eq!(alice.row_at(&GROUP, seq).status, 1);
    let (history, head) = list_wire(&bob);
    alice
        .core
        .device_list_ingest(
            &GROUP,
            relay.leaf_of(bob.device),
            &bob.user,
            &history,
            &head,
            NOW + 2,
        )
        .expect("ingest");
    assert_eq!(
        alice
            .core
            .revalidate_pending(&GROUP, relay.leaf_of(bob.device), 256)
            .expect("revalidate"),
        1
    );
    let row = alice.row_at(&GROUP, seq);
    assert_eq!((row.status, row.body.as_str()), (0, "late signed comet"));
    assert_ne!(
        alice
            .core
            .search(2, None, "late signed", None, 50)
            .expect("search"),
        [0x80]
    );
}

#[test]
fn one_history_ingest_revalidates_more_than_one_page_past_an_unrecoverable_row() {
    let (_, mut relay, mut alice, mut bob) = alice_and_bob();
    let leaf = relay.leaf_of(bob.device);
    {
        let db = alice.probe.lock().expect("db");
        db.execute("INSERT INTO app_messages(group_id,seq,epoch,recv_ts,status,reason,sender_device,franking_tag) VALUES(?1,0,1,1,1,'E_DEVICE_LIST_STALE',?2,?3)",
            rusqlite::params![GROUP.as_slice(), bob.device.as_slice(), [0x44u8; 32].as_slice()]).expect("unrecoverable row");
        db.execute("INSERT INTO app_pending_history(group_id,seq,ciphertext,envelope,sender_leaf,sender_credential) VALUES(?1,0,x'80',x'80',?2,x'80')",
            rusqlite::params![GROUP.as_slice(), i64::from(leaf)]).expect("retained invalid evidence");
    }
    let mut last = 0;
    for n in 0..257 {
        let (_, seq) = bob.send(
            &mut relay,
            &GROUP,
            &format!("late batch comet {n}"),
            NOW + 1 + n,
        );
        last = seq;
    }
    alice.sync(&relay);
    assert_eq!(alice.row_at(&GROUP, last).status, 1);
    let (history, head) = list_wire(&bob);
    alice
        .core
        .device_list_ingest(&GROUP, leaf, &bob.user, &history, &head, NOW + 300)
        .expect("ingest");
    assert_eq!(
        alice
            .core
            .revalidate_pending(&GROUP, leaf, 256)
            .expect("drain"),
        257
    );
    assert_eq!(
        (
            alice.row_at(&GROUP, last).status,
            alice.row_at(&GROUP, last).body.as_str()
        ),
        (0, "late batch comet 256")
    );
    assert_ne!(
        alice
            .core
            .search(2, None, "batch comet 256", None, 50)
            .expect("search"),
        [0x80]
    );
    let db = alice.probe.lock().expect("db");
    let status: i64 = db
        .query_row(
            "SELECT status FROM app_messages WHERE group_id=?1 AND seq=0",
            [GROUP.as_slice()],
            |r| r.get(0),
        )
        .expect("invalid row stays neutral");
    assert_eq!(status, 1);
}

#[test]
fn pending_leaf_revalidation_uses_the_leaf_sequence_index() {
    let (_, _, alice, _) = alice_and_bob();
    let db = alice.probe.lock().expect("db");
    let plan: Vec<String> = db.prepare("EXPLAIN QUERY PLAN SELECT p.seq,p.envelope,p.sender_leaf,p.sender_credential,m.epoch,m.recv_ts,m.sender_device,m.franking_tag \
        FROM app_pending_history p INDEXED BY app_pending_history_by_leaf_seq JOIN app_messages m ON m.group_id=p.group_id AND m.seq=p.seq \
        WHERE p.group_id=?1 AND p.sender_leaf=?2 AND p.seq>?3 AND m.status=1 AND m.reason='E_DEVICE_LIST_STALE' ORDER BY p.seq LIMIT ?4")
        .expect("plan").query_map(rusqlite::params![GROUP.as_slice(), 1_i64, -1_i64, 256_i64], |r| r.get(3))
        .expect("rows").collect::<Result<_, _>>().expect("plan rows");
    assert!(
        plan.iter()
            .any(|step| step.contains("app_pending_history_by_leaf_seq")
                && step.contains("group_id=?")
                && step.contains("sender_leaf=?")
                && step.contains("seq>?")),
        "pending query must seek by leaf and sequence: {plan:?}"
    );
}

#[test]
fn deleting_a_pending_message_discards_its_retained_ciphertext() {
    let (_, mut relay, mut alice, mut bob) = alice_and_bob();
    let (_, seq) = bob.send(&mut relay, &GROUP, "pending deleted comet", NOW + 1);
    alice.sync(&relay);
    alice
        .core
        .message_deleted(&GROUP, seq)
        .expect("delete pending row");
    let db = alice.probe.lock().expect("db");
    let retained: i64 = db
        .query_row(
            "SELECT count(*) FROM app_pending_history WHERE group_id=?1 AND seq=?2",
            rusqlite::params![GROUP.as_slice(), seq as i64],
            |r| r.get(0),
        )
        .expect("retained count");
    assert_eq!(retained, 0);
}

#[test]
fn revalidation_is_scoped_to_the_leaf_whose_history_arrived() {
    let (_, mut relay, mut alice, mut bob) = alice_and_bob();
    let (_, seq) = bob.send(&mut relay, &GROUP, "late leaf specific", NOW + 1);
    alice.sync(&relay);
    let bob_leaf = relay.leaf_of(bob.device);
    {
        let db = alice.probe.lock().expect("db");
        db.execute("INSERT INTO app_messages(group_id,seq,epoch,recv_ts,status,reason,sender_device,franking_tag) VALUES(?1,0,1,1,1,'E_DEVICE_LIST_STALE',?2,?3)",
            rusqlite::params![GROUP.as_slice(), [0x33u8; 16].as_slice(), [0x44u8; 32].as_slice()]).expect("earlier pending row");
        db.execute("INSERT INTO app_pending_history(group_id,seq,ciphertext,envelope,sender_leaf,sender_credential) VALUES(?1,0,x'80',x'80',999,x'80')",
            [GROUP.as_slice()]).expect("earlier other leaf");
    }
    let (history, head) = list_wire(&bob);
    alice
        .core
        .device_list_ingest(&GROUP, bob_leaf, &bob.user, &history, &head, NOW + 2)
        .expect("ingest");
    assert_eq!(
        alice
            .core
            .revalidate_pending(&GROUP, bob_leaf, 1)
            .expect("bounded revalidate"),
        1
    );
    assert_eq!(alice.row_at(&GROUP, seq).body, "late leaf specific");
}

#[test]
fn authenticated_candidate_history_allows_first_contact_add() {
    let (instance, mut relay, mut alice, bob) = alice_and_bob_trusted();
    let mut carol = ready_core(0xc3, "carol");
    instance.propose_add(&mut relay, &carol.first_key_package());
    let proposals = relay.proposals_body();
    assert_eq!(
        code(alice.core.commit_build(&GROUP, &proposals)),
        "E_DEVICE_LIST_STALE"
    );
    let candidates = alice
        .core
        .proposed_adds(&GROUP, &proposals)
        .expect("authenticated candidates");
    let rows = decode_strict(&candidates, |d| {
        let n = d.array_len()?;
        let mut out = Vec::new();
        for _ in 0..n {
            d.array(3)?;
            out.push((d.uint()?, d.bytes_exact::<16>()?, d.uint()?));
        }
        Ok(out)
    })
    .expect("candidates");
    assert_eq!(rows, vec![(0, carol.user, 0)]);
    let (other_history, other_head) = list_wire(&bob);
    assert_eq!(
        code(alice.core.device_list_ingest_add(
            &GROUP,
            &proposals,
            0,
            &carol.user,
            &other_history,
            &other_head,
            NOW
        )),
        "E_CREDENTIAL"
    );
    let (history, head) = list_wire(&carol);
    alice
        .core
        .device_list_ingest_add(&GROUP, &proposals, 0, &carol.user, &history, &head, NOW)
        .expect("pre-add ingest");
    alice
        .core
        .commit_build(&GROUP, &proposals)
        .expect("first contact add");
}

#[test]
fn later_sender_verdict_retracts_visible_history_and_advances_generation() {
    let (_, mut relay, mut alice, mut bob) = alice_and_bob_trusted();
    let before_generation = alice.core.trust_generation().expect("generation");
    let (_, first) = bob.send(&mut relay, &GROUP, "previously visible comet", NOW + 1);
    alice.sync(&relay);
    assert_eq!(alice.row_at(&GROUP, first).body, "previously visible comet");
    assert_ne!(
        alice
            .core
            .search(2, None, "previously visible", None, 50)
            .unwrap(),
        [0x80]
    );

    // A signed list can be revoked or replaced between two application rows.
    // Force the cached verdict to fail while retaining the actual MLS sender.
    alice
        .probe
        .lock()
        .unwrap()
        .execute(
            "UPDATE app_device_lists SET list=x'80' WHERE user_id=?1",
            [bob.user.as_slice()],
        )
        .unwrap();
    let (_, second) = bob.send(&mut relay, &GROUP, "later comet", NOW + 2);
    alice.sync(&relay);
    assert_eq!(alice.row_at(&GROUP, second).status, 1);
    assert!(alice.core.trust_generation().expect("generation") > before_generation);
    let old = alice.row_at(&GROUP, first);
    assert_eq!((old.status, old.body.as_str()), (1, ""));
    assert_eq!(
        alice
            .core
            .search(2, None, "previously visible", None, 50)
            .unwrap(),
        [0x80]
    );
    let generation: Vec<u8> = alice
        .probe
        .lock()
        .unwrap()
        .query_row(
            "SELECT v FROM app_meta WHERE k='trust_generation'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(
        dilla_core::cbor::decode_strict(&generation, |d| d.uint()).unwrap(),
        1
    );
}

#[test]
fn merged_commit_quarantines_a_leaf_that_fails_its_cached_signed_list() {
    let (_, mut relay, mut alice, mut bob) = alice_and_bob_trusted();
    let (_, first) = bob.send(&mut relay, &GROUP, "commit visible comet", NOW + 1);
    alice.sync(&relay);
    assert_eq!(alice.row_at(&GROUP, first).body, "commit visible comet");
    alice
        .probe
        .lock()
        .unwrap()
        .execute(
            "UPDATE app_device_lists SET list=x'80' WHERE user_id=?1",
            [bob.user.as_slice()],
        )
        .unwrap();
    bob.commit(&mut relay);
    alice.sync(&relay);
    assert_eq!(
        (
            alice.row_at(&GROUP, first).status,
            alice.row_at(&GROUP, first).body
        ),
        (1, String::new())
    );
    let blocks: i64 = alice
        .probe
        .lock()
        .unwrap()
        .query_row(
            "SELECT count(*) FROM app_quarantine WHERE group_id=?1 AND device_id=?2",
            rusqlite::params![GROUP.as_slice(), bob.device.as_slice()],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(blocks, 1);
}

#[test]
fn external_join_audits_known_bad_existing_leaf() {
    let (_, mut relay, mut alice, mut bob) = alice_and_bob_trusted();
    let (_, first) = bob.send(&mut relay, &GROUP, "join visible comet", NOW + 1);
    alice.sync(&relay);
    alice
        .probe
        .lock()
        .unwrap()
        .execute(
            "UPDATE app_device_lists SET list=x'80' WHERE user_id=?1",
            [bob.user.as_slice()],
        )
        .unwrap();
    alice
        .core
        .group_join_external(
            &GROUP,
            Some(&COMMUNITY),
            &CHANNEL,
            POLICY,
            &relay.info_body(),
            &relay.tree_body(),
        )
        .unwrap();
    assert_eq!(
        (
            alice.row_at(&GROUP, first).status,
            alice.row_at(&GROUP, first).body
        ),
        (1, String::new())
    );
}

#[test]
fn welcome_join_audits_known_bad_existing_leaf() {
    let (instance, mut relay, mut alice, mut bob) = alice_and_bob_trusted();
    let (_, first) = bob.send(&mut relay, &GROUP, "welcome visible comet", NOW + 1);
    alice.sync(&relay);
    instance.propose_remove(&mut relay, alice.device);
    bob.commit(&mut relay);
    alice.sync(&relay);
    let package = alice.first_key_package();
    instance.propose_add(&mut relay, &package);
    bob.commit(&mut relay);
    alice
        .probe
        .lock()
        .unwrap()
        .execute(
            "UPDATE app_device_lists SET list=x'80' WHERE user_id=?1",
            [bob.user.as_slice()],
        )
        .unwrap();
    let results = decode_outcomes(
        &alice
            .core
            .welcomes_apply(
                &relay.welcomes_body(alice.device),
                &expected_body(&[(GROUP, COMMUNITY, CHANNEL, POLICY)]),
            )
            .unwrap(),
    );
    assert_eq!(results.last().unwrap().outcome, 0);
    assert_eq!(
        (
            alice.row_at(&GROUP, first).status,
            alice.row_at(&GROUP, first).body
        ),
        (1, String::new())
    );
}

#[test]
fn another_users_bad_cached_leaf_does_not_quarantine_an_honest_commit_author() {
    let (_, mut relay, mut alice, bob) = alice_and_bob_trusted();
    let mut carol = ready_core(0xc3, "carol");
    carol.join_external(&mut relay);
    alice.sync(&relay);
    ingest_core_list(&mut alice, &relay, &carol);
    let (_, prior) = carol.send(&mut relay, &GROUP, "author visible comet", NOW + 1);
    alice.sync(&relay);
    assert_eq!(alice.row_at(&GROUP, prior).body, "author visible comet");
    alice
        .probe
        .lock()
        .unwrap()
        .execute(
            "UPDATE app_device_lists SET list=x'80' WHERE user_id=?1",
            [bob.user.as_slice()],
        )
        .unwrap();
    carol.commit(&mut relay);
    let forged_sender = relay.leaf_of(bob.device);
    relay.handshakes.last_mut().unwrap().sender = Some(forged_sender as u64);
    alice.sync(&relay);
    assert_eq!(alice.row_at(&GROUP, prior).body, "author visible comet");
    let blocked: i64 = alice
        .probe
        .lock()
        .unwrap()
        .query_row(
            "SELECT count(*) FROM app_quarantine WHERE group_id=?1 AND device_id=?2",
            rusqlite::params![GROUP.as_slice(), carol.device.as_slice()],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(blocked, 0);
    let bad_leaf_blocked: i64 = alice
        .probe
        .lock()
        .unwrap()
        .query_row(
            "SELECT count(*) FROM app_quarantine WHERE group_id=?1 AND device_id=?2",
            rusqlite::params![GROUP.as_slice(), bob.device.as_slice()],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(bad_leaf_blocked, 1);
}

#[test]
fn own_commit_refuses_an_add_without_a_validated_signed_list() {
    let (instance, mut relay, mut alice, _) = alice_and_bob();
    let mut carol = ready_core(0xc3, "carol");
    let package = carol.first_key_package();
    instance.propose_add(&mut relay, &package);
    assert_eq!(
        code(alice.core.commit_build(&GROUP, &relay.proposals_body())),
        "E_DEVICE_LIST_STALE"
    );
}

#[test]
fn exact_key_verification_rechecks_the_signed_cache_and_releases_changed_key_blocks() {
    let (_, relay, mut alice, bob) = alice_and_bob();
    ingest_core_list(&mut alice, &relay, &bob);
    let expected: [u8; 32] = alice
        .probe
        .lock()
        .expect("db")
        .query_row(
            "SELECT umk_pub FROM app_device_lists WHERE user_id=?1",
            [bob.user.as_slice()],
            |r| r.get(0),
        )
        .expect("validated cached key");
    {
        let db = alice.probe.lock().expect("db");
        db.execute(
            "UPDATE app_trust_pins SET umk_pub=?2,changed_umk=?3,verified=0 WHERE user_id=?1",
            rusqlite::params![
                bob.user.as_slice(),
                [0xeeu8; 32].as_slice(),
                expected.as_slice()
            ],
        )
        .expect("simulate pending changed key");
        for group in [GROUP, OTHER_GROUP] {
            db.execute(
                "INSERT INTO app_quarantine(group_id,device_id,code) VALUES(?1,?2,'E_UMK_CHANGED')",
                rusqlite::params![group.as_slice(), bob.device.as_slice()],
            )
            .expect("block");
        }
    }
    assert!(alice.core.trust_verify(&bob.user, &[0xdd; 32]).is_err());
    alice
        .core
        .trust_verify(&bob.user, &expected)
        .expect("exact validated key");
    let db = alice.probe.lock().expect("db");
    let blocks: i64 = db
        .query_row(
            "SELECT count(*) FROM app_quarantine WHERE group_id=?1 AND device_id=?2",
            rusqlite::params![GROUP.as_slice(), bob.device.as_slice()],
            |r| r.get(0),
        )
        .expect("blocks");
    let verified: i64 = db
        .query_row(
            "SELECT verified FROM app_trust_pins WHERE user_id=?1",
            [bob.user.as_slice()],
            |r| r.get(0),
        )
        .expect("pin");
    assert_eq!((blocks, verified), (0, 1));
}

#[test]
fn first_seen_signed_contact_can_be_verified_after_comparison() {
    let (_, relay, mut alice, bob) = alice_and_bob();
    ingest_core_list(&mut alice, &relay, &bob);
    let expected: [u8; 32] = alice
        .probe
        .lock()
        .unwrap()
        .query_row(
            "SELECT umk_pub FROM app_device_lists WHERE user_id=?1",
            [bob.user.as_slice()],
            |r| r.get(0),
        )
        .unwrap();
    alice
        .core
        .trust_verify(&bob.user, &expected)
        .expect("verified first sight");
    let verified: i64 = alice
        .probe
        .lock()
        .unwrap()
        .query_row(
            "SELECT verified FROM app_trust_pins WHERE user_id=?1",
            [bob.user.as_slice()],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(verified, 1);
}

#[test]
fn verify_refuses_a_pending_cached_key_after_real_mls_remove() {
    let (instance, mut relay, mut alice, bob) = alice_and_bob();
    ingest_core_list(&mut alice, &relay, &bob);
    let expected: [u8; 32] = alice
        .probe
        .lock()
        .unwrap()
        .query_row(
            "SELECT umk_pub FROM app_device_lists WHERE user_id=?1",
            [bob.user.as_slice()],
            |r| r.get(0),
        )
        .unwrap();
    alice
        .probe
        .lock()
        .unwrap()
        .execute(
            "UPDATE app_trust_pins SET umk_pub=?2,changed_umk=?3,verified=0 WHERE user_id=?1",
            rusqlite::params![
                bob.user.as_slice(),
                [0xeeu8; 32].as_slice(),
                expected.as_slice()
            ],
        )
        .unwrap();
    instance.propose_remove(&mut relay, bob.device);
    alice.commit(&mut relay);
    assert_eq!(
        code(alice.core.trust_verify(&bob.user, &expected)),
        "E_DEVICE_LIST_STALE"
    );
}

#[test]
fn real_rejoin_with_rotated_umk_requires_exact_current_leaf_at_verify() {
    let (instance, mut relay, mut alice, bob) = alice_and_bob();
    let (old_history, old_blob) = list_wire(&bob);
    ingest_core_list(&mut alice, &relay, &bob);
    instance.propose_remove(&mut relay, bob.device);
    alice.commit(&mut relay);
    let mut rotated = RawPeer::new_with_keys(0xb2, 0xd4, 0xd5, 0xd6);
    rotated.join_external(&mut relay);
    alice.sync(&relay);
    let old = DeviceList::decode(&old_blob).unwrap();
    let ssk = SskSigner::from_bytes(&[0xd6; 32]);
    let unsigned = DeviceListUnsigned {
        v: 1,
        user_id: UserId::from_bytes(bob.user),
        version: 2,
        prev_hash: old.hash(),
        entries: vec![DeviceEntry {
            device_id: DeviceId::from_bytes(rotated.device),
            dsk_pub: rotated.signer.public().try_into().unwrap(),
            tier: Tier::Native,
            added_at: NOW + 2,
            revoked_at: None,
        }],
    };
    let new = DeviceList {
        sig_ssk: ssk.sign_device_list(&unsigned),
        unsigned,
    };
    let (v1, blob1, sig1, prev1) = decode_strict(&old_history, |d| {
        d.array(1)?;
        d.array(4)?;
        Ok((
            d.uint()?,
            d.bytes()?.to_vec(),
            d.bytes_exact::<64>()?,
            d.bytes_exact::<32>()?,
        ))
    })
    .unwrap();
    let mut history = Encoder::new();
    history
        .array(2)
        .array(4)
        .uint(v1)
        .bytes(&blob1)
        .bytes(&sig1)
        .bytes(&prev1)
        .array(4)
        .uint(2)
        .bytes(&new.encode())
        .bytes(&new.sig_ssk)
        .bytes(&new.unsigned.prev_hash);
    let expected = UmkSigner::from_bytes(&[0xd5; 32]).public();
    let answer = alice
        .core
        .device_list_ingest(
            &GROUP,
            relay.leaf_of(rotated.device),
            &bob.user,
            &history.into_vec(),
            &new.encode(),
            NOW + 3,
        )
        .unwrap();
    let (_, changed, _) = decode_strict(&answer, |d| {
        d.array(3)?;
        Ok((d.uint()?, d.uint()?, d.uint()?))
    })
    .unwrap();
    assert_eq!(changed, 1);
    assert_eq!(
        code(alice.core.trust_verify(&bob.user, &[0xee; 32])),
        "E_DEVICE_LIST_STALE"
    );
    instance.propose_remove(&mut relay, rotated.device);
    alice.commit(&mut relay);
    assert_eq!(
        code(alice.core.trust_verify(&bob.user, &expected)),
        "E_DEVICE_LIST_STALE"
    );
    let mut substitute = RawPeer::new_with_keys(0xb2, 0xd4, 0xd5, 0xd6);
    substitute.join_external(&mut relay);
    alice.sync(&relay);
    assert_eq!(
        code(alice.core.trust_verify(&bob.user, &expected)),
        "E_DEVICE_LIST_STALE"
    );
    instance.propose_remove(&mut relay, substitute.device);
    alice.commit(&mut relay);
    rotated.join_external(&mut relay);
    alice.sync(&relay);
    alice.core.trust_verify(&bob.user, &expected).unwrap();
}
#[test]
fn another_users_signed_list_cannot_clear_a_victims_block() {
    let (_, relay, mut alice, bob) = alice_and_bob();
    ingest_core_list(&mut alice, &relay, &bob);
    let attacker = bob.user;
    let victim_device = bob.device;
    let victim = [0xc3u8; 16];
    let group = [0xf6u8; 16];
    let db = alice.probe.lock().unwrap();
    let key: [u8; 32] = db
        .query_row(
            "SELECT umk_pub FROM app_device_lists WHERE user_id=?1",
            [attacker.as_slice()],
            |r| r.get(0),
        )
        .unwrap();
    db.execute(
        "UPDATE app_trust_pins SET umk_pub=?2,changed_umk=?3 WHERE user_id=?1",
        rusqlite::params![attacker.as_slice(), [0x66u8; 32].as_slice(), key.as_slice()],
    )
    .unwrap();
    db.execute(
        "INSERT INTO app_quarantine(group_id,device_id,code) VALUES(?1,?2,'E_UMK_CHANGED')",
        rusqlite::params![group.as_slice(), victim_device.as_slice()],
    )
    .unwrap();
    db.execute(
        "INSERT INTO app_trust_pins(user_id,umk_pub,first_seen,verified,changed_umk) VALUES(?1,?2,1,0,?3)",
        rusqlite::params![victim.as_slice(), [0x55u8;32].as_slice(), [0x44u8;32].as_slice()],
    ).unwrap();
    drop(db);
    let _ = alice.core.trust_verify(&attacker, &key);
    let blocks: i64 = alice
        .probe
        .lock()
        .unwrap()
        .query_row(
            "SELECT count(*) FROM app_quarantine WHERE group_id=?1 AND device_id=?2",
            rusqlite::params![group.as_slice(), victim_device.as_slice()],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(blocks, 1, "another user's list released a victim's block");
    let victim_changed: Vec<u8> = alice
        .probe
        .lock()
        .unwrap()
        .query_row(
            "SELECT changed_umk FROM app_trust_pins WHERE user_id=?1",
            [victim.as_slice()],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(victim_changed, [0x44; 32]);
}

#[test]
fn oversized_candidate_head_is_rejected_before_decode() {
    use dilla_core::identity::{DeviceEntry, DeviceList, Tier};
    use dilla_core::ids::DeviceId;
    let (_, relay, mut alice, bob) = alice_and_bob();
    let (history, head) = list_wire(&bob);
    let mut huge = DeviceList::decode(&head).unwrap();
    let entry = DeviceEntry {
        device_id: DeviceId::from_bytes([0x99; 16]),
        dsk_pub: [0x88; 32],
        tier: Tier::Native,
        added_at: 1,
        revoked_at: None,
    };
    huge.unsigned.entries.resize(90_000, entry);
    let oversized = huge.encode();
    assert!(oversized.len() > 4 * 1024 * 1024);
    assert_eq!(
        code(alice.core.device_list_ingest(
            &GROUP,
            relay.leaf_of(bob.device),
            &bob.user,
            &history,
            &oversized,
            NOW
        )),
        "E_CORE_LIMIT"
    );
}

#[test]
fn overfull_candidate_head_is_rejected_before_entries_are_decoded() {
    use dilla_core::identity::{DeviceEntry, DeviceList, Tier};
    use dilla_core::ids::DeviceId;
    let (_, relay, mut alice, bob) = alice_and_bob();
    let (history, head) = list_wire(&bob);
    let mut huge = DeviceList::decode(&head).unwrap();
    let entry = DeviceEntry {
        device_id: DeviceId::from_bytes([0x99; 16]),
        dsk_pub: [0x88; 32],
        tier: Tier::Native,
        added_at: 1,
        revoked_at: None,
    };
    huge.unsigned.entries.resize(10_001, entry);
    let oversized = huge.encode();
    assert!(oversized.len() < 1024 * 1024);
    assert_eq!(
        code(alice.core.device_list_ingest(
            &GROUP,
            relay.leaf_of(bob.device),
            &bob.user,
            &history,
            &oversized,
            NOW
        )),
        "E_CORE_LIMIT"
    );
}
