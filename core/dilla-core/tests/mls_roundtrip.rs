// Native only: every test here opens a real SQLite connection through `rusqlite`, which exists on
// this target and on the browser target but not under `wasm32-unknown-unknown`'s test harness.
// Plan A2's NV-9 requires the gate; it is written in the task that creates the file.
#![cfg(not(target_arch = "wasm32"))]

//! Two clients, one text group, end to end: create, add, welcome-join, send, decrypt - through
//! dilla's own StorageProvider, with the binding checked before anything is written.

use dilla_core::ProtocolError;
use dilla_core::envelope::{Envelope, EnvelopeType};
use dilla_core::ids::{DeviceId, InstanceId, MsgId, UserId};
use dilla_core::mls::*;
use dilla_core::public_group::*;
// `VerifiableGroupInfo` is not re-exported by `openmls::prelude` in 0.9.0.
use openmls::messages::group_info::VerifiableGroupInfo;
use openmls::prelude::*;
use openmls_basic_credential::SignatureKeyPair;
use std::sync::{Arc, Mutex};

fn provider() -> DillaProvider {
    let conn = rusqlite::Connection::open_in_memory().expect("sqlite");
    let p = DillaProvider::new(Arc::new(Mutex::new(conn)));
    p.storage().migrate().expect("migrate");
    p
}

fn identity(user: u8, device: u8) -> Vec<u8> {
    use dilla_core::identity::{CredentialIdentity, Kind, SignerTier, Tier};
    let umk = dilla_core::identity::UmkSigner::from_bytes(&[user; 32]);
    let ssk = dilla_core::identity::SskSigner::from_bytes(&[user.wrapping_add(0x40); 32]);
    let device_id = DeviceId::from_bytes([device; 16]);
    CredentialIdentity {
        v: 1,
        umk_pub: umk.public(),
        user_id: UserId::from_bytes([user; 16]),
        device_id,
        kind: Kind::User,
        tier: Tier::Native,
        signer_tier: SignerTier::Native,
        ssk_pub: ssk.public(),
        sig_umk_ssk: umk.sign_ssk(&ssk.public()),
        sig_ssk_dev: [0u8; 64], // not checked by this test; task 12 wires the real leaf key in
    }
    .encode()
}

fn signer_and_credential(user: u8, device: u8) -> (SignatureKeyPair, CredentialWithKey) {
    let keys = SignatureKeyPair::new(CIPHERSUITE.signature_algorithm()).expect("keygen");
    let credential = BasicCredential::new(identity(user, device));
    let with_key = CredentialWithKey {
        credential: credential.into(),
        signature_key: keys.public().into(),
    };
    (keys, with_key)
}

fn binding(kind: GroupKind) -> DillaBinding {
    DillaBinding {
        v: 1,
        instance_id: InstanceId::from_bytes([0x11; 16]),
        community_id: None,
        target_id: [0x33; 16],
        kind,
        policy_version: 1,
        e2ee_version: 1,
        media_version: kind.media_version(),
    }
}

/// The wire round trip, not a `From` impl: `.into()` with an unconstrained target is
/// `error[E0282]: type annotations needed`, and "Needs verification" item 18 records that
/// `From<MlsMessageOut> for MlsMessageIn` was never read from a source (facts-openmls §4.5 marks
/// `MlsMessageIn::into_welcome` as `test-utils`-gated). This is what a real peer does with the
/// bytes, and it is the same path `testkit/src/client.rs` uses.
fn into_protocol(message: MlsMessageOut) -> ProtocolMessage {
    use tls_codec::{Deserialize as _, Serialize as _};
    let bytes = message.tls_serialize_detached().expect("serialize");
    MlsMessageIn::tls_deserialize_exact(&bytes)
        .expect("deserialize")
        .try_into_protocol_message()
        .expect("a commit or an application message is a ProtocolMessage")
}

/// The same round trip for a message that carries a GroupInfo.
#[allow(dead_code)]
fn into_group_info(message: MlsMessageOut) -> VerifiableGroupInfo {
    use tls_codec::{Deserialize as _, Serialize as _};
    let bytes = message.tls_serialize_detached().expect("serialize");
    match MlsMessageIn::tls_deserialize_exact(&bytes)
        .expect("deserialize")
        .extract()
    {
        MlsMessageBodyIn::GroupInfo(info) => info,
        other => panic!("expected a GroupInfo message, got {other:?}"),
    }
}

/// The same round trip for a Welcome.
fn into_welcome(message: MlsMessageOut) -> Welcome {
    use tls_codec::{Deserialize as _, Serialize as _};
    let bytes = message.tls_serialize_detached().expect("serialize");
    match MlsMessageIn::tls_deserialize_exact(&bytes)
        .expect("deserialize")
        .extract()
    {
        MlsMessageBodyIn::Welcome(w) => w,
        other => panic!("expected a Welcome message, got {other:?}"),
    }
}

fn envelope(body: &str) -> Envelope {
    Envelope {
        v: 1,
        msg_id: MsgId::from_bytes([0x01; 16]),
        kind: EnvelopeType::Message,
        thread_id: None,
        reply_to: None,
        body: body.to_owned(),
        attachments: Vec::new(),
        previews: Vec::new(),
        k_f: [0x06; 32],
    }
}

#[test]
fn two_clients_create_add_join_send_and_decrypt() {
    let alice_p = provider();
    let bob_p = provider();
    let (alice_signer, alice_cred) = signer_and_credential(0xaa, 0x01);
    let (bob_signer, bob_cred) = signer_and_credential(0xbb, 0x02);
    alice_signer.store(alice_p.storage()).expect("store signer");
    bob_signer.store(bob_p.storage()).expect("store signer");

    let bob_kp = build_key_package(&bob_p, &bob_signer, bob_cred, false).expect("key package");

    let group_id = GroupId::from_slice(&[0x44; 16]);
    let b = binding(GroupKind::Text);
    let mut alice = DillaGroup::create(
        &alice_p,
        &alice_signer,
        alice_cred,
        group_id.clone(),
        b.clone(),
        None,
    )
    .expect("create");
    assert_eq!(alice.epoch(), 0);
    assert_eq!(alice.binding(), &b);

    let bundle = alice
        .add_members(&alice_p, &alice_signer, &[bob_kp.key_package().clone()])
        .expect("add_members");
    alice.merge_pending_commit(&alice_p).expect("merge");
    assert_eq!(alice.epoch(), 1);
    assert_eq!(bundle.welcomes.len(), 1);

    let welcome = into_welcome(bundle.welcomes[0].1.clone());
    let tree = alice.export_ratchet_tree();
    let mut bob = DillaGroup::join_from_welcome(&bob_p, welcome, tree.into(), &b).expect("join");
    assert_eq!(bob.epoch(), 1);
    assert_eq!(bob.binding(), &b);

    let env = envelope("On my way. Grab the wolf capes from the chest by the portal.");
    let message = alice
        .create_message(&alice_p, &alice_signer, &env)
        .expect("create_message");
    let protocol = into_protocol(message);
    match bob.process_message(&bob_p, protocol).expect("process") {
        DillaProcessed::Application(got) => {
            assert_eq!(got.envelope, env);
            // Alice created the group, so her leaf is 0; Bob joined as leaf 1.
            assert_eq!(got.sender_leaf, 0, "the sender's leaf, not the receiver's");
            assert_eq!(
                got.sender.device_id,
                DeviceId::from_bytes([0x01; 16]),
                "the device of the MLS-authenticated sender"
            );
            assert_eq!(got.sender.user_id, UserId::from_bytes([0xaa; 16]));
            assert_eq!(got.sender.kind, dilla_core::identity::Kind::User);
            assert_eq!(got.sender.tier, dilla_core::identity::Tier::Native);
            assert_eq!(got.epoch, 1);
        }
        other => panic!("expected an application message, got {other:?}"),
    }
}

