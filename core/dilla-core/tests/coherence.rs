// `trybuild` shells out to a nested host `cargo`, and this test needs a native SQLite-capable
// build of the crate, so it is compiled for the host only. Plan A2 (NV-9) requires every
// integration test that needs native SQLite to carry this gate; it is written here, in the task
// that creates the file, rather than retrofitted.
#![cfg(not(target_arch = "wasm32"))]

//! One type cannot implement both `StorageProvider` and `PublicStorageProvider`: `openmls_traits`
//! ships a blanket impl of the public trait for every `StorageProvider`, so a second impl is
//! E0119 (gap-1 section 3a). `DillaStorage` and `public_group::PublicStore` are therefore two
//! distinct types, and this test makes the constraint a CI failure rather than a paragraph.

#[test]
#[cfg_attr(miri, ignore)]
fn implementing_both_storage_traits_is_a_compile_error() {
    trybuild::TestCases::new().compile_fail("tests/coherence/both_traits.rs");
}
