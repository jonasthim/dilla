//! Negative cases of the trust refresh after PR #72 (web3.12.2).
//!
//! In one pass the worker ingests one user's history for the first of that user's leaves. Every
//! later leaf of the same user then gets the history sliced from the version that ingest cached
//! (client-core `historyFrom`). Every slice still goes through `ingest_leaf`, so the core must
//! tell a slice that was "correctly relaxed" from one that was "relaxed too far". Each test here
//! asserts a refusal (or, for the equal boundary, the one acceptance a no-op refresh needs).
//!
//! Bob (UMK 0xb2, SSK 0xf2) has these leaves in GROUP, all joined before Alice caches any list:
//! - `bob`: device 0xb3, in v1 and v2;
//! - `bob2`: device 0xb4, added in v2 (the second device that reloads mid-sync);
//! - `rogue`: device 0xb5, a credential cross-signed by Bob's own SSK, in no signed list;
//! - `other`: device 0xb6, listed in v2, but its credential is under UMK 0xc1 / SSK 0xc2, which
//!   signed no list;
//! - `rot`: device 0xb7, UMK 0xb2 with a rotated SSK 0xf9, in no list Alice has cached.
#![cfg(not(target_arch = "wasm32"))]
mod client_support;
use client_support::*;
use dilla_core::cbor::{Encoder, decode_strict};
use dilla_core::identity::{DeviceList, SskSigner};

const BOB: [u8; 16] = [0xb3; 16];
const BOB2: [u8; 16] = [0xb4; 16];
const ROGUE: [u8; 16] = [0xb5; 16];
const OTHER: [u8; 16] = [0xb6; 16];
const ROT: [u8; 16] = [0xb7; 16];

struct World {
    relay: Relay,
    alice: Core,
    bob: RawPeer,
    rogue: RawPeer,
    rot: RawPeer,
    v1: DeviceList,
    v2: DeviceList,
    /// bob2's message and the rogue device's, both held by Alice for Bob's signed list.
    bob2_seq: u64,
    rogue_seq: u64,
}

fn world() -> World {
    let instance = Instance::generate();
    let mut relay = Relay::new(GROUP);
    let mut alice = ready_core(0xa1, "alice");
    alice.create_and_register(&mut relay, &instance);
    let mut bob = RawPeer::new(0xb2, 0xb3);
    bob.join_external(&mut relay);
    let mut bob2 = RawPeer::new_with_keys(0xb2, 0xb4, 0xb2, 0xf2);
    bob2.join_external(&mut relay);
    let mut rogue = RawPeer::new_with_keys(0xb2, 0xb5, 0xb2, 0xf2);
    let join = rogue.join_external(&mut relay);
    bob2.apply_commit(&relay, join);
    let mut other = RawPeer::new_with_keys(0xb2, 0xb6, 0xc1, 0xc2);
    let join = other.join_external(&mut relay);
    bob2.apply_commit(&relay, join);
    rogue.apply_commit(&relay, join);
    let mut rot = RawPeer::new_with_keys(0xb2, 0xb7, 0xb2, 0xf9);
    let join = rot.join_external(&mut relay);
    bob2.apply_commit(&relay, join);
    rogue.apply_commit(&relay, join);
    alice.sync(&relay);
    let body = bob.device_list_body();
    let v1 = DeviceList::decode(
        &decode_strict(&body, |d| {
            d.array(4)?;
            d.uint()?;
            let blob = d.bytes()?.to_vec();
            d.skip()?;
            d.skip()?;
            Ok(blob)
        })
        .unwrap(),
    )
    .unwrap();
    let v2 = sec_next(
        &v1,
        vec![
            v1.unsigned.entries[0].clone(),
            sec_entry(&bob2),
            sec_entry(&other),
        ],
        0xf2,
    );
    let bob2_seq = bob2.send(&mut relay, "second device comet");
    let rogue_seq = rogue.send(&mut relay, "rogue comet");
    alice.sync(&relay);
    for seq in [bob2_seq, rogue_seq] {
        let row = alice.row_at(&GROUP, seq);
        assert_eq!(
            (row.status, row.reason.as_str()),
            (1, "E_DEVICE_LIST_STALE"),
            "held for Bob's signed list before any pass"
        );
    }
    World {
        relay,
        alice,
        bob,
        rogue,
        rot,
        v1,
        v2,
        bob2_seq,
        rogue_seq,
    }
}

