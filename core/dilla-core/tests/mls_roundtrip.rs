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
        DillaProcessed::Application(got) => assert_eq!(got, env),
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