#[test]
fn a_welcome_whose_binding_mismatches_is_refused_before_anything_is_stored() {
    let alice_p = provider();
    let bob_p = provider();
    let (alice_signer, alice_cred) = signer_and_credential(0xaa, 0x01);
    let (bob_signer, bob_cred) = signer_and_credential(0xbb, 0x02);
    alice_signer.store(alice_p.storage()).expect("store signer");
    bob_signer.store(bob_p.storage()).expect("store signer");
    let bob_kp = build_key_package(&bob_p, &bob_signer, bob_cred, false).expect("key package");

    let group_id = GroupId::from_slice(&[0x44; 16]);
    let mut alice = DillaGroup::create(
        &alice_p,
        &alice_signer,
        alice_cred,
        group_id.clone(),
        binding(GroupKind::Text),
        None,
    )
    .expect("create");
    let bundle = alice
        .add_members(&alice_p, &alice_signer, &[bob_kp.key_package().clone()])
        .expect("add_members");
    alice.merge_pending_commit(&alice_p).expect("merge");
    let welcome = into_welcome(bundle.welcomes[0].1.clone());

    // Bob expects a DIFFERENT channel.
    let mut wrong = binding(GroupKind::Text);
    wrong.target_id = [0x99; 16];
    let err =
        DillaGroup::join_from_welcome(&bob_p, welcome, alice.export_ratchet_tree().into(), &wrong)
            .expect_err("the binding must be checked before into_group");
    assert!(
        matches!(err, MlsError::Protocol(ProtocolError::Binding)),
        "{err:?}"
    );
    assert!(
        DillaGroup::load(&bob_p, &group_id).expect("load").is_none(),
        "a refused welcome must leave no group behind"
    );
}

/// The external-join twin of the Welcome test above. `MlsGroup::join_by_external_commit` writes
/// the joiner's whole group state through the provider before it returns, so the `dilla_binding`
/// check has to run **inside** the same transaction: made after the closure has committed, it
/// rejects the join but leaves the group row behind, and the next `DillaGroup::load` hands the
/// caller a group it refused to join.
#[test]
fn an_external_commit_whose_binding_mismatches_is_refused_before_anything_is_stored() {
    let alice_p = provider();
    let bob_p = provider();
    let (alice_signer, alice_cred) = signer_and_credential(0xaa, 0x01);
    let (bob_signer, bob_cred) = signer_and_credential(0xbb, 0x02);
    alice_signer.store(alice_p.storage()).expect("store signer");
    bob_signer.store(bob_p.storage()).expect("store signer");

    let group_id = GroupId::from_slice(&[0x44; 16]);
    let alice = DillaGroup::create(
        &alice_p,
        &alice_signer,
        alice_cred,
        group_id.clone(),
        binding(GroupKind::Text),
        None,
    )
    .expect("create");

    // What the DS serves an external joiner: a GroupInfo without the tree, plus the tree.
    let verifiable = into_group_info(
        alice
            .export_group_info(&alice_p, &alice_signer)
            .expect("group info"),
    );
    let tree = alice.export_ratchet_tree();

    // Bob expects a DIFFERENT channel than the one the served GroupInfo is bound to.
    let mut wrong = binding(GroupKind::Text);
    wrong.target_id = [0x99; 16];
    let err = DillaGroup::join_by_external_commit(
        &bob_p,
        &bob_signer,
        bob_cred,
        verifiable,
        tree.into(),
        &wrong,
    )
    .expect_err("the binding must be checked before the transaction commits");
    assert!(
        matches!(err, MlsError::Protocol(ProtocolError::Binding)),
        "{err:?}"
    );
    assert!(
        DillaGroup::load(&bob_p, &group_id).expect("load").is_none(),
        "a refused external commit must leave no group behind"
    );
}

#[test]
fn a_key_package_without_the_binding_capability_cannot_be_added() {
    let alice_p = provider();
    let bob_p = provider();
    let (alice_signer, alice_cred) = signer_and_credential(0xaa, 0x01);
    let (bob_signer, bob_cred) = signer_and_credential(0xbb, 0x02);
    alice_signer.store(alice_p.storage()).expect("store signer");
    bob_signer.store(bob_p.storage()).expect("store signer");

    // Built WITHOUT leaf_node_capabilities(leaf_capabilities()): no 0xF001.
    let plain = KeyPackage::builder()
        .build(CIPHERSUITE, &bob_p, &bob_signer, bob_cred)
        .expect("key package");

    let mut alice = DillaGroup::create(
        &alice_p,
        &alice_signer,
        alice_cred,
        GroupId::from_slice(&[0x44; 16]),
        binding(GroupKind::Text),
        None,
    )
    .expect("create");
    let err = alice
        .add_members(&alice_p, &alice_signer, &[plain.key_package().clone()])
        .expect_err("a leaf that cannot support 0xF001 must be refused");
    assert!(
        format!("{err:?}").contains("InsufficientCapabilities"),
        "{err:?}"
    );
}

/// protocol/01-groups.md, "Client policy for proposals from members": a member `Remove` is
/// accepted only when the target leaf belongs to the committer's own user. Alice (user 0xaa) and
/// Bob (user 0xbb) are different users, so Bob's client must refuse Alice's commit rather than
/// merge it — `E_MEMBER_REMOVE_FORBIDDEN`.
#[test]
fn a_member_commit_removing_another_users_leaf_is_refused_by_the_receiver() {
    let alice_p = provider();
    let bob_p = provider();
    let (alice_signer, alice_cred) = signer_and_credential(0xaa, 0x01);
    let (bob_signer, bob_cred) = signer_and_credential(0xbb, 0x02);
    alice_signer.store(alice_p.storage()).expect("store signer");
    bob_signer.store(bob_p.storage()).expect("store signer");
    let bob_kp = build_key_package(&bob_p, &bob_signer, bob_cred, false).expect("key package");

    let b = binding(GroupKind::Text);
    let mut alice = DillaGroup::create(
        &alice_p,
        &alice_signer,
        alice_cred,
        GroupId::from_slice(&[0x44; 16]),
        b.clone(),
        None,
    )
    .expect("create");
    let add = alice
        .add_members(&alice_p, &alice_signer, &[bob_kp.key_package().clone()])
        .expect("add_members");
    alice.merge_pending_commit(&alice_p).expect("merge");
    let mut bob = DillaGroup::join_from_welcome(
        &bob_p,
        into_welcome(add.welcomes[0].1.clone()),
        alice.export_ratchet_tree().into(),
        &b,
    )
    .expect("join");

    // Bob joined as the second leaf, so index 1 is his.
    let removal = alice
        .remove_members(&alice_p, &alice_signer, &[LeafNodeIndex::new(1)])
        .expect("remove_members");
    let err = bob
        .process_message(&bob_p, into_protocol(removal.commit))
        .expect_err("a member Remove of another user's leaf must be refused");
    assert!(
        matches!(
            err,
            MlsError::Protocol(ProtocolError::MemberRemoveForbidden)
        ),
        "{err:?}"
    );
    assert_eq!(
        bob.epoch(),
        1,
        "the refused commit must not have advanced Bob's epoch"
    );
}