type Verdict = (u64, u64, u64);
/// Alice's cached row for Bob: version, signed list, UMK, SSK.
type CachedRow = (i64, Vec<u8>, [u8; 32], [u8; 32]);

fn ingest_body(
    w: &mut World,
    via: [u8; 16],
    history: &[u8],
    head: &DeviceList,
) -> Result<Verdict, &'static str> {
    let leaf = w.relay.leaf_of(via);
    w.alice
        .core
        .device_list_ingest(&GROUP, leaf, &w.bob.user, history, &head.encode(), NOW + 3)
        .map(|answer| {
            decode_strict(&answer, |d| {
                d.array(3)?;
                Ok((d.uint()?, d.uint()?, d.uint()?))
            })
            .unwrap()
        })
        .map_err(|e| e.code)
}

/// One pass's ingest of `lists` (the history read, or a slice of it) for the leaf of `via`.
fn ingest(w: &mut World, via: [u8; 16], lists: &[&DeviceList]) -> Result<Verdict, &'static str> {
    let head = (*lists.last().expect("a nonempty history")).clone();
    ingest_body(w, via, &sec_history(lists), &head)
}

fn revalidate(w: &mut World, via: [u8; 16]) -> u32 {
    let leaf = w.relay.leaf_of(via);
    w.alice
        .core
        .revalidate_pending(&GROUP, leaf, 256)
        .expect("revalidate")
}

