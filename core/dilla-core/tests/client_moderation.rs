#![cfg(not(target_arch = "wasm32"))]

use dilla_core::bot::RemovalProof;
use dilla_core::cbor::decode_strict;
use dilla_core::client::{ClientCore, ClientError};
use dilla_core::ids::{CommunityId, DeviceId, MsgId, UserId};
use dilla_core::mls::ConnHandle;
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use std::sync::{Arc, Mutex};

mod client_support;
use client_support::{COMMUNITY, Instance, NOW, ready_core_with_key};

const GROUP: [u8; 16] = [0x61; 16];
const CHANNEL: [u8; 16] = [0x62; 16];
const DM_GROUP: [u8; 16] = [0x63; 16];
const DM_CHANNEL: [u8; 16] = [0x64; 16];
const REQUEST: [u8; 16] = [0x71; 16];
const TARGET_SEQUENCE: u64 = 41;

fn conn() -> ConnHandle {
    Arc::new(Mutex::new(
        rusqlite::Connection::open_in_memory().expect("sqlite"),
    ))
}

fn parts(body: &[u8]) -> (Vec<u8>, [u8; 64]) {
    decode_strict(body, |d| {
        d.array(2)?;
        Ok((d.bytes()?.to_vec(), d.bytes_exact()?))
    })
    .expect("[proof, signature]")
}

fn dsk(core: &client_support::Core) -> [u8; 32] {
    let guard = core.probe.lock().expect("connection lock");
    let raw: Vec<u8> = guard
        .query_row("SELECT v FROM app_meta WHERE k='identity'", [], |r| {
            r.get(0)
        })
        .expect("identity record");
    decode_strict(&raw, |d| {
        d.array(13)?;
        d.uint()?;
        d.bytes_exact::<16>()?;
        d.bytes_exact::<16>()?;
        d.bytes_exact::<16>()?;
        let dsk = d.bytes_exact::<32>()?;
        for _ in 0..8 {
            d.skip()?;
        }
        Ok(dsk)
    })
    .expect("identity dsk")
}

fn err<T: core::fmt::Debug>(r: Result<T, ClientError>) -> ClientError {
    r.expect_err("operation should be refused")
}

#[test]
fn removal_proof_derives_actor_and_signs_exact_domain_for_active_community_group() {
    let (mut core, _) = ready_core_with_key(0x41, "moderator");
    let instance = Instance::generate();
    core.core
        .group_create(&GROUP, Some(&COMMUNITY), &CHANNEL, 1, &instance.public())
        .expect("create group");
    core.core.group_registered(&GROUP, 1).expect("active group");

    let body = core
        .core
        .sign_removal(&REQUEST, &GROUP, TARGET_SEQUENCE, NOW + 30, NOW)
        .expect("sign removal");
    let (proof_bytes, signature) = parts(&body);
    let proof = RemovalProof::decode(&proof_bytes).expect("proof");
    assert_eq!(proof.request_id, MsgId::from_bytes(REQUEST));
    assert_eq!(proof.actor_user, UserId::from_bytes(core.user));
    assert_eq!(proof.actor_device, DeviceId::from_bytes(core.device));
    assert_eq!(proof.community_id, CommunityId::from_bytes(COMMUNITY));
    assert_eq!(proof.group_id, MsgId::from_bytes(GROUP));
    assert_eq!(proof.target_seq, TARGET_SEQUENCE);
    assert_eq!(proof.expires, NOW + 30);
    let verifying = VerifyingKey::from_bytes(&dsk(&core)).expect("device public key");
    verifying
        .verify(
            &proof.signature_preimage().expect("domain preimage"),
            &Signature::from_bytes(&signature),
        )
        .expect("signature uses the registered device key");
}

