//! Call groups in the browser core: kind-aware holders, the media epoch and its send-block gate.
// Native only, like tests/client_trust.rs: every test opens an in-memory SQLite connection.
#![cfg(not(target_arch = "wasm32"))]
mod client_support;
use client_support::*;
use dilla_core::cbor::decode_strict;

/// A plain text message request (`client_support::request` with type 0, no reply, no attachment).
fn request(body: &str) -> Vec<u8> {
    client_support::request(0, None, body, &[])
}

#[test]
fn a_dm_call_group_never_collides_with_its_text_group() {
    let instance = Instance::generate();
    let mut text = Relay::new(GROUP);
    let mut call = Relay::new(CALL);
    let mut alice = ready_core(0xa1, "alice");
    alice.create_and_register_in(&mut text, &instance, None, &DM);
    alice.call_create_and_register(&mut call, &instance, None, &DM);
    assert_eq!(alice.group(&GROUP).unwrap().kind, 0);
    assert_eq!(alice.group(&CALL).unwrap().kind, 1);
    assert!(alice.timeline(&CALL).is_empty());
    let id = alice.prepare_request(&GROUP, &request("hello"), NOW);
    assert_eq!(id.len(), 16);
}

#[test]
fn the_media_epoch_is_the_exporter_key_roster_and_six_by_five_code() {
    let (call, alice, bob, _) = call_raw_bob();
    let m = decode_media_epoch(&alice.core.call_media_epoch(&CALL).expect("media epoch"));
    assert_eq!(
        m.base_key,
        bob.group
            .as_ref()
            .unwrap()
            .sframe_base_key(&bob.provider)
            .unwrap()
    );
    assert_eq!(m.roster.len(), 2);
    assert_eq!(
        m.code.split(' ').map(str::len).collect::<Vec<_>>(),
        vec![5; 6]
    );
    let _ = call;
}

/// Attacker: a malicious instance (or a member colluding with it) adds a leaf under a key no
/// validated list presents, so it would receive this device's call audio. The core reads the
/// verdict from its own live tree; neither the worker nor the instance can skip the check.
#[test]
fn no_media_key_while_a_leaf_of_the_call_group_fails_validation() {
    let (mut call, mut alice, bob, v1) = call_raw_bob();
    assert!(alice.core.call_media_epoch(&CALL).is_ok());
    let mut forged = RawPeer::new_with_keys(0xb2, 0xd4, 0xb2, 0xf2);
    forged.join_external_call(&mut call);
    alice.sync(&call);
    assert_eq!(
        code(alice.core.call_media_epoch(&CALL)),
        "E_DEVICE_UNLISTED"
    );
    let v2 = sec_next(
        &v1,
        vec![v1.unsigned.entries[0].clone(), sec_entry(&forged)],
        0xf2,
    );
    call_ingest(&mut alice, &call, &bob.user, forged.device, &[&v1, &v2]);
    assert!(alice.core.call_media_epoch(&CALL).is_ok());
}

#[test]
fn no_media_key_after_a_changed_identity_joins_the_call() {
    let (mut call, mut alice, bob, v1) = call_raw_bob();
    let mut rotated = RawPeer::new_with_keys(0xb2, 0xd4, 0xd5, 0xd6);
    rotated.join_external_call(&mut call);
    alice.sync(&call);
    let v2 = sec_next(&v1, vec![sec_entry(&rotated)], 0xd6);
    call_ingest(&mut alice, &call, &bob.user, rotated.device, &[&v1, &v2]);
    assert_eq!(code(alice.core.call_media_epoch(&CALL)), "E_UMK_CHANGED");
}

/// Attacker: an instance serving a GroupInfo and tree that already holds a forged leaf. The join
/// fails before an external commit exists, so the forged leaf never gets an epoch this device enters.
#[test]
fn joining_a_call_group_that_already_holds_a_failed_leaf_is_refused_before_any_commit() {
    let instance = Instance::generate();
    let mut call = Relay::new(CALL);
    let mut bob = RawPeer::new(0xb2, 0xb3);
    bob.create_call(&mut call, &instance);
    let mut forged = RawPeer::new_with_keys(0xb2, 0xd4, 0xb2, 0xf2);
    forged.join_external_call(&mut call);
    let mut alice = ready_core(0xa1, "alice");
    pin_list(&mut alice, &bob);
    let before = call.handshakes_from(0).len();
    let r = alice.core.call_group_join_external(
        &CALL,
        Some(&COMMUNITY),
        &VOICE,
        POLICY,
        &call.info_body(),
        &call.tree_body(),
    );
    assert_eq!(code(r), "E_DEVICE_UNLISTED");
    assert!(alice.group(&CALL).is_none());
    assert_eq!(call.handshakes_from(0).len(), before);
}