fn cached(w: &World) -> Option<CachedRow> {
    w.alice
        .probe
        .lock()
        .unwrap()
        .query_row(
            "SELECT version,list,umk_pub,ssk_pub FROM app_device_lists WHERE user_id=?1",
            [w.bob.user.as_slice()],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .ok()
}

/// The first leaf of the pass ingests [v1, v2] and caches v2: every case below starts here. The
/// verdict's quarantine count is Bob's three leaves no signed list backs (rogue, other, rot).
fn cache_v2(w: &mut World) -> CachedRow {
    let (v1, v2) = (w.v1.clone(), w.v2.clone());
    assert_eq!(ingest(w, BOB2, &[&v1, &v2]), Ok((2, 0, 3)));
    let row = cached(w).expect("v2 cached");
    assert_eq!((row.0, row.1.as_slice()), (2, w.v2.encode().as_slice()));
    row
}

/// The rogue leaf's verdict is E_DEVICE_UNLISTED (Alice's quarantine row for exactly that leaf),
/// and its held message stays unreadable. The row was held for Bob's list (E_DEVICE_LIST_STALE:
/// wait for the list); once the leaf is judged, it carries the verdict (E_DEVICE_UNLISTED: the
/// device must be added to the list), as a message the leaf sends after the verdict does
/// (`assert_rogue_refused_now`).
fn assert_rogue_unreadable(w: &World) {
    let row = w.alice.row_at(&GROUP, w.rogue_seq);
    assert_eq!(
        (row.status, row.reason.as_str(), row.body.as_str()),
        (1, "E_DEVICE_UNLISTED", ""),
        "the unlisted device's held message stays unreadable, for the reason it is unreadable"
    );
    let verdict: Vec<String> = {
        let db = w.alice.probe.lock().unwrap();
        let mut stmt = db
            .prepare(
                "SELECT code FROM app_quarantine WHERE group_id=?1 AND user_id=?2 AND device_id=?3",
            )
            .unwrap();
        stmt.query_map(
            rusqlite::params![GROUP.as_slice(), w.bob.user.as_slice(), ROGUE.as_slice()],
            |r| r.get(0),
        )
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap()
    };
    assert_eq!(
        verdict,
        ["E_DEVICE_UNLISTED"],
        "the leaf's verdict names why"
    );
}

/// A message the rogue device sends after the list is cached: unreadable, E_DEVICE_UNLISTED.
fn assert_rogue_refused_now(w: &mut World, text: &str) {
    let seq = w.rogue.send(&mut w.relay, text);
    w.alice.sync(&w.relay);
    let row = w.alice.row_at(&GROUP, seq);
    assert_eq!(
        (row.status, row.reason.as_str(), row.body.as_str()),
        (1, "E_DEVICE_UNLISTED", "")
    );
    assert_eq!(revalidate(w, ROGUE), 0);
}

fn assert_bob2_readable(w: &World) {
    let row = w.alice.row_at(&GROUP, w.bob2_seq);
    assert_eq!((row.status, row.body.as_str()), (0, "second device comet"));
}

// 1. An unauthorised device, in both orders within one pass.

#[test]
fn an_unlisted_device_is_refused_on_the_slice_after_its_sibling_cached_the_list() {
    let mut w = world();
    cache_v2(&mut w);
    assert_eq!(revalidate(&mut w, BOB2), 1);
    assert_bob2_readable(&w);
    let v2 = w.v2.clone();
    // The slice the worker hands the rogue leaf after the sibling's ingest.
    assert_eq!(ingest(&mut w, ROGUE, &[&v2]), Err("E_DEVICE_UNLISTED"));
    // Even a worker that revalidated the refused leaf releases nothing.
    assert_eq!(revalidate(&mut w, ROGUE), 0);
    assert_rogue_unreadable(&w);
    // The refusal cached nothing and the next legitimate leaf of the pass still ingests the slice.
    assert_eq!(cached(&w).unwrap().0, 2);
    assert_eq!(ingest(&mut w, BOB, &[&v2]), Ok((2, 0, 3)));
    assert_eq!(revalidate(&mut w, ROGUE), 0);
    assert_rogue_unreadable(&w);
    assert_rogue_refused_now(&mut w, "rogue after the slice");
}

#[test]
fn an_unlisted_device_first_in_the_pass_is_refused_and_then_refused_again_on_the_slice() {
    let mut w = world();
    let (v1, v2) = (w.v1.clone(), w.v2.clone());
    // The rogue leaf comes first: the full history from version 0.
    assert_eq!(ingest(&mut w, ROGUE, &[&v1, &v2]), Err("E_DEVICE_UNLISTED"));
    assert!(cached(&w).is_none(), "a refused ingest caches nothing");
    assert_eq!(revalidate(&mut w, ROGUE), 0);
    // Its legitimate sibling next, with the same full history: accepted, and it is released.
    cache_v2(&mut w);
    assert_eq!(revalidate(&mut w, BOB2), 1);
    assert_bob2_readable(&w);
    assert_rogue_unreadable(&w);
    // A later pass (or a retry) hands the rogue leaf the slice from the cached version: refused.
    assert_eq!(ingest(&mut w, ROGUE, &[&v2]), Err("E_DEVICE_UNLISTED"));
    assert_eq!(revalidate(&mut w, ROGUE), 0);
    assert_rogue_unreadable(&w);
    assert_rogue_refused_now(&mut w, "rogue after the slice");
}

// 2. A forked or substituted history after v2 is cached.

#[test]
fn a_correctly_signed_v2_that_is_not_the_cached_v2_is_refused_as_stale() {
    let mut w = world();
    let before = cache_v2(&mut w);
    let v1 = w.v1.clone();
    // A fork signed by Bob's own SSK, one that would authorise the rogue device.
    let fork = sec_next(
        &v1,
        vec![v1.unsigned.entries[0].clone(), sec_entry(&w.rogue)],
        0xf2,
    );
    assert_ne!(fork.encode(), w.v2.encode());
    let fork3 = sec_next(&fork, fork.unsigned.entries.clone(), 0xf2);
    // A single-row slice: the first-row requirement carries the whole weight.
    assert_eq!(ingest(&mut w, ROGUE, &[&fork]), Err("E_DEVICE_LIST_STALE"));
    assert_eq!(
        ingest(&mut w, ROGUE, &[&fork, &fork3]),
        Err("E_DEVICE_LIST_STALE")
    );
    assert_eq!(
        ingest(&mut w, ROGUE, &[&v1, &fork]),
        Err("E_DEVICE_LIST_STALE")
    );
    // Through a listed leaf too: the slice must carry the cached v2, not a different one.
    assert_eq!(ingest(&mut w, BOB, &[&fork]), Err("E_DEVICE_LIST_STALE"));
    assert_eq!(cached(&w), Some(before));
    assert_eq!(revalidate(&mut w, ROGUE), 0);
    assert_rogue_unreadable(&w);
}

/// The first row byte-equal to the cached blob, but the cached key that must have signed it is
/// another one (a cache row whose key column was rebound). The byte-equality half holds, so only
/// the signature half can refuse it.
#[test]
fn a_byte_equal_first_row_not_signed_under_the_cached_key_is_refused() {
    let mut w = world();
    cache_v2(&mut w);
    let rotated = SskSigner::from_bytes(&[0xf9; 32]).public();
    w.alice
        .probe
        .lock()
        .unwrap()
        .execute(
            "UPDATE app_device_lists SET ssk_pub=?1 WHERE user_id=?2",
            rusqlite::params![rotated.as_slice(), w.bob.user.as_slice()],
        )
        .unwrap();
    let v2 = w.v2.clone();
    let mut entries = v2.unsigned.entries.clone();
    entries.push(sec_entry(&w.rot));
    let v3 = sec_next(&v2, entries, 0xf9);
    assert_eq!(ingest(&mut w, ROT, &[&v2, &v3]), Err("E_CREDENTIAL"));
    // The single-row slice of the same: refused as well.
    assert_eq!(ingest(&mut w, ROT, &[&v2]), Err("E_CREDENTIAL"));
    assert_eq!(cached(&w).unwrap().0, 2);
}

/// Same UMK, another SSK: a leaf under a rotated SSK cannot extend the list the old SSK signed.
#[test]
fn a_leaf_under_another_ssk_of_the_cached_umk_cannot_extend_the_cached_list() {
    let mut w = world();
    let before = cache_v2(&mut w);
    let v2 = w.v2.clone();
    let mut entries = v2.unsigned.entries.clone();
    entries.push(sec_entry(&w.rot));
    let v3 = sec_next(&v2, entries, 0xf9);
    assert_eq!(ingest(&mut w, ROT, &[&v2, &v3]), Err("E_CREDENTIAL"));
    assert_eq!(cached(&w), Some(before));
}

/// The served row's own fields must match the signed list it carries: each one on its own.
#[test]
fn a_served_row_whose_fields_disagree_with_its_signed_list_is_refused_one_field_at_a_time() {
    let mut w = world();
    let before = cache_v2(&mut w);
    let v2 = w.v2.clone();
    let row = |version: u64, sig: [u8; 64], prev: [u8; 32]| {
        let mut e = Encoder::new();
        e.array(1)
            .array(4)
            .uint(version)
            .bytes(&v2.encode())
            .bytes(&sig)
            .bytes(&prev);
        e.into_vec()
    };
    let (sig, prev) = (v2.sig_ssk, v2.unsigned.prev_hash);
    assert_eq!(
        ingest_body(&mut w, BOB, &row(2, sig, prev), &v2),
        Ok((2, 0, 3))
    );
    for (what, body) in [
        ("version", row(3, sig, prev)),
        ("signature", row(2, [0; 64], prev)),
        ("prev_hash", row(2, sig, [0; 32])),
    ] {
        assert_eq!(
            ingest_body(&mut w, ROGUE, &body, &v2),
            Err("E_DEVICE_LIST_STALE"),
            "a served row with another {what}"
        );
        assert_eq!(
            ingest_body(&mut w, BOB, &body, &v2),
            Err("E_DEVICE_LIST_STALE"),
            "a served row with another {what}, through a listed leaf"
        );
    }
    assert_eq!(cached(&w), Some(before));
}

/// A cache row whose version column disagrees with its blob: the version half of the anchor check
/// on its own (the blob half holds).
#[test]
fn a_cache_row_whose_version_disagrees_with_its_blob_anchors_nothing() {
    let mut w = world();
    cache_v2(&mut w);
    w.alice
        .probe
        .lock()
        .unwrap()
        .execute(
            "UPDATE app_device_lists SET version=3 WHERE user_id=?1",
            [w.bob.user.as_slice()],
        )
        .unwrap();
    let v2 = w.v2.clone();
    let v3 = sec_next(&v2, v2.unsigned.entries.clone(), 0xf2);
    assert_eq!(ingest(&mut w, BOB, &[&v2, &v3]), Err("E_DEVICE_LIST_STALE"));
}

// 3. Rollback.

#[test]
fn a_history_whose_head_is_below_the_cached_version_is_refused() {
    let mut w = world();
    let before = cache_v2(&mut w);
    let (v1, v2) = (w.v1.clone(), w.v2.clone());
    assert_eq!(ingest(&mut w, BOB, &[&v1]), Err("E_DEVICE_LIST_STALE"));
    // The cached v2 as the first row, a head below it.
    assert_eq!(
        ingest_body(&mut w, BOB, &sec_history(&[&v2]), &v1),
        Err("E_DEVICE_LIST_STALE")
    );
    assert_eq!(cached(&w), Some(before));
}

/// The equal boundary: a refresh that finds nothing new (head at the cached version, the slice of
/// one row) is accepted and changes nothing.
#[test]
fn a_head_exactly_at_the_cached_version_is_accepted() {
    let mut w = world();
    let before = cache_v2(&mut w);
    let v2 = w.v2.clone();
    assert_eq!(ingest(&mut w, BOB, &[&v2]), Ok((2, 0, 3)));
    assert_eq!(ingest(&mut w, BOB2, &[&v2]), Ok((2, 0, 3)));
    assert_eq!(cached(&w), Some(before));
}

// 5. A head not signed by the leaf's key.

#[test]
fn a_head_the_leafs_ssk_did_not_sign_is_refused_also_when_it_is_the_cached_anchor() {
    let mut w = world();
    let (v1, v2) = (w.v1.clone(), w.v2.clone());
    // No cache: the chain is checked under the leaf's SSK.
    assert_eq!(ingest(&mut w, OTHER, &[&v1, &v2]), Err("E_CREDENTIAL"));
    let before = cache_v2(&mut w);
    // The single-row slice: the loop over newer rows has nothing to do, so the head's own
    // signature check against the leaf's SSK carries the whole weight.
    assert_eq!(ingest(&mut w, OTHER, &[&v2]), Err("E_CREDENTIAL"));
    assert_eq!(cached(&w), Some(before));
}

// Vacuous input.

#[test]
fn an_empty_history_is_refused_with_and_without_a_cached_list() {
    let mut w = world();
    let mut empty = Encoder::new();
    empty.array(0);
    let empty = empty.into_vec();
    let v2 = w.v2.clone();
    assert_eq!(
        ingest_body(&mut w, BOB2, &empty, &v2),
        Err("E_DEVICE_LIST_STALE")
    );
    assert!(cached(&w).is_none());
    let before = cache_v2(&mut w);
    assert_eq!(
        ingest_body(&mut w, BOB, &empty, &v2),
        Err("E_DEVICE_LIST_STALE")
    );
    assert_eq!(cached(&w), Some(before));
}

// The held row's reason after the verdict.

/// A row held for the list and re-labelled E_DEVICE_UNLISTED when its leaf was judged is still
/// held, not retracted: once a later signed list names the device, it is released.
#[test]
fn a_held_row_labelled_unlisted_is_released_once_a_later_list_names_the_device() {
    let mut w = world();
    cache_v2(&mut w);
    assert_rogue_unreadable(&w);
    let v2 = w.v2.clone();
    let mut entries = v2.unsigned.entries.clone();
    entries.push(sec_entry(&w.rogue));
    let v3 = sec_next(&v2, entries, 0xf2);
    assert_eq!(ingest(&mut w, ROGUE, &[&v2, &v3]), Ok((3, 0, 2)));
    assert_eq!(revalidate(&mut w, ROGUE), 1);
    let row = w.alice.row_at(&GROUP, w.rogue_seq);
    assert_eq!((row.status, row.body.as_str()), (0, "rogue comet"));
}

/// The re-label is the judged leaf's only: a sibling's row held for the same list, whose leaf the
/// same ingest found valid, keeps waiting for its own revalidation.
#[test]
fn only_the_judged_leafs_held_rows_take_its_verdict() {
    let mut w = world();
    cache_v2(&mut w);
    let bob2_row = w.alice.row_at(&GROUP, w.bob2_seq);
    assert_eq!(
        (bob2_row.status, bob2_row.reason.as_str()),
        (1, "E_DEVICE_LIST_STALE"),
        "a valid leaf's held row waits for its revalidation, not a failure"
    );
    assert_eq!(revalidate(&mut w, BOB2), 1);
    assert_bob2_readable(&w);
    assert_rogue_unreadable(&w);
}
