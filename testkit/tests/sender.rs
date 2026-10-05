//! C22 in the testkit: a received message names its sender from MLS, and a delivery service that
//! labels an upload with another device than the one MLS authenticates fails the sync. The stub
//! records the ACTING device as the uploader (`DsStub::post_message_from` via the trait,
//! `ds/state.rs:1123-1136`), which is how a mislabelled upload is built here: carol "uploads"
//! what alice encrypted.

use dilla_core::identity::{Kind, Tier};
use dilla_core::ids::{InstanceId, UserId};
use dilla_core::mls::{DillaBinding, GroupKind};
use dilla_testkit::{DsStub, InstanceConfig, TestClient, TestkitError};

fn config() -> InstanceConfig {
    InstanceConfig {
        instance_id: InstanceId::from_bytes([0x11; 16]),
        signing_key: [0x77; 32],
        policy_version: 1,
        k_frank: [0x09; 32],
    }
}

fn binding() -> DillaBinding {
    DillaBinding {
        v: 1,
        instance_id: InstanceId::from_bytes([0x11; 16]),
        community_id: None,
        target_id: [0x33; 16],
        kind: GroupKind::Text,
        policy_version: 1,
        e2ee_version: 1,
        media_version: 0,
    }
}

struct Room {
    ds: DsStub,
    alice: TestClient,
    bob: TestClient,
    carol: TestClient,
    group_id: Vec<u8>,
}

/// alice (a browser-tier device) creates the group and adds bob, while carol remains an unregistered acting device; alice and bob hold epoch 1.
fn room() -> Room {
    let mut ds = DsStub::new(config());
    let mut alice = TestClient::new(
        "alice",
        UserId::from_bytes([0xa1; 16]),
        Tier::Browser,
        Kind::User,
        1,
    )
    .expect("alice");
    let mut bob = TestClient::new(
        "bob",
        UserId::from_bytes([0xb0; 16]),
        Tier::Native,
        Kind::User,
        2,
    )
    .expect("bob");
    let mut carol = TestClient::new(
        "carol",
        UserId::from_bytes([0xc0; 16]),
        Tier::Native,
        Kind::User,
        3,
    )
    .expect("carol");
    for client in [&mut alice, &mut bob, &mut carol] {
        ds.act_as(client.device_id());
        client
            .publish_key_packages(&mut ds, 2)
            .expect("key packages");
    }

    ds.act_as(alice.device_id());
    let group_id = alice.create_group(&mut ds, binding()).expect("create");
    alice
        .invite(&mut ds, &group_id, bob.device_id())
        .expect("invite bob");
    ds.act_as(bob.device_id());
    bob.join_welcome(&mut ds, &group_id, &binding())
        .expect("bob joins");
    assert_eq!(bob.epoch_of(&group_id), Some(1), "fixture sanity");
    Room {
        ds,
        alice,
        bob,
        carol,
        group_id,
    }
}

#[test]
fn a_received_message_names_the_mls_sender_with_its_user_and_tier() {
    let mut r = room();
    r.ds.act_as(r.alice.device_id());
    r.alice
        .send(&mut r.ds, &r.group_id, "Grab the wolf capes.")
        .expect("send");

    r.ds.act_as(r.bob.device_id());
    let got = r.bob.sync(&mut r.ds).expect("sync");
    assert_eq!(got.len(), 1, "{got:?}");
    assert_eq!(got[0].envelope.body, "Grab the wolf capes.");
    assert_eq!(got[0].sender, r.alice.device_id());
    assert_eq!(got[0].sender_user, r.alice.user_id());
    assert_eq!(got[0].tier, Tier::Browser);
    assert_eq!(r.bob.inbox().len(), 1);
}

#[test]
fn a_message_whose_mls_sender_is_not_the_uploader_fails_the_sync() {
    let mut r = room();
    // carol is the acting device, so the stub records carol as the uploader of alice's message.
    r.ds.act_as(r.carol.device_id());
    r.alice
        .send(&mut r.ds, &r.group_id, "mislabelled")
        .expect("the stub accepts any acting device");

    r.ds.act_as(r.bob.device_id());
    let err = r
        .bob
        .sync(&mut r.ds)
        .expect_err("a mislabelled upload must fail the sync");
    match err {
        TestkitError::Assertion(msg) => {
            assert!(msg.contains("is not the uploader"), "{msg}");
            assert!(msg.contains(&r.alice.device_id().to_hex()), "{msg}");
            assert!(msg.contains(&r.carol.device_id().to_hex()), "{msg}");
        }
        other => panic!("expected an assertion failure, got {other:?}"),
    }
    assert!(
        r.bob
            .inbox()
            .iter()
            .all(|m| m.envelope.body != "mislabelled"),
        "a mislabelled message must not reach the inbox: {:?}",
        r.bob.inbox()
    );
}