/// The contract's rollback case: a storage failure inside the merge transaction must surface as
/// `MlsError::NeedsReload` (never as a half-merged group), and the reloaded handle must be at the
/// pre-merge epoch.
///
/// The failure is injected through the connection the provider was built on — `ConnHandle` is
/// public, so the test keeps a clone of it — with a trigger that aborts the one write
/// `merge_staged_commit` always performs on `openmls_epoch_key_pairs`
/// (`store_epoch_keypairs`, gap-7 section 2.1 step 2). Nothing is mocked: the real provider, the
/// real transaction and the real `MlsGroup` are all in play.
#[test]
fn a_storage_failure_inside_the_merge_rolls_back_and_reports_needs_reload() {
    let conn: ConnHandle = std::sync::Arc::new(Mutex::new(
        rusqlite::Connection::open_in_memory().expect("sqlite"),
    ));
    let alice_p = DillaProvider::new(conn.clone());
    alice_p.storage().migrate().expect("migrate");
    let bob_p = provider();
    let (alice_signer, alice_cred) = signer_and_credential(0xaa, 0x01);
    let (bob_signer, bob_cred) = signer_and_credential(0xbb, 0x02);
    alice_signer.store(alice_p.storage()).expect("store signer");
    bob_signer.store(bob_p.storage()).expect("store signer");
    let bob_kp = build_key_package(&bob_p, &bob_signer, bob_cred, false).expect("key package");

    let group_id = GroupId::from_slice(&[0x44; 16]);
    let mut alice = DillaGroup::create(
        &alice_p,
        &alice_signer,
        alice_cred,
        group_id.clone(),
        binding(GroupKind::Text),
        None,
    )
    .expect("create");
    alice
        .add_members(&alice_p, &alice_signer, &[bob_kp.key_package().clone()])
        .expect("add_members");
    assert_eq!(alice.epoch(), 0);

    conn.lock()
        .expect("lock")
        .execute_batch(
            "CREATE TRIGGER fail_epoch_keys BEFORE INSERT ON openmls_epoch_key_pairs
             BEGIN SELECT RAISE(ABORT, 'injected failure'); END;",
        )
        .expect("install trigger");

    let err = alice
        .merge_pending_commit(&alice_p)
        .expect_err("the merge must fail");
    assert!(matches!(err, MlsError::NeedsReload), "{err:?}");

    conn.lock()
        .expect("lock")
        .execute_batch("DROP TRIGGER fail_epoch_keys;")
        .expect("drop");

    let reloaded = DillaGroup::load(&alice_p, &group_id)
        .expect("load")
        .expect("group is still there");
    assert_eq!(
        reloaded.epoch(),
        0,
        "the rollback must leave the pre-merge epoch"
    );
}

#[test]
fn a_pairing_group_never_writes_a_past_epoch_secret() {
    let p = provider();
    let (signer, cred) = signer_and_credential(0xaa, 0x01);
    signer.store(p.storage()).expect("store signer");
    let mut g = DillaGroup::create(
        &p,
        &signer,
        cred,
        GroupId::from_slice(&[0x55; 16]),
        binding(GroupKind::Pairing),
        None,
    )
    .expect("create");
    assert_eq!(
        past_epoch_policy(GroupKind::Pairing),
        PastEpochDeletionPolicy::MaxEpochs(0)
    );
    g.self_update(&p, &signer).expect("self_update");
    g.merge_pending_commit(&p).expect("merge");
    // The sweep is a no-op for pairing: there is nothing to sweep.
    assert!(past_epoch_sweep(GroupKind::Pairing).is_none());
    g.sweep_past_epochs(&p)
        .expect("sweep is still callable and does nothing");
}

/// Regression (fix round 1, finding 1): `process_message` must not decode the *sender's*
/// credential as a dilla `CredentialIdentity` before it knows what the message is.
///
/// For `Sender::External(_)` OpenMLS fills `ProcessedMessage::credential()` from the group's
/// `ExternalSenders` extension (openmls-0.9.0/src/group/public_group/process.rs:93-97 and :302),
/// i.e. with dilla's own instance credential, whose identity is the three-element CBOR array
/// `[1, "instance", instance_id]`. `CredentialIdentity::decode` wants ten elements, so an
/// unconditional decode turned every instance-sent proposal into
/// `MlsError::Protocol(ProtocolError::Credential)` — precisely the inactivity-Remove path
/// `INACTIVITY_REMOVE_DAYS` and `instance_sender_index()` exist for.
#[test]
fn an_external_remove_proposal_from_the_instance_is_accepted() {
    let alice_p = provider();
    let bob_p = provider();
    let (alice_signer, alice_cred) = signer_and_credential(0xaa, 0x01);
    let (bob_signer, bob_cred) = signer_and_credential(0xbb, 0x02);
    alice_signer.store(alice_p.storage()).expect("store signer");
    bob_signer.store(bob_p.storage()).expect("store signer");
    let bob_kp = build_key_package(&bob_p, &bob_signer, bob_cred, false).expect("key package");

    // The instance's signing key: the one external sender, at index 0.
    let instance_signer = SignatureKeyPair::new(CIPHERSUITE.signature_algorithm()).expect("keygen");
    let instance_id = InstanceId::from_bytes([0x11; 16]);
    let senders = external_senders(instance_signer.public().into(), &instance_id);

    let group_id = GroupId::from_slice(&[0x44; 16]);
    let b = binding(GroupKind::Text);
    let mut alice = DillaGroup::create(
        &alice_p,
        &alice_signer,
        alice_cred,
        group_id.clone(),
        b.clone(),
        Some(senders),
    )
    .expect("create");
    let add = alice
        .add_members(&alice_p, &alice_signer, &[bob_kp.key_package().clone()])
        .expect("add_members");
    alice.merge_pending_commit(&alice_p).expect("merge");
    let mut bob = DillaGroup::join_from_welcome(
        &bob_p,
        into_welcome(add.welcomes[0].1.clone()),
        alice.export_ratchet_tree().into(),
        &b,
    )
    .expect("join");

    // R15: the instance proposes removing Bob's leaf for inactivity.
    let proposal = ExternalProposal::new_remove::<DillaProvider>(
        LeafNodeIndex::new(1),
        group_id,
        bob.epoch().into(),
        &instance_signer,
        instance_sender_index(),
    )
    .expect("external remove proposal");

    match bob
        .process_message(&bob_p, into_protocol(proposal))
        .expect("the instance's own proposal must not be refused as a bad credential")
    {
        DillaProcessed::Proposal(_) => {}
        other => panic!("expected a queued proposal, got {other:?}"),
    }
}

/// Invariant 4 clause 1: a commit must reference every outstanding instance proposal, so a member
/// that received one must be able to keep it for its next commit. `process_message` hands the
/// proposal back; `store_pending_proposal` is what puts it in the queue `self_update` commits.
#[test]
fn a_stored_instance_proposal_is_carried_by_the_next_commit() {
    let alice_p = provider();
    let bob_p = provider();
    let (alice_signer, alice_cred) = signer_and_credential(0xaa, 0x01);
    let (bob_signer, bob_cred) = signer_and_credential(0xbb, 0x02);
    alice_signer.store(alice_p.storage()).expect("store signer");
    bob_signer.store(bob_p.storage()).expect("store signer");
    let bob_kp = build_key_package(&bob_p, &bob_signer, bob_cred, false).expect("key package");
    let instance_signer = SignatureKeyPair::new(CIPHERSUITE.signature_algorithm()).expect("keygen");
    let senders = external_senders(
        instance_signer.public().into(),
        &InstanceId::from_bytes([0x11; 16]),
    );
    let group_id = GroupId::from_slice(&[0x46; 16]);
    let mut alice = DillaGroup::create(
        &alice_p,
        &alice_signer,
        alice_cred,
        group_id.clone(),
        binding(GroupKind::Text),
        Some(senders),
    )
    .expect("create");
    alice
        .add_members(&alice_p, &alice_signer, &[bob_kp.key_package().clone()])
        .expect("add_members");
    alice.merge_pending_commit(&alice_p).expect("merge");

    let proposal = ExternalProposal::new_remove::<DillaProvider>(
        LeafNodeIndex::new(1),
        group_id,
        alice.epoch().into(),
        &instance_signer,
        instance_sender_index(),
    )
    .expect("external remove proposal");
    let DillaProcessed::Proposal(queued) = alice
        .process_message(&alice_p, into_protocol(proposal))
        .expect("process")
    else {
        panic!("expected a queued proposal");
    };
    alice
        .store_pending_proposal(&alice_p, *queued)
        .expect("store the proposal");

    alice.self_update(&alice_p, &alice_signer).expect("commit");
    alice.merge_pending_commit(&alice_p).expect("merge");
    assert_eq!(
        alice.member_count(),
        1,
        "the commit carried the instance's Remove of Bob's leaf"
    );
}

