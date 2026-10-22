// Native only, like tests/mls_roundtrip.rs: every test opens an in-memory SQLite connection.
#![cfg(not(target_arch = "wasm32"))]

//! UP6b (R-UP12, protocol/02 invariant 6 "Withdrawal"): a `withdrawn` handshake row (kind 3)
//! takes the instance's own absence `Remove` out of a member's queue, and only that.

mod client_support;

use client_support::*;
use dilla_core::cbor::Encoder;

fn pending(core: &Core, group: &[u8; 16]) -> u64 {
    core.group(group).expect("row").proposals_pending
}

/// The everyone-dropped queue: the instance's Remove of Bob's own leaf sits in Bob's queue, and
/// OpenMLS refuses to commit a self-removal.
#[test]
fn applying_a_withdrawn_row_unqueues_the_instance_remove_and_unblocks_the_commit() {
    let (instance, mut relay, mut a, mut b) = alice_and_bob_trusted();
    let seq = instance.propose_remove(&mut relay, b.device);
    let reference = relay.reference_at(seq);
    a.sync(&relay);
    b.sync(&relay);
    assert_eq!(pending(&b, &GROUP), 1);
    assert!(
        b.core
            .commit_build(&GROUP, &relay.proposals_body())
            .is_err(),
        "a queue holding the Remove of the own leaf cannot be committed"
    );

    let withdrawn = relay.withdraw(&reference);
    let applied = b.sync(&relay);
    assert_eq!(
        applied.next_seq,
        withdrawn + 1,
        "the cursor moves past the row"
    );
    assert_eq!(pending(&b, &GROUP), 0, "the ref left the OpenMLS queue");
    a.sync(&relay);
    assert_eq!(pending(&a, &GROUP), 0);

    let epoch = b.group(&GROUP).expect("row").epoch;
    b.commit(&mut relay);
    assert_eq!(b.group(&GROUP).expect("row").epoch, epoch + 1);
    let after = a.sync(&relay);
    assert_eq!(after.state, 2, "Alice follows Bob's commit");
    assert_eq!(after.epoch, epoch + 1);
    assert_eq!(b.sync(&relay).state, 2, "Bob kept his leaf");
}

/// Correction I4: a client that missed the row drops a queued instance Remove the listing no
/// longer names, and its commit leaves the leaf in.
#[test]
fn commit_build_drops_a_queued_instance_remove_the_listing_lacks() {
    let (instance, mut relay, mut a, mut b) = alice_and_bob_trusted();
    let seq = instance.propose_remove(&mut relay, b.device);
    let reference = relay.reference_at(seq);
    a.sync(&relay);
    b.sync(&relay);
    relay.unlist(&reference);
    assert_eq!(pending(&a, &GROUP), 1);

    let applied = a.commit(&mut relay);
    assert_eq!(applied.proposals_pending, 0);
    assert_eq!(b.sync(&relay).state, 2, "the commit did not remove Bob");
}

/// UP13: the listing a commit is built from may be of a newer epoch than the device's own (another
/// member's commit landed first), so it lacks a queued instance Remove that was not withdrawn but
/// committed. The I4 fallback takes it out of this build only: once the build is aborted (the post
/// is refused 409), the queue still holds it, and the winning commit that carries it by reference
/// is processed. Before, the drop outlived the abort and that commit failed, losing the group
/// (state 3), which a call resumed only by an external join and a second start.
#[test]
fn an_aborted_build_keeps_the_instance_remove_its_listing_lacked() {
    let (instance, mut relay, mut a, mut b) = alice_and_bob_trusted();
    instance.propose_remove(&mut relay, a.device);
    a.sync(&relay);
    b.sync(&relay);
    assert_eq!(pending(&a, &GROUP), 1);
    // The newer epoch's listing is empty; the build drops the queued Remove and succeeds.
    let mut empty = Encoder::new();
    empty.array(0);
    a.core
        .commit_build(&GROUP, &empty.into_vec())
        .expect("commit_build");
    a.core.commit_abort(&GROUP).expect("commit_abort");
    assert_eq!(
        pending(&a, &GROUP),
        1,
        "the abort leaves the queue as it was"
    );

    // Bob's commit of that Remove wins the epoch.
    b.commit(&mut relay);
    let applied = a.sync(&relay);
    assert_eq!(
        applied.state, 4,
        "Alice processes Bob's commit: her leaf is removed, her group not lost"
    );
}