/// L-CORE-52: a call group carries no messages. An application message a member uploads to it is
/// skipped (never decrypted, stored or folded) while `next_seq` moves past it, and sending to it
/// is refused before anything is queued.
#[test]
fn a_call_group_skips_messages_and_refuses_sending() {
    let (mut call, mut alice, mut bob, _) = call_raw_bob();
    let seq = bob.send(&mut call, "not a call payload");
    let applied = alice.sync(&call);
    assert!(applied.new_seqs.is_empty(), "nothing listed: {applied:?}");
    assert_eq!(applied.next_seq, seq + 1);
    assert!(alice.timeline(&CALL).is_empty());
    assert_eq!(
        code(alice.core.send_prepare(&CALL, &request("hello"), NOW)),
        "E_CORE_INPUT"
    );
    assert!(alice.outbox(&CALL).is_empty());
}

#[test]
fn leave_rotate_and_forget() {
    let (mut call, mut alice, _bob, _) = call_raw_bob();
    let p = alice.core.call_leave_proposal(&CALL).expect("proposal");
    assert_eq!(decode_epoch_proposal(&p).0, 1);
    let c = alice.core.call_rotate(&CALL).expect("rotate");
    call.commit(&c)
        .expect("the DS accepts an empty commit with an UpdatePath");
    alice.core.commit_confirm(&CALL).expect("confirm");
    alice.core.call_group_forget(&CALL).expect("forget");
    assert_eq!(alice.group(&CALL).unwrap().state, 4);
    assert_eq!(code(alice.core.call_media_epoch(&CALL)), "E_CORE_STATE");
}

/// Attacker: an instance that adds a leaf for a user whose signed list this device never fetched, hoping the pending verdict lets audio through.
#[test]
fn no_media_key_while_a_leaf_is_pending() {
    let (mut call, mut alice, _bob, _) = call_raw_bob();
    let mut carol = RawPeer::new(0xc3, 0xc4);
    carol.join_external_call(&mut call);
    alice.sync(&call);
    assert_eq!(
        code(alice.core.call_media_epoch(&CALL)),
        "E_DEVICE_LIST_STALE"
    );
    ingest_list_body(
        &mut alice,
        &call,
        carol.user,
        carol.device,
        &carol.device_list_body(),
    );
    assert!(alice.core.call_media_epoch(&CALL).is_ok());
}

/// Ruling RV-1's join path: a join over a tree with a pending leaf is staged and returns its
/// external commit unposted; the list refresh runs against the staged group (its leaf is listed by
/// `pending_leaves`), and only `call_join_check` passing lets the worker post it.
#[test]
fn a_staged_join_with_a_pending_leaf_posts_nothing_until_checked() {
    let instance = Instance::generate();
    let mut call = Relay::new(CALL);
    let mut bob = RawPeer::new(0xb2, 0xb3);
    bob.create_call(&mut call, &instance);
    let mut carol = RawPeer::new(0xc3, 0xc4);
    carol.join_external_call(&mut call);
    let mut alice = ready_core(0xa1, "alice");
    pin_list(&mut alice, &bob);
    let before = call.handshakes_from(0);
    let commit = alice
        .core
        .call_group_join_external(
            &CALL,
            Some(&COMMUNITY),
            &VOICE,
            POLICY,
            &call.info_body(),
            &call.tree_body(),
        )
        .expect("a pending leaf is not a hard verdict: the join is staged");
    assert_eq!(call.handshakes_from(0), before, "nothing is posted");
    assert_eq!(alice.group(&CALL).unwrap().state, 1, "staged");
    let pending = decode_strict(&alice.core.pending_leaves().expect("pending"), |d| {
        let n = d.array_len()?;
        let mut rows = Vec::new();
        for _ in 0..n {
            d.array(5)?;
            let group = d.bytes_exact::<16>()?;
            let leaf = d.uint()?;
            let user = d.bytes_exact::<16>()?;
            d.uint()?;
            d.text()?;
            rows.push((group, leaf, user));
        }
        Ok(rows)
    })
    .expect("pending_leaves shape");
    assert!(
        pending.contains(&(CALL, u64::from(call.leaf_of(carol.device)), carol.user)),
        "the staged call group's pending leaf is listed for the refresh: {pending:?}"
    );
    assert_eq!(
        code(alice.core.call_join_check(&CALL)),
        "E_DEVICE_LIST_STALE"
    );
    ingest_list_body(
        &mut alice,
        &call,
        carol.user,
        carol.device,
        &carol.device_list_body(),
    );
    alice
        .core
        .call_join_check(&CALL)
        .expect("every leaf validates");
    let answer = call
        .resync(&commit)
        .expect("the DS accepts the external commit");
    let seq = decode_strict(&answer, |d| {
        d.array(2)?;
        let seq = d.uint()?;
        d.uint()?;
        Ok(seq)
    })
    .expect("200 body");
    alice.core.group_joined(&CALL, seq).expect("group_joined");
    assert_eq!(code(alice.core.call_join_check(&CALL)), "E_CORE_STATE");
}