/// protocol/01's client policy for proposals from the EXTERNAL sender: in a `text` group an Add
/// and a Remove from the instance are accepted - that is how a user joins while offline and how a
/// user is removed - while a member may neither Add nor Remove another user. A receiver must
/// therefore judge each proposal by its own sender, not the commit by its proposal types: the
/// member policy applied to every Add or Remove refused every commit that carried an instance
/// proposal, which is every membership change the instance makes.
#[test]
fn a_receiver_accepts_a_member_commit_of_instance_adds_and_removes() {
    let alice_p = provider();
    let bob_p = provider();
    let carol_p = provider();
    let dave_p = provider();
    let (alice_signer, alice_cred) = signer_and_credential(0xaa, 0x01);
    let (bob_signer, bob_cred) = signer_and_credential(0xbb, 0x02);
    let (carol_signer, carol_cred) = signer_and_credential(0xcc, 0x03);
    let (dave_signer, dave_cred) = signer_and_credential(0xdd, 0x04);
    for (p, s) in [
        (&alice_p, &alice_signer),
        (&bob_p, &bob_signer),
        (&carol_p, &carol_signer),
        (&dave_p, &dave_signer),
    ] {
        s.store(p.storage()).expect("store signer");
    }
    let bob_kp = build_key_package(&bob_p, &bob_signer, bob_cred, false).expect("key package");
    let carol_kp =
        build_key_package(&carol_p, &carol_signer, carol_cred, false).expect("key package");
    let dave_kp = build_key_package(&dave_p, &dave_signer, dave_cred, false).expect("key package");
    let instance_signer = SignatureKeyPair::new(CIPHERSUITE.signature_algorithm()).expect("keygen");
    let senders = external_senders(
        instance_signer.public().into(),
        &InstanceId::from_bytes([0x11; 16]),
    );
    let group_id = GroupId::from_slice(&[0x48; 16]);
    let b = binding(GroupKind::Text);
    let mut alice = DillaGroup::create(
        &alice_p,
        &alice_signer,
        alice_cred,
        group_id.clone(),
        b.clone(),
        Some(senders),
    )
    .expect("create");
    let add = alice
        .add_members(
            &alice_p,
            &alice_signer,
            &[bob_kp.key_package().clone(), carol_kp.key_package().clone()],
        )
        .expect("add_members");
    alice.merge_pending_commit(&alice_p).expect("merge");
    let mut bob = DillaGroup::join_from_welcome(
        &bob_p,
        into_welcome(add.welcomes[0].1.clone()),
        alice.export_ratchet_tree().into(),
        &b,
    )
    .expect("join");

    // The instance proposes removing Carol (leaf 2) and adding Dave; Alice and Bob both queue
    // both, and Alice commits them.
    let remove = ExternalProposal::new_remove::<DillaProvider>(
        LeafNodeIndex::new(2),
        group_id.clone(),
        alice.epoch().into(),
        &instance_signer,
        instance_sender_index(),
    )
    .expect("external remove");
    let admit = ExternalProposal::new_add::<DillaProvider>(
        dave_kp.key_package().clone(),
        group_id,
        alice.epoch().into(),
        &instance_signer,
        instance_sender_index(),
    )
    .expect("external add");
    for proposal in [remove, admit] {
        for (group, p) in [(&mut alice, &alice_p), (&mut bob, &bob_p)] {
            let bytes = {
                use tls_codec::Serialize as _;
                proposal.tls_serialize_detached().expect("serialize")
            };
            let message = {
                use tls_codec::Deserialize as _;
                MlsMessageIn::tls_deserialize_exact(&bytes)
                    .expect("deserialize")
                    .try_into_protocol_message()
                    .expect("protocol message")
            };
            let DillaProcessed::Proposal(queued) =
                group.process_message(p, message).expect("process")
            else {
                panic!("expected a queued proposal");
            };
            group.store_pending_proposal(p, *queued).expect("store");
        }
    }

    let bundle = alice.self_update(&alice_p, &alice_signer).expect("commit");
    alice.merge_pending_commit(&alice_p).expect("merge");
    match bob
        .process_message(&bob_p, into_protocol(bundle.commit))
        .expect("the instance's Add and Remove, committed by a member, are accepted")
    {
        DillaProcessed::StagedCommit(staged) => {
            bob.merge_staged_commit(&bob_p, *staged).expect("merge")
        }
        other => panic!("expected a staged commit, got {other:?}"),
    }
    assert_eq!(bob.epoch(), alice.epoch());
    assert_eq!(bob.member_count(), 3, "alice, bob and dave; carol is gone");
}

/// A member's own Add in a `text` group is still refused by the receiver (protocol/01: a member
/// Add is accepted only in `pairing` and `interaction` groups).
#[test]
fn a_receiver_refuses_a_member_add_in_a_text_group() {
    let alice_p = provider();
    let bob_p = provider();
    let carol_p = provider();
    let (alice_signer, alice_cred) = signer_and_credential(0xaa, 0x01);
    let (bob_signer, bob_cred) = signer_and_credential(0xbb, 0x02);
    let (carol_signer, carol_cred) = signer_and_credential(0xcc, 0x03);
    for (p, s) in [
        (&alice_p, &alice_signer),
        (&bob_p, &bob_signer),
        (&carol_p, &carol_signer),
    ] {
        s.store(p.storage()).expect("store signer");
    }
    let bob_kp = build_key_package(&bob_p, &bob_signer, bob_cred, false).expect("key package");
    let carol_kp =
        build_key_package(&carol_p, &carol_signer, carol_cred, false).expect("key package");
    let b = binding(GroupKind::Text);
    let mut alice = DillaGroup::create(
        &alice_p,
        &alice_signer,
        alice_cred,
        GroupId::from_slice(&[0x49; 16]),
        b.clone(),
        None,
    )
    .expect("create");
    let add = alice
        .add_members(&alice_p, &alice_signer, &[bob_kp.key_package().clone()])
        .expect("add_members");
    alice.merge_pending_commit(&alice_p).expect("merge");
    let mut bob = DillaGroup::join_from_welcome(
        &bob_p,
        into_welcome(add.welcomes[0].1.clone()),
        alice.export_ratchet_tree().into(),
        &b,
    )
    .expect("join");
    let add = alice
        .add_members(&alice_p, &alice_signer, &[carol_kp.key_package().clone()])
        .expect("add_members");
    let err = bob
        .process_message(&bob_p, into_protocol(add.commit))
        .expect_err("a member Add in a text group must be refused");
    assert!(
        matches!(
            err,
            MlsError::Protocol(ProtocolError::MemberRemoveForbidden)
        ),
        "{err:?}"
    );
}

/// An instance Add committed through `self_update` produces a Welcome, and it must reach the
/// added device: the bundle addresses it to the device the Add's KeyPackage names, which is what
/// the delivery service keys the Welcome queue on.
#[test]
fn a_committed_instance_add_addresses_its_welcome_to_the_added_device() {
    let alice_p = provider();
    let bob_p = provider();
    let (alice_signer, alice_cred) = signer_and_credential(0xaa, 0x01);
    let (bob_signer, bob_cred) = signer_and_credential(0xbb, 0x02);
    alice_signer.store(alice_p.storage()).expect("store signer");
    bob_signer.store(bob_p.storage()).expect("store signer");
    let bob_kp = build_key_package(&bob_p, &bob_signer, bob_cred, false).expect("key package");
    let instance_signer = SignatureKeyPair::new(CIPHERSUITE.signature_algorithm()).expect("keygen");
    let senders = external_senders(
        instance_signer.public().into(),
        &InstanceId::from_bytes([0x11; 16]),
    );
    let group_id = GroupId::from_slice(&[0x47; 16]);
    let b = binding(GroupKind::Text);
    let mut alice = DillaGroup::create(
        &alice_p,
        &alice_signer,
        alice_cred,
        group_id.clone(),
        b.clone(),
        Some(senders),
    )
    .expect("create");

    let proposal = ExternalProposal::new_add::<DillaProvider>(
        bob_kp.key_package().clone(),
        group_id,
        alice.epoch().into(),
        &instance_signer,
        instance_sender_index(),
    )
    .expect("external add proposal");
    let DillaProcessed::Proposal(queued) = alice
        .process_message(&alice_p, into_protocol(proposal))
        .expect("process")
    else {
        panic!("expected a queued proposal");
    };
    alice
        .store_pending_proposal(&alice_p, *queued)
        .expect("store the proposal");

    let bundle = alice.self_update(&alice_p, &alice_signer).expect("commit");
    alice.merge_pending_commit(&alice_p).expect("merge");
    assert_eq!(bundle.welcomes.len(), 1);
    assert_eq!(bundle.welcomes[0].0, DeviceId::from_bytes([0x02; 16]));
    let bob = DillaGroup::join_from_welcome(
        &bob_p,
        into_welcome(bundle.welcomes[0].1.clone()),
        alice.export_ratchet_tree().into(),
        &b,
    )
    .expect("the added device joins with the Welcome it was addressed");
    assert_eq!(bob.epoch(), alice.epoch());
}

