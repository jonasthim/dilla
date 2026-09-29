//! A frame queued for a joiner between its Add commit and its `join_welcome` must survive the
//! join. `DsStub::accept_commit` adds the joiner to `members` before the fan-out, so a message
//! sent in that window is already in the joiner's queue when it fetches its Welcome; taking the
//! Welcome must not destroy it.

use dilla_core::identity::{Kind, Tier};
use dilla_core::ids::{InstanceId, UserId};
use dilla_core::mls::{DillaBinding, GroupKind};
use dilla_testkit::{DsStub, InstanceConfig, TestClient};

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

fn client(name: &str, user: u8, seed: u64) -> TestClient {
    TestClient::new(
        name,
        UserId::from_bytes([user; 16]),
        Tier::Native,
        Kind::User,
        seed,
    )
    .expect("client")
}

#[test]
fn join_welcome_keeps_the_frames_queued_behind_the_welcome() {
    let mut ds = DsStub::new(config());
    let mut alice = client("alice", 0xa1, 1);
    let mut bob = client("bob", 0xb0, 2);
    // The stub is every device's delivery service, so each call names the device acting.
    ds.act_as(alice.device_id());
    alice.publish_key_packages(&mut ds, 2).expect("alice kps");
    ds.act_as(bob.device_id());
    bob.publish_key_packages(&mut ds, 2).expect("bob kps");

    ds.act_as(alice.device_id());
    let group_id = alice.create_group(&mut ds, binding()).expect("create");
    alice
        .invite(&mut ds, &group_id, bob.device_id())
        .expect("invite");
    // Queued to bob's device *before* bob fetches its Welcome: bob is already a member.
    alice
        .send(&mut ds, &group_id, "Grab the wolf capes.")
        .expect("send");

    ds.act_as(bob.device_id());
    bob.join_welcome(&mut ds, &group_id, &binding())
        .expect("join");
    bob.sync(&mut ds).expect("sync");

    assert!(
        bob.inbox()
            .iter()
            .any(|r| r.group_id == group_id && r.envelope.body == "Grab the wolf capes."),
        "the message queued before the Welcome was destroyed by join_welcome: {:?}",
        bob.inbox()
    );
}