/// Alice holds the DM text group GROUP on DM with Bob, whose identity changed there (a leaf of a
/// new UMK joined and its list was ingested): the text group is send-blocked `E_UMK_CHANGED`.
fn alice_with_a_blocked_dm_text_group() -> (Instance, Core) {
    let instance = Instance::generate();
    let mut text = Relay::new(GROUP);
    let mut alice = ready_core(0xa1, "alice");
    alice.create_and_register_in(&mut text, &instance, None, &DM);
    let mut bob = RawPeer::new(0xb2, 0xb3);
    bob.join_external_as(&mut text, &dm_binding(DM));
    alice.sync(&text);
    let body = bob.device_list_body();
    ingest_list_body(&mut alice, &text, bob.user, bob.device, &body);
    let v1 = list_of(&body);
    let mut rotated = RawPeer::new_with_keys(0xb2, 0xd4, 0xd5, 0xd6);
    rotated.join_external_as(&mut text, &dm_binding(DM));
    alice.sync(&text);
    let v2 = sec_next(&v1, vec![sec_entry(&rotated)], 0xd6);
    call_ingest(&mut alice, &text, &bob.user, rotated.device, &[&v1, &v2]);
    assert_eq!(
        alice.core.send_block_code(&GROUP).expect("send gate"),
        Some("E_UMK_CHANGED")
    );
    (instance, alice)
}

/// Attacker: a contact whose identity changed calls in our DM; decision 4 refuses the call key in the core, not only in the worker.
#[test]
fn a_dm_call_key_refuses_while_the_dm_text_group_is_blocked() {
    let (instance, mut alice) = alice_with_a_blocked_dm_text_group();
    let mut call = Relay::new(CALL);
    alice.call_create_and_register(&mut call, &instance, None, &DM);
    assert_eq!(alice.core.send_block_code(&CALL).expect("send gate"), None);
    assert_eq!(code(alice.core.call_media_epoch(&CALL)), "E_UMK_CHANGED");

    // A voice channel's call group (bound to a community) on the same target: the text-group
    // rule applies to DMs only.
    let (instance, mut alice) = alice_with_a_blocked_dm_text_group();
    let mut voice = Relay::new(CALL);
    alice.call_create_and_register(&mut voice, &instance, Some(&COMMUNITY), &DM);
    assert!(alice.core.call_media_epoch(&CALL).is_ok());
}

/// No key byte is derived before the gate passes: with a blocking verdict present the exporter is
/// never reached.
#[cfg(feature = "test-hooks")]
#[test]
fn the_media_epoch_bytes_are_gated_before_any_key_derivation() {
    use dilla_core::client::test_media_key_derivations;
    let (mut call, mut alice, bob, v1) = call_raw_bob();
    let mut forged = RawPeer::new_with_keys(0xb2, 0xd4, 0xb2, 0xf2);
    forged.join_external_call(&mut call);
    alice.sync(&call);
    let before = test_media_key_derivations();
    assert_eq!(
        code(alice.core.call_media_epoch(&CALL)),
        "E_DEVICE_UNLISTED"
    );
    assert_eq!(
        test_media_key_derivations(),
        before,
        "no sframe_base_key call"
    );
    let v2 = sec_next(
        &v1,
        vec![v1.unsigned.entries[0].clone(), sec_entry(&forged)],
        0xf2,
    );
    call_ingest(&mut alice, &call, &bob.user, forged.device, &[&v1, &v2]);
    alice.core.call_media_epoch(&CALL).expect("media epoch");
    assert_eq!(
        test_media_key_derivations(),
        before + 1,
        "the counter sees a derivation once the gate passes"
    );
}
