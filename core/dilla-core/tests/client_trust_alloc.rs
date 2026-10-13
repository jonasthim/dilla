// Native only: every test opens an in-memory SQLite connection.
#![cfg(not(target_arch = "wasm32"))]
// A test binary of its own, so the counting allocator below sees this one test only. The library
// keeps `#![forbid(unsafe_code)]`; a `GlobalAlloc` cannot be written without `unsafe`.
#![allow(unsafe_code)]

//! Trust retraction and audit work is bounded by a page, not by the history a sender made us
//! store (T2-LAST-03) or by the size of unrelated members' signed lists. One `#[test]` only:
//! the counter is process-wide.

mod client_support;

use client_support::*;
use dilla_core::identity::{DeviceEntry, DeviceList, DeviceListUnsigned, SskSigner, Tier};
use dilla_core::ids::{DeviceId, UserId};
use std::alloc::{GlobalAlloc, Layout, System};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

struct Largest;

static WATCHING: AtomicBool = AtomicBool::new(false);
static LARGEST: AtomicUsize = AtomicUsize::new(0);

// SAFETY: every method forwards to `System` unchanged; the only addition is a relaxed counter.
unsafe impl GlobalAlloc for Largest {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        if WATCHING.load(Ordering::Relaxed) {
            LARGEST.fetch_max(layout.size(), Ordering::Relaxed);
        }
        // SAFETY: the caller's contract for `alloc` is passed on as is.
        unsafe { System.alloc(layout) }
    }
    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        // SAFETY: `ptr` was allocated by `System` with `layout`.
        unsafe { System.dealloc(ptr, layout) }
    }
    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        if WATCHING.load(Ordering::Relaxed) {
            LARGEST.fetch_max(new_size, Ordering::Relaxed);
        }
        // SAFETY: the caller's contract for `realloc` is passed on as is.
        unsafe { System.realloc(ptr, layout, new_size) }
    }
}

#[global_allocator]
static ALLOCATOR: Largest = Largest;

fn largest_allocation<T>(f: impl FnOnce() -> T) -> (T, usize) {
    LARGEST.store(0, Ordering::Relaxed);
    WATCHING.store(true, Ordering::Relaxed);
    let out = f();
    WATCHING.store(false, Ordering::Relaxed);
    (out, LARGEST.load(Ordering::Relaxed))
}

const BOUND: usize = 256 * 1024;

fn break_bobs_list(alice: &Core, bob: &[u8; 16]) {
    alice
        .probe
        .lock()
        .unwrap()
        .execute(
            "UPDATE app_device_lists SET list=x'80' WHERE user_id=?1",
            [bob.as_slice()],
        )
        .unwrap();
}

#[test]
fn trust_retraction_and_sender_audit_work_is_bounded() {
    // T2-LAST-03: 50,000 accepted rows of one leaf are retracted page by page.
    let (_, mut relay, mut alice, mut bob) = alice_and_bob_trusted();
    let (_, seq) = bob.send(&mut relay, &GROUP, "accepted comet", NOW + 1);
    alice.sync(&relay);
    {
        let db = alice.probe.lock().unwrap();
        let key: Vec<u8> = db
            .query_row(
                "SELECT sender_sig_key FROM app_messages WHERE group_id=?1 AND seq=?2",
                rusqlite::params![GROUP.as_slice(), seq as i64],
                |r| r.get(0),
            )
            .unwrap();
        db.execute_batch("BEGIN").unwrap();
        for n in 0..50_000i64 {
            db.execute(
                "INSERT INTO app_messages(group_id,seq,epoch,recv_ts,status,sender_user,sender_device,sender_sig_key,type,body,franking_tag) \
                 VALUES(?1,?2,1,1,0,?3,?4,?5,0,'stored comet',?6)",
                rusqlite::params![GROUP.as_slice(), 1_000_000 + n, bob.user.as_slice(), bob.device.as_slice(), key, [0x77u8; 32].as_slice()],
            )
            .unwrap();
        }
        db.execute_batch("COMMIT").unwrap();
    }
    break_bobs_list(&alice, &bob.user);
    bob.commit(&mut relay);
    let (_, largest) = largest_allocation(|| alice.sync(&relay));
    let live: i64 = alice
        .probe
        .lock()
        .unwrap()
        .query_row(
            "SELECT count(*) FROM app_messages WHERE group_id=?1 AND status=0 AND sender_device=?2",
            rusqlite::params![GROUP.as_slice(), bob.device.as_slice()],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(
        live, 0,
        "every accepted row of the failed leaf is retracted"
    );
    assert!(
        largest <= BOUND,
        "retraction reserved {largest} bytes at once for 50,000 rows"
    );

    // A failed sender's message is charged to that leaf alone: it does not re-verify every
    // other member's cached signed list (here a 9,000-entry list of Carol's).
    let (_, mut relay, mut alice, mut bob) = alice_and_bob_trusted();
    let mut carol = RawPeer::new(0xc3, 0xc4);
    let join = carol.join_external(&mut relay);
    alice.sync(&relay);
    bob.sync(&relay);
    let _ = join;
    let ssk = SskSigner::from_bytes(&[0xc3u8.wrapping_add(0x40); 32]);
    let mut entries = vec![DeviceEntry {
        device_id: DeviceId::from_bytes(carol.device),
        dsk_pub: carol.signer.public().try_into().unwrap(),
        tier: Tier::Native,
        added_at: NOW,
        revoked_at: None,
    }];
    for n in 0..9_000u32 {
        let mut device = [0x5eu8; 16];
        device[12..].copy_from_slice(&n.to_be_bytes());
        entries.push(DeviceEntry {
            device_id: DeviceId::from_bytes(device),
            dsk_pub: [0x5f; 32],
            tier: Tier::Native,
            added_at: NOW,
            revoked_at: None,
        });
    }
    let unsigned = DeviceListUnsigned {
        v: 1,
        user_id: UserId::from_bytes(carol.user),
        version: 1,
        prev_hash: [0; 32],
        entries,
    };
    let list = DeviceList {
        sig_ssk: ssk.sign_device_list(&unsigned),
        unsigned,
    };
    let mut body = dilla_core::cbor::Encoder::new();
    body.array(4)
        .uint(1)
        .bytes(&list.encode())
        .bytes(&list.sig_ssk)
        .bytes(&[0; 32]);
    ingest_list_body(
        &mut alice,
        &relay,
        carol.user,
        carol.device,
        &body.into_vec(),
    );
    break_bobs_list(&alice, &bob.user);
    let (_, failed) = bob.send(&mut relay, &GROUP, "failed sender comet", NOW + 2);
    let (_, largest) = largest_allocation(|| alice.sync(&relay));
    assert_eq!(alice.row_at(&GROUP, failed).status, 1);
    assert!(
        largest <= BOUND,
        "a failed sender's message reserved {largest} bytes at once (another member's list was re-verified)"
    );
}