/// Regression (fix round 1, finding 2): a database failure while `create_message` persists the
/// secret tree must reach the caller as `MlsError::NeedsReload`.
///
/// In the default build `CreateMessageError` has no `StorageError` variant at all: OpenMLS
/// flattens the `write_message_secrets` failure (mod.rs:834-838) into
/// `LibraryError::custom("Malformed plaintext")` (application.rs:104-110). The transaction rolls
/// back, but the in-memory `MlsGroup` has already ratcheted one application generation past the
/// committed state, so the handle is stale — gap-7 section 4 item 1.
#[test]
fn a_storage_failure_while_framing_a_message_reports_needs_reload() {
    let conn: ConnHandle = std::sync::Arc::new(Mutex::new(
        rusqlite::Connection::open_in_memory().expect("sqlite"),
    ));
    let alice_p = DillaProvider::new(conn.clone());
    alice_p.storage().migrate().expect("migrate");
    let (alice_signer, alice_cred) = signer_and_credential(0xaa, 0x01);
    alice_signer.store(alice_p.storage()).expect("store signer");

    let mut alice = DillaGroup::create(
        &alice_p,
        &alice_signer,
        alice_cred,
        GroupId::from_slice(&[0x44; 16]),
        binding(GroupKind::Text),
        None,
    )
    .expect("create");

    // `message_secrets` is a row of `openmls_group_data`, written through an upsert, so both the
    // insert and the update path have to be closed.
    conn.lock()
        .expect("lock")
        .execute_batch(
            "CREATE TRIGGER fail_secrets_insert BEFORE INSERT ON openmls_group_data
             WHEN NEW.data_type = 'message_secrets'
             BEGIN SELECT RAISE(ABORT, 'injected failure'); END;
             CREATE TRIGGER fail_secrets_update BEFORE UPDATE ON openmls_group_data
             WHEN NEW.data_type = 'message_secrets'
             BEGIN SELECT RAISE(ABORT, 'injected failure'); END;",
        )
        .expect("install triggers");

    let err = alice
        .create_message(&alice_p, &alice_signer, &envelope("does not get out"))
        .expect_err("the framing must fail");
    assert!(matches!(err, MlsError::NeedsReload), "{err:?}");
}

/// protocol/01-groups.md: a `GroupContextExtensions` proposal replaces the **whole** extension set
/// (gap-4 section 4.1), so a member who lands one can drop or rewrite `dilla_binding` and
/// `required_capabilities`. Only the instance rotates the extension set, as an external sender.
/// Here Alice is a plain member and rewrites the binding's `target_id`; Bob must refuse the commit
/// rather than hand it back as mergeable.
#[test]
fn a_member_commit_rewriting_the_group_context_extensions_is_refused_by_the_receiver() {
    let alice_p = provider();
    let bob_p = provider();
    let (alice_signer, alice_cred) = signer_and_credential(0xaa, 0x01);
    let (bob_signer, bob_cred) = signer_and_credential(0xbb, 0x02);
    alice_signer.store(alice_p.storage()).expect("store signer");
    bob_signer.store(bob_p.storage()).expect("store signer");
    let bob_kp = build_key_package(&bob_p, &bob_signer, bob_cred, false).expect("key package");

    let group_id = GroupId::from_slice(&[0x44; 16]);
    let b = binding(GroupKind::Text);
    let mut alice = DillaGroup::create(
        &alice_p,
        &alice_signer,
        alice_cred,
        group_id.clone(),
        b.clone(),
        None,
    )
    .expect("create");
    let add = alice
        .add_members(&alice_p, &alice_signer, &[bob_kp.key_package().clone()])
        .expect("add_members");
    alice.merge_pending_commit(&alice_p).expect("merge");
    let mut bob = DillaGroup::join_from_welcome(
        &bob_p,
        into_welcome(add.welcomes[0].1.clone()),
        alice.export_ratchet_tree().into(),
        &b,
    )
    .expect("join");

    // `DillaGroup` deliberately exposes no such commit, so the hostile member is driven through
    // the raw `MlsGroup` sitting in Alice's own storage - which is exactly what a patched client
    // would do.
    let mut raw = MlsGroup::load(alice_p.storage(), &group_id)
        .expect("load")
        .expect("alice's group is stored");
    let mut tampered = b.clone();
    tampered.target_id = [0x99; 16];
    let commit = raw
        .update_group_context_extensions(
            &alice_p,
            group_context_extensions(&tampered, None).expect("extensions"),
            &alice_signer,
        )
        .expect("a member can build the commit; the receiver is what must refuse it")
        .0;

    let err = bob
        .process_message(&bob_p, into_protocol(commit))
        .expect_err("a member GroupContextExtensions commit must be refused");
    assert!(
        matches!(
            err,
            MlsError::Protocol(ProtocolError::MemberRemoveForbidden)
        ),
        "{err:?}"
    );
    assert_eq!(
        bob.binding(),
        &b,
        "the refused commit must not have changed the binding Bob serves"
    );
}

/// Final-fix item 5. The policy table was enforced only on a commit, so a **standalone**
/// `GroupContextExtensions` proposal came back from `process_message` as an ordinary queued
/// proposal: nothing stopped a caller queueing it, and the next commit anyone builds carries it.
/// The proposal path now runs the same verdict.
#[test]
fn a_standalone_group_context_extensions_proposal_is_refused_rather_than_queued() {
    let alice_p = provider();
    let bob_p = provider();
    let (alice_signer, alice_cred) = signer_and_credential(0xaa, 0x01);
    let (bob_signer, bob_cred) = signer_and_credential(0xbb, 0x02);
    alice_signer.store(alice_p.storage()).expect("store signer");
    bob_signer.store(bob_p.storage()).expect("store signer");
    let bob_kp = build_key_package(&bob_p, &bob_signer, bob_cred, false).expect("key package");

    let group_id = GroupId::from_slice(&[0x44; 16]);
    let b = binding(GroupKind::Text);
    let mut alice = DillaGroup::create(
        &alice_p,
        &alice_signer,
        alice_cred,
        group_id.clone(),
        b.clone(),
        None,
    )
    .expect("create");
    let add = alice
        .add_members(&alice_p, &alice_signer, &[bob_kp.key_package().clone()])
        .expect("add_members");
    alice.merge_pending_commit(&alice_p).expect("merge");
    let mut bob = DillaGroup::join_from_welcome(
        &bob_p,
        into_welcome(add.welcomes[0].1.clone()),
        alice.export_ratchet_tree().into(),
        &b,
    )
    .expect("join");

    // Same shape as the commit test above: `DillaGroup` exposes no such proposal, so the hostile
    // member drives the raw `MlsGroup` in its own storage - what a patched client would do.
    let mut raw = MlsGroup::load(alice_p.storage(), &group_id)
        .expect("load")
        .expect("alice's group is stored");
    let mut tampered = b.clone();
    tampered.target_id = [0x99; 16];
    let (proposal, _) = raw
        .propose_group_context_extensions(
            &alice_p,
            group_context_extensions(&tampered, None).expect("extensions"),
            &alice_signer,
        )
        .expect("a member can build the proposal; the receiver is what must refuse it");

    let err = bob
        .process_message(&bob_p, into_protocol(proposal))
        .expect_err("a GroupContextExtensions proposal must not be handed back for queueing");
    assert!(
        matches!(
            err,
            MlsError::Protocol(ProtocolError::MemberRemoveForbidden)
        ),
        "{err:?}"
    );
    assert_eq!(
        bob.binding(),
        &b,
        "the refused proposal must not have changed the binding Bob serves"
    );
}

