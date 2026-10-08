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
            "SELECT count(*) FROM app_quarantine WHERE device_id=?1",
            [bob.device.as_slice()],
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
