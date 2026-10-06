// Native only, like tests/mls_roundtrip.rs: every test opens an in-memory SQLite connection.
#![cfg(not(target_arch = "wasm32"))]
// A test binary of its own, so the counting allocator below sees this one test only. The library
// keeps `#![forbid(unsafe_code)]`; a `GlobalAlloc` cannot be written without `unsafe`.
#![allow(unsafe_code)]

//! Hardening F8: no allocation of the client engine is sized by a count the server chose. Each
//! served array is decoded with a pre-allocation bounded by the input that is left (the rule of
//! `cbor/dec.rs` `array_len`), so a body of N bytes never reserves more than N bytes up front.
//! A counting global allocator records the largest single request made while a call runs.

mod client_support;

use client_support::*;
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

/// The largest single allocation `f` makes.
fn largest_allocation<T>(f: impl FnOnce() -> T) -> (T, usize) {
    LARGEST.store(0, Ordering::Relaxed);
    WATCHING.store(true, Ordering::Relaxed);
    let out = f();
    WATCHING.store(false, Ordering::Relaxed);
    (out, LARGEST.load(Ordering::Relaxed))
}

/// A CBOR array head claiming `n` (a power of two, 2^16..2^32) elements, then `n` zero bytes: just
/// enough input for `array_len` to accept the count, and not one well-formed element.
fn claimed_array(n: usize) -> Vec<u8> {
    let mut body = vec![0x9a];
    body.extend_from_slice(&u32::try_from(n).expect("n fits u32").to_be_bytes());
    body.resize(5 + n, 0x00);
    body
}

#[test]
fn a_served_array_count_never_sizes_an_allocation_beyond_the_input() {
    let instance = Instance::generate();
    let mut relay = Relay::new(GROUP);
    let mut a = ready_core(0xa1, "alice");
    a.create_and_register(&mut relay, &instance);
    let body = claimed_array(1 << 20);
    let bound = body.len();

    let (result, largest) =
        largest_allocation(|| a.core.group_apply(&GROUP, &body, &[0x80], 1).map(|_| ()));
    assert_eq!(code(result), "E_CORE_INPUT");
    assert!(
        largest <= bound,
        "handshakes: {largest} bytes reserved for a {bound}-byte body"
    );

    let (result, largest) =
        largest_allocation(|| a.core.group_apply(&GROUP, &[0x80], &body, 1).map(|_| ()));
    assert_eq!(code(result), "E_CORE_INPUT");
    assert!(
        largest <= bound,
        "messages: {largest} bytes reserved for a {bound}-byte body"
    );

    let (result, largest) = largest_allocation(|| a.core.welcomes_apply(&body, &[0x80]));
    assert_eq!(code(result), "E_CORE_INPUT");
    assert!(
        largest <= bound,
        "welcomes: {largest} bytes reserved for a {bound}-byte body"
    );

    let (result, largest) = largest_allocation(|| a.core.welcomes_apply(&[0x80], &body));
    assert_eq!(code(result), "E_CORE_INPUT");
    assert!(
        largest <= bound,
        "expected: {largest} bytes reserved for a {bound}-byte body"
    );

    let (result, largest) = largest_allocation(|| a.core.commit_build(&GROUP, &body));
    assert_eq!(code(result), "E_CORE_INPUT");
    assert!(
        largest <= bound,
        "proposals: {largest} bytes reserved for a {bound}-byte body"
    );
}