// ---------------------------------------------------------------------------------------------
// Task 11: the delivery service's structural view of the same group.
// ---------------------------------------------------------------------------------------------

#[test]
fn the_ds_view_tracks_the_group_from_a_group_info_and_a_tree() {
    let alice_p = provider();
    let (alice_signer, alice_cred) = signer_and_credential(0xaa, 0x01);
    alice_signer.store(alice_p.storage()).expect("store signer");
    let b = binding(GroupKind::Text);
    let alice = DillaGroup::create(
        &alice_p,
        &alice_signer,
        alice_cred,
        GroupId::from_slice(&[0x44; 16]),
        b.clone(),
        None,
    )
    .expect("create");

    let info_message = alice
        .export_group_info(&alice_p, &alice_signer)
        .expect("group info");
    let verifiable = into_group_info(info_message);
    let crypto = openmls_rust_crypto::RustCrypto::default();
    let (ds, _committer_info) =
        DillaPublicGroup::from_external(&crypto, alice.export_ratchet_tree().into(), verifiable)
            .expect("from_external");

    assert_eq!(ds.epoch(), alice.epoch());
    assert_eq!(ds.group_id(), alice.group_id());
    assert_eq!(ds.binding(), &b);
    assert_eq!(ds.members().len(), 1);
    assert!(ds.required_capabilities().is_some());

    // The tree hash the DS serves is the one in the group context it validated, and it is not
    // empty: a joiner compares this against the GroupInfo before trusting the membership list.
    assert!(!ds.tree_hash().is_empty());
    assert_eq!(ds.tree_hash().len(), 32, "SHA-256 over the tree");
}

#[test]
fn the_ds_view_processes_a_commit_merges_it_and_advances_the_epoch() {
    let alice_p = provider();
    let bob_p = provider();
    let (alice_signer, alice_cred) = signer_and_credential(0xaa, 0x01);
    let (bob_signer, bob_cred) = signer_and_credential(0xbb, 0x02);
    alice_signer.store(alice_p.storage()).expect("store signer");
    bob_signer.store(bob_p.storage()).expect("store signer");
    let bob_kp = build_key_package(&bob_p, &bob_signer, bob_cred, false).expect("key package");

    let b = binding(GroupKind::Text);
    let mut alice = DillaGroup::create(
        &alice_p,
        &alice_signer,
        alice_cred,
        GroupId::from_slice(&[0x44; 16]),
        b.clone(),
        None,
    )
    .expect("create");

    let info_message = alice
        .export_group_info(&alice_p, &alice_signer)
        .expect("group info");
    let verifiable = into_group_info(info_message);
    let crypto = openmls_rust_crypto::RustCrypto::default();
    let (mut ds, _) =
        DillaPublicGroup::from_external(&crypto, alice.export_ratchet_tree().into(), verifiable)
            .expect("from_external");
    let before = ds.export_state();

    let bundle = alice
        .add_members(&alice_p, &alice_signer, &[bob_kp.key_package().clone()])
        .expect("add_members");
    alice.merge_pending_commit(&alice_p).expect("merge");

    let commit = into_protocol(bundle.commit);
    let staged = match ds.process_message(&crypto, commit).expect("process") {
        PublicProcessed::StagedCommit { staged, .. } => *staged,
        other => panic!("expected a staged commit, got {other:?}"),
    };
    ds.merge_commit(staged).expect("merge_commit");

    assert_eq!(ds.epoch(), alice.epoch());
    assert_eq!(ds.members().len(), 2);
    assert_ne!(
        ds.export_state(),
        before,
        "merging must change the exported state"
    );

    // and the exported state reloads into an equivalent view
    let reloaded =
        DillaPublicGroup::import_state(&ds.export_state(), alice.group_id()).expect("import");
    assert_eq!(reloaded.epoch(), ds.epoch());
    assert_eq!(reloaded.tree_hash(), ds.tree_hash());
}

#[test]
fn the_ds_view_refuses_an_application_message() {
    let alice_p = provider();
    let (alice_signer, alice_cred) = signer_and_credential(0xaa, 0x01);
    alice_signer.store(alice_p.storage()).expect("store signer");
    let b = binding(GroupKind::Text);
    let mut alice = DillaGroup::create(
        &alice_p,
        &alice_signer,
        alice_cred,
        GroupId::from_slice(&[0x44; 16]),
        b,
        None,
    )
    .expect("create");
    let info_message = alice
        .export_group_info(&alice_p, &alice_signer)
        .expect("group info");
    let verifiable = into_group_info(info_message);
    let crypto = openmls_rust_crypto::RustCrypto::default();
    let (ds, _) =
        DillaPublicGroup::from_external(&crypto, alice.export_ratchet_tree().into(), verifiable)
            .expect("from_external");

    let message = alice
        .create_message(&alice_p, &alice_signer, &envelope("hello"))
        .expect("create_message");
    let protocol = into_protocol(message);
    match ds.process_message(&crypto, protocol).expect("process") {
        PublicProcessed::Rejected(_) => {}
        other => panic!("the DS must never accept a PrivateMessage, got {other:?}"),
    }
}

#[test]
fn validate_key_package_requires_the_binding_capability() {
    let bob_p = provider();
    let (bob_signer, bob_cred) = signer_and_credential(0xbb, 0x02);
    bob_signer.store(bob_p.storage()).expect("store signer");
    let crypto = openmls_rust_crypto::RustCrypto::default();

    let good = build_key_package(&bob_p, &bob_signer, bob_cred.clone(), false).expect("kp");
    let good_in: KeyPackageIn = good.key_package().clone().into();
    assert!(validate_key_package(&crypto, good_in).is_ok());

    let plain = KeyPackage::builder()
        .build(CIPHERSUITE, &bob_p, &bob_signer, bob_cred)
        .expect("kp");
    let plain_in: KeyPackageIn = plain.key_package().clone().into();
    let err = validate_key_package(&crypto, plain_in).expect_err("0xF001 is mandatory");
    assert!(
        matches!(err, PublicGroupError::Protocol(ProtocolError::Binding)),
        "{err:?}"
    );
}