/// A listed instance Remove is kept and committed: the fallback drops only what the listing lacks.
#[test]
fn commit_build_keeps_a_listed_instance_remove() {
    let (instance, mut relay, mut a, mut b) = alice_and_bob_trusted();
    instance.propose_remove(&mut relay, b.device);
    a.sync(&relay);
    a.commit(&mut relay);
    assert_eq!(b.sync(&relay).state, 4, "Bob is removed");
}

/// Correction I1: the instance re-arms the withdrawn Remove (a kind-0 row with the same proposal);
/// the members queue it again and the next commit removes the leaf.
#[test]
fn a_kind_0_row_requeues_a_ref_a_withdrawn_row_dropped() {
    let (instance, mut relay, mut a, mut b) = alice_and_bob_trusted();
    let seq = instance.propose_remove(&mut relay, b.device);
    let reference = relay.reference_at(seq);
    a.sync(&relay);
    relay.withdraw(&reference);
    a.sync(&relay);
    assert_eq!(pending(&a, &GROUP), 0);

    let again = instance.propose_remove(&mut relay, b.device);
    assert_eq!(
        relay.reference_at(again),
        reference,
        "the same deterministic ref"
    );
    a.sync(&relay);
    assert_eq!(pending(&a, &GROUP), 1, "queued again");
    a.commit(&mut relay);
    assert_eq!(b.sync(&relay).state, 4, "the re-armed Remove is committed");
}

#[test]
fn a_withdrawn_row_naming_an_unknown_ref_is_a_no_op() {
    let (instance, mut relay, mut a, b) = alice_and_bob_trusted();
    instance.propose_remove(&mut relay, b.device);
    a.sync(&relay);
    let row = relay.withdraw(&[0x5a; 32]);
    let applied = a.sync(&relay);
    assert_eq!(applied.state, 2);
    assert_eq!(applied.next_seq, row + 1, "the cursor moves past it");
    assert_eq!(pending(&a, &GROUP), 1, "the instance Remove stays queued");
}

/// A withdrawn row naming a member's proposal is ignored: only the instance's own Remove can be
/// withdrawn (E2EE analysis: a malicious server gains no power over members' proposals).
#[test]
fn a_withdrawn_row_naming_a_members_proposal_is_ignored() {
    let (mut call, mut alice, mut bob, _) = call_raw_bob();
    let leave = bob
        .group
        .as_mut()
        .expect("joined")
        .leave(&bob.provider, &bob.signer)
        .expect("bob's own Remove");
    let leaf = call.leaf_of(bob.device);
    let seq = call.propose_from(leave, u64::from(leaf));
    let reference = call.reference_at(seq);
    alice.sync(&call);
    assert_eq!(pending(&alice, &CALL), 1);
    call.withdraw(&reference);
    alice.sync(&call);
    assert_eq!(
        pending(&alice, &CALL),
        1,
        "a member's proposal is never withdrawn"
    );
}

/// The row's own shape: a sender, or a blob that is not `[bstr]`, refuses the page.
#[test]
fn a_malformed_withdrawn_row_is_a_shape_error() {
    let (_instance, mut relay, mut a, _b) = alice_and_bob_trusted();
    let mut two = Encoder::new();
    two.array(2).bytes(&[1; 32]).bytes(&[2; 32]);
    relay.push_handshake(3, two.into_vec());
    assert_eq!(code(a.try_sync(&relay)), "E_CORE_INPUT");

    let (_instance, mut relay, mut a, _b) = alice_and_bob_trusted();
    let mut one = Encoder::new();
    one.array(1).bytes(&[1; 32]);
    let seq = relay.push_handshake(3, one.into_vec());
    relay
        .handshakes
        .iter_mut()
        .find(|h| h.seq == seq)
        .expect("row")
        .sender = Some(0);
    assert_eq!(code(a.try_sync(&relay)), "E_CORE_INPUT");

    let (_instance, mut relay, mut a, _b) = alice_and_bob_trusted();
    relay.push_handshake(4, vec![0x80]);
    assert_eq!(
        code(a.try_sync(&relay)),
        "E_CORE_INPUT",
        "kind 4 stays unknown"
    );
}