#[test]
fn manual_removal_evidence_is_durable_and_follows_the_acceptance_state() {
    let (mut core, _) = ready_core_with_key(0x49, "moderator");
    let instance = Instance::generate();
    core.core
        .group_create(&GROUP, Some(&COMMUNITY), &CHANNEL, 1, &instance.public())
        .expect("create group");
    core.core.group_registered(&GROUP, 1).expect("active group");

    let evidence_id = [0x72; 16];
    let body = core
        .core
        .prepare_manual_removal_evidence(
            &REQUEST,
            &evidence_id,
            &COMMUNITY,
            &GROUP,
            &CHANNEL,
            &[0x73; 16],
            TARGET_SEQUENCE,
            "reviewed by moderator",
            "bounded excerpt",
            NOW,
            NOW + 30,
            NOW,
        )
        .expect("persist signed evidence before POST");
    let pending = core
        .core
        .manual_removal_evidence()
        .expect("read durable evidence");
    assert_eq!(pending.len(), 1);
    assert_eq!(pending[0].proof_request_id, REQUEST);
    assert_eq!(pending[0].evidence_request_id, evidence_id);
    assert_eq!(pending[0].signed_body, body);
    assert_eq!(pending[0].reason, "reviewed by moderator");
    assert_eq!(pending[0].excerpt, "bounded excerpt");
    assert_eq!(pending[0].state, 0);

    core.core
        .mark_manual_removal_submitted(&REQUEST)
        .expect("mark before POST");
    assert_eq!(core.core.manual_removal_evidence().unwrap()[0].state, 1);
    core.core
        .mark_manual_removal_accepted(&REQUEST)
        .expect("authoritative acceptance");
    assert_eq!(core.core.manual_removal_evidence().unwrap()[0].state, 2);
    let first = core
        .core
        .ensure_manual_removal_evidence_request(&REQUEST, &[0x74; 16], NOW)
        .unwrap();
    assert_eq!(first, (evidence_id, NOW + 30));
    let rotated = core
        .core
        .ensure_manual_removal_evidence_request(&REQUEST, &[0x75; 16], NOW + 31)
        .unwrap();
    assert_eq!(rotated, ([0x75; 16], NOW + 61));
    let persisted = &core.core.manual_removal_evidence().unwrap()[0];
    assert_eq!(persisted.evidence_request_id, [0x75; 16]);
    assert_eq!(persisted.evidence_expires, NOW + 61);
    let stable = core
        .core
        .ensure_manual_removal_evidence_request(&REQUEST, &[0x76; 16], NOW + 32)
        .unwrap();
    assert_eq!(stable, rotated);
    core.core
        .complete_manual_removal_evidence(&REQUEST, NOW + 1)
        .expect("evidence accepted");
    assert!(core.core.manual_removal_evidence().unwrap().is_empty());
}

#[test]
fn removal_signing_rejects_invalid_window_unbound_and_interaction_groups() {
    let (mut core, _) = ready_core_with_key(0x42, "moderator");
    let instance = Instance::generate();
    core.core
        .group_create(&GROUP, Some(&COMMUNITY), &CHANNEL, 1, &instance.public())
        .expect("create community group");
    core.core.group_registered(&GROUP, 1).expect("active group");
    core.core
        .group_create(&DM_GROUP, None, &DM_CHANNEL, 1, &instance.public())
        .expect("create DM group");
    core.core.group_registered(&DM_GROUP, 1).expect("active DM");

    assert_eq!(
        err(core.core.sign_removal(&REQUEST, &GROUP, 0, NOW + 1, NOW)).code,
        "E_CORE_INPUT"
    );
    assert_eq!(
        err(core.core.sign_removal(&REQUEST, &GROUP, 1, NOW, NOW)).code,
        "E_CORE_INPUT"
    );
    assert_eq!(
        err(core.core.sign_removal(&REQUEST, &GROUP, 1, NOW + 31, NOW)).code,
        "E_CORE_INPUT"
    );
    assert_eq!(
        err(core.core.sign_removal(&REQUEST, &DM_GROUP, 1, NOW + 1, NOW)).code,
        "E_CORE_STATE"
    );

    let guard = core.probe.lock().expect("connection lock");
    guard.execute(
        "INSERT INTO app_groups(group_id,kind,community_id,target_id,state) VALUES(?1,3,NULL,?2,2)",
        rusqlite::params![[0x65u8; 16].as_slice(), [0x66u8; 16].as_slice()],
    ).expect("interaction row");
    drop(guard);
    assert_eq!(
        err(core
            .core
            .sign_removal(&REQUEST, &[0x65; 16], 1, NOW + 1, NOW))
        .code,
        "E_CORE_STATE"
    );
}

#[test]
fn bot_removal_signing_refuses_another_community() {
    let connection = conn();
    let mut core = ClientCore::open(connection.clone()).expect("open");
    let community = [0x22; 16];
    core.bot_bootstrap_begin(&[0x11; 16], &community, &[0x33; 16], &[0x77; 32])
        .expect("bot begin");
    core.bot_bootstrap_complete(&[0x44; 16], "bot", NOW)
        .expect("bot complete");
    let instance = Instance::generate();
    core.group_create(&GROUP, Some(&[0x55; 16]), &CHANNEL, 1, &instance.public())
        .expect("create other community group");
    core.group_registered(&GROUP, 1).expect("active group");
    assert_eq!(
        err(core.sign_removal(&REQUEST, &GROUP, 1, NOW + 1, NOW)).code,
        "E_CORE_STATE"
    );
}