/// NV-4 and deviation A2-11, both settled by ruling: `queue_proposal` is the only route from a
/// received proposal message to a queued proposal, and what `queued_proposals()` hands back is the
/// **`MLSMessage` the DS received**, byte for byte - not a re-serialised bare `Proposal`, which has
/// lost its `FramedContent` and its signature and which no client could process.
///
/// Ledger ruling A extends it: those bytes ride inside `export_state()`, so a dillad restart does
/// not lose a pending proposal.
#[test]
fn queue_proposal_keeps_the_mls_message_the_ds_received() {
    use tls_codec::{Deserialize as _, Serialize as _};

    let alice_p = provider();
    let bob_p = provider();
    let (alice_signer, alice_cred) = signer_and_credential(0xaa, 0x01);
    let (bob_signer, bob_cred) = signer_and_credential(0xbb, 0x02);
    alice_signer.store(alice_p.storage()).expect("store signer");
    bob_signer.store(bob_p.storage()).expect("store signer");
    let bob_kp = build_key_package(&bob_p, &bob_signer, bob_cred, false).expect("key package");

    // The instance key the DS signs external proposals with, installed as external sender 0 -
    // without it `PublicGroup::process_message` has nothing to verify the proposal against.
    let instance = SignatureKeyPair::new(CIPHERSUITE.signature_algorithm()).expect("keygen");
    let instance_id = InstanceId::from_bytes([0x11; 16]);
    let b = binding(GroupKind::Text);
    let mut alice = DillaGroup::create(
        &alice_p,
        &alice_signer,
        alice_cred,
        GroupId::from_slice(&[0x44; 16]),
        b,
        Some(external_senders(instance.public().into(), &instance_id)),
    )
    .expect("create");

    // Bob joins, so leaf 1 exists and can be the target of the Remove.
    let _bundle = alice
        .add_members(&alice_p, &alice_signer, &[bob_kp.key_package().clone()])
        .expect("add_members");
    alice.merge_pending_commit(&alice_p).expect("merge");

    let info_message = alice
        .export_group_info(&alice_p, &alice_signer)
        .expect("group info");
    let crypto = openmls_rust_crypto::RustCrypto::default();
    let (mut ds, _) = DillaPublicGroup::from_external(
        &crypto,
        alice.export_ratchet_tree().into(),
        into_group_info(info_message),
    )
    .expect("from_external");

    // The DS proposes removing Bob, exactly as export 17 does, and then feeds its own message back
    // in over the wire, exactly as export 13 op 0 does.
    let out = external_propose_remove(
        LeafNodeIndex::new(1),
        alice.group_id().clone(),
        GroupEpoch::from(ds.epoch()),
        &instance,
    )
    .expect("external Remove proposal");
    let wire = out.tls_serialize_detached().expect("serialize");

    let received = MlsMessageIn::tls_deserialize_exact(&wire)
        .expect("deserialize")
        .try_into_protocol_message()
        .expect("a proposal is a ProtocolMessage");
    let reference = ds
        .queue_proposal(&crypto, received)
        .expect("queue_proposal");
    assert!(
        !reference.is_empty(),
        "queue_proposal returns the new proposal's reference bytes"
    );

    let queued = ds.queued_proposals().expect("queued_proposals");
    assert_eq!(queued.len(), 1);
    assert_eq!(
        queued[0].0.as_slice(),
        reference.as_slice(),
        "the reference is the queued one"
    );
    assert_eq!(
        queued[0].1, wire,
        "the DS must hand back the MLSMessage it received, byte for byte (deviation A2-11)"
    );

    // Ledger ruling A: the kept bytes are part of the exported state.
    let reloaded =
        DillaPublicGroup::import_state(&ds.export_state(), alice.group_id()).expect("import");
    let after_restart = reloaded.queued_proposals().expect("queued_proposals");
    assert_eq!(after_restart.len(), 1);
    assert_eq!(
        after_restart[0].1, wire,
        "a pending proposal must survive a dillad restart (ledger ruling A)"
    );

    // Removing the proposal drops the kept bytes with it: the map is bounded by the queue.
    ds.remove_proposal(&queued[0].0).expect("remove_proposal");
    assert!(ds.queued_proposals().expect("queued_proposals").is_empty());
}

/// Fix round 1, finding 1. `binding()` is what interfaces section 2.10 export 12
/// (`public_group_state`) serves to clients, so it must never contradict the group context the DS
/// itself holds. A GroupContextExtensions commit rewrites that context: `PublicGroup::merge_commit`
/// replaces it wholesale (`merge_diff`), and the DS runs no dilla-level commit policy - unlike
/// `DillaGroup::process_message`, which refuses such a commit outright - so one really can reach
/// `merge_commit` here. The cached binding must move with it.
#[test]
fn the_ds_view_re_derives_its_binding_when_a_commit_rewrites_the_group_context() {
    let alice_p = provider();
    let (alice_signer, alice_cred) = signer_and_credential(0xaa, 0x01);
    alice_signer.store(alice_p.storage()).expect("store signer");

    let group_id = GroupId::from_slice(&[0x44; 16]);
    let b = binding(GroupKind::Text);
    let alice = DillaGroup::create(
        &alice_p,
        &alice_signer,
        alice_cred,
        group_id.clone(),
        b.clone(),
        None,
    )
    .expect("create");

    let info_message = alice
        .export_group_info(&alice_p, &alice_signer)
        .expect("group info");
    let verifiable = into_group_info(info_message);
    let crypto = openmls_rust_crypto::RustCrypto::default();
    let (mut ds, _) =
        DillaPublicGroup::from_external(&crypto, alice.export_ratchet_tree().into(), verifiable)
            .expect("from_external");
    assert_eq!(ds.binding(), &b);

    // A member rewrites `dilla_binding`. `DillaGroup` exposes no such commit, so it is driven
    // through the raw `MlsGroup` in Alice's storage - exactly what a patched client would do.
    let mut raw = MlsGroup::load(alice_p.storage(), &group_id)
        .expect("load")
        .expect("alice's group is stored");
    let mut rewritten = b.clone();
    rewritten.policy_version = 7;
    let commit = raw
        .update_group_context_extensions(
            &alice_p,
            group_context_extensions(&rewritten, None).expect("extensions"),
            &alice_signer,
        )
        .expect("a member can build the commit")
        .0;

    let staged = match ds
        .process_message(&crypto, into_protocol(commit))
        .expect("process")
    {
        PublicProcessed::StagedCommit { staged, .. } => *staged,
        other => panic!("expected a staged commit, got {other:?}"),
    };
    ds.merge_commit(staged).expect("merge_commit");

    assert_eq!(
        ds.binding(),
        &rewritten,
        "the merged group context is what the DS must serve"
    );
    // The same view rebuilt from the exported state derives the binding from scratch, so it is the
    // arbiter of what the DS's own state actually says.
    let reloaded = DillaPublicGroup::import_state(&ds.export_state(), &group_id).expect("import");
    assert_eq!(
        ds.binding(),
        reloaded.binding(),
        "the cached binding must not contradict the stored group context"
    );
}

/// The KeyPackage wire round trip a delivery service performs on `POST /v1/keypackages`.
fn into_key_package_in(kp: &KeyPackage) -> KeyPackageIn {
    use tls_codec::{Deserialize as _, Serialize as _};
    let bytes = MlsMessageOut::from(kp.clone())
        .tls_serialize_detached()
        .expect("serialize");
    match MlsMessageIn::tls_deserialize_exact(&bytes)
        .expect("deserialize")
        .extract()
    {
        MlsMessageBodyIn::KeyPackage(kp) => kp,
        other => panic!("expected a KeyPackage message, got {other:?}"),
    }
}

/// RFC 9420 section 10.1: every extension a KeyPackage carries must be listed in its leaf's
/// capabilities, and `last_resort` is not a default extension type (gap-5 section 4.2). A
/// last-resort package whose leaf does not advertise it is refused by `KeyPackageIn::validate`
/// with `UnsupportedExtension`, which is what the instance's `validate_key_package` runs - so every
/// device's `POST /v1/keypackages` failed on the one package it must always publish.
#[test]
fn a_last_resort_key_package_validates_as_the_instance_validates_it() {
    let p = provider();
    let (signer, cred) = signer_and_credential(0xaa, 0x01);
    signer.store(p.storage()).expect("store signer");
    for last_resort in [false, true] {
        let kp = build_key_package(&p, &signer, cred.clone(), last_resort).expect("key package");
        let validated = validate_key_package(
            openmls_traits::OpenMlsProvider::crypto(&p),
            into_key_package_in(kp.key_package()),
        )
        .unwrap_or_else(|e| panic!("last_resort = {last_resort}: {e:?}"));
        assert_eq!(validated.last_resort(), last_resort);
    }
}

/// Invariant 4: the GroupInfo a committer uploads must be the one of epoch n + 1, the epoch its
/// commit creates. A client that exports the GroupInfo before merging uploads epoch n, and one that
/// merges first cannot take the commit back when the instance refuses it - so the commit itself
/// must carry the n + 1 GroupInfo, signed, without the ratchet tree, with the external public key.
#[test]
fn every_commit_carries_the_group_info_of_the_epoch_it_creates() {
    let alice_p = provider();
    let bob_p = provider();
    let (alice_signer, alice_cred) = signer_and_credential(0xaa, 0x01);
    let (bob_signer, bob_cred) = signer_and_credential(0xbb, 0x02);
    alice_signer.store(alice_p.storage()).expect("store signer");
    bob_signer.store(bob_p.storage()).expect("store signer");
    let bob_kp = build_key_package(&bob_p, &bob_signer, bob_cred, false).expect("key package");
    let mut alice = DillaGroup::create(
        &alice_p,
        &alice_signer,
        alice_cred,
        GroupId::from_slice(&[0x45; 16]),
        binding(GroupKind::Text),
        None,
    )
    .expect("create");

    let check = |bundle: &CommitBundle, group: &DillaGroup, before: u64| {
        let info = bundle
            .group_info
            .as_ref()
            .expect("the commit carries its GroupInfo");
        assert_eq!(info.group_context().epoch().as_u64(), before + 1);
        assert!(
            info.extensions().ratchet_tree().is_none(),
            "invariant 2: without the tree"
        );
        assert!(
            info.extensions().external_pub().is_some(),
            "an external joiner needs the external public key"
        );
        // After the merge it is exactly the group's own epoch.
        assert_eq!(info.group_context().epoch().as_u64(), group.epoch());
    };

    let bundle = alice
        .add_members(&alice_p, &alice_signer, &[bob_kp.key_package().clone()])
        .expect("add");
    alice.merge_pending_commit(&alice_p).expect("merge");
    check(&bundle, &alice, 0);

    let bundle = alice.self_update(&alice_p, &alice_signer).expect("update");
    alice.merge_pending_commit(&alice_p).expect("merge");
    check(&bundle, &alice, 1);

    let bundle = alice
        .remove_members(&alice_p, &alice_signer, &[LeafNodeIndex::new(1)])
        .expect("remove");
    alice.merge_pending_commit(&alice_p).expect("merge");
    check(&bundle, &alice, 2);
}

/// C22: the epoch on a received application message is the epoch it was SENT in. A message of
/// epoch 1 delivered after the commit that moved the receiver to epoch 2 must say 1; a reading of
/// the receiver's own epoch would say 2.
#[test]
fn an_application_message_carries_the_epoch_it_was_sent_in() {
    let alice_p = provider();
    let bob_p = provider();
    let (alice_signer, alice_cred) = signer_and_credential(0xaa, 0x01);
    let (bob_signer, bob_cred) = signer_and_credential(0xbb, 0x02);
    alice_signer.store(alice_p.storage()).expect("store signer");
    bob_signer.store(bob_p.storage()).expect("store signer");
    let bob_kp = build_key_package(&bob_p, &bob_signer, bob_cred, false).expect("key package");

    let b = binding(GroupKind::Text);
    let mut alice = DillaGroup::create(
        &alice_p,
        &alice_signer,
        alice_cred,
        GroupId::from_slice(&[0x44; 16]),
        b.clone(),
        None,
    )
    .expect("create");
    let bundle = alice
        .add_members(&alice_p, &alice_signer, &[bob_kp.key_package().clone()])
        .expect("add_members");
    alice.merge_pending_commit(&alice_p).expect("merge");
    let welcome = into_welcome(bundle.welcomes[0].1.clone());
    let mut bob =
        DillaGroup::join_from_welcome(&bob_p, welcome, alice.export_ratchet_tree().into(), &b)
            .expect("join");
    assert_eq!(bob.epoch(), 1);

    let late = alice
        .create_message(&alice_p, &alice_signer, &envelope("sent before the update"))
        .expect("create_message");
    let update = alice
        .self_update(&alice_p, &alice_signer)
        .expect("self_update");
    alice.merge_pending_commit(&alice_p).expect("merge update");
    match bob
        .process_message(&bob_p, into_protocol(update.commit))
        .expect("process the update")
    {
        DillaProcessed::StagedCommit(staged) => bob
            .merge_staged_commit(&bob_p, *staged)
            .expect("merge the update"),
        other => panic!("expected a staged commit, got {other:?}"),
    }
    assert_eq!(bob.epoch(), 2);

    match bob
        .process_message(&bob_p, into_protocol(late))
        .expect("a text group keeps past-epoch secrets, so the late message decrypts")
    {
        DillaProcessed::Application(got) => {
            assert_eq!(got.epoch, 1, "the message's epoch, not the receiver's");
            assert_eq!(got.sender_leaf, 0);
            assert_eq!(got.sender.device_id, DeviceId::from_bytes([0x01; 16]));
            assert_eq!(got.envelope.body, "sent before the update");
        }
        other => panic!("expected an application message, got {other:?}"),
    }
}

/// C22: a member leaf whose basic credential is not a dilla `CredentialIdentity` yields no sender;
/// the message is refused with E_CREDENTIAL, which the client stores as a cannot-decrypt reason.
#[test]
fn an_application_message_from_a_leaf_without_a_dilla_identity_is_e_credential() {
    let alice_p = provider();
    let bob_p = provider();
    let alice_signer = SignatureKeyPair::new(CIPHERSUITE.signature_algorithm()).expect("keygen");
    alice_signer.store(alice_p.storage()).expect("store signer");
    let alice_cred = CredentialWithKey {
        credential: BasicCredential::new(b"not a dilla credential".to_vec()).into(),
        signature_key: alice_signer.public().into(),
    };
    let (bob_signer, bob_cred) = signer_and_credential(0xbb, 0x02);
    bob_signer.store(bob_p.storage()).expect("store signer");
    let bob_kp = build_key_package(&bob_p, &bob_signer, bob_cred, false).expect("key package");

    let b = binding(GroupKind::Text);
    let mut alice = DillaGroup::create(
        &alice_p,
        &alice_signer,
        alice_cred,
        GroupId::from_slice(&[0x44; 16]),
        b.clone(),
        None,
    )
    .expect("create: the creator's own credential is never decoded");
    let bundle = alice
        .add_members(&alice_p, &alice_signer, &[bob_kp.key_package().clone()])
        .expect("add_members decodes only the joiner's credential");
    alice.merge_pending_commit(&alice_p).expect("merge");
    let welcome = into_welcome(bundle.welcomes[0].1.clone());
    let mut bob =
        DillaGroup::join_from_welcome(&bob_p, welcome, alice.export_ratchet_tree().into(), &b)
            .expect("join");

    let message = alice
        .create_message(&alice_p, &alice_signer, &envelope("from a foreign leaf"))
        .expect("create_message");
    let err = bob
        .process_message(&bob_p, into_protocol(message))
        .expect_err("a leaf whose credential is not a CredentialIdentity must not yield a sender");
    assert!(
        matches!(err, MlsError::Protocol(ProtocolError::Credential)),
        "{err:?}"
    );
}

/// The received message's Debug names the routing facts and nothing a log must not hold.
#[test]
fn received_application_debug_prints_no_body_and_no_credential_material() {
    use dilla_core::identity::CredentialIdentity;
    let mut env = envelope("a body that must never reach a log line");
    env.k_f = [0x5a; 32];
    let got = ReceivedApplication {
        envelope: env,
        sender_leaf: 3,
        sender: CredentialIdentity::decode(&identity(0xbb, 0x02)).expect("decode"),
        epoch: 7,
    };
    let printed = format!("{got:?}");
    assert!(printed.starts_with("ReceivedApplication {"), "{printed}");
    assert!(printed.contains("sender_leaf: 3"), "{printed}");
    assert!(
        printed.contains(&format!(
            "sender_device: {:?}",
            DeviceId::from_bytes([0x02; 16])
        )),
        "{printed}"
    );
    assert!(printed.contains("epoch: 7"), "{printed}");
    assert!(
        printed.contains(&format!("msg_id: {:?}", MsgId::from_bytes([0x01; 16]))),
        "{printed}"
    );
    assert!(!printed.contains("a body that must never"), "{printed}");
    assert!(!printed.contains("90, 90"), "k_f bytes leaked: {printed}");
    assert!(!printed.contains("umk_pub"), "{printed}");
    assert!(!printed.contains("sig_ssk_dev"), "{printed}");
    assert!(!printed.contains("Envelope"), "{printed}");
}
