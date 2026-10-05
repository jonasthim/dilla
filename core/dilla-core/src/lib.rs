//! dilla-core: the cryptographic, protocol and storage core of dilla.
//!
//! Every module here is target-agnostic. The two binding crates
//! (`dilla-core-wasm`, `dilla-core-wasi`) hold the target-specific glue.
#![forbid(unsafe_code)]

pub mod cbor;
// The client uses the SQLite half of `mls`, unavailable on wasm32-wasip1.
#[cfg(any(not(target_arch = "wasm32"), target_os = "unknown"))]
pub mod client;
pub mod envelope;
pub mod error;
pub mod identity;
pub mod ids;
pub mod mls;
pub mod public_group;
pub mod sframe;
#[cfg(feature = "vectors")]
pub mod vectors;

pub use error::{CoreError, ProtocolError};

/// The crate version, reported over every binding.
pub const CORE_VERSION: &str = env!("CARGO_PKG_VERSION");
/// `e2ee_version` as recorded in every `dilla_binding` (protocol/07-versioning.md).
pub const E2EE_VERSION: u64 = 1;
/// `media_version` for call groups (protocol/07-versioning.md).
pub const MEDIA_VERSION: u64 = 1;
/// The HTTP `/v1` and gateway frame version (protocol/07-versioning.md).
pub const WIRE_VERSION: u64 = 1;
/// The wasi ABI version every request carries as element 0.
///
/// **2** since 2026-09-24: `public_group_process`'s response grew from 6 to 8 elements (the
/// applied-proposal list and `committer_updated`) and `validate_key_package`'s from 5 to 6
/// (`kp_ref`). Both are response-shape changes, and dillad's host is the only consumer, so the
/// version moves instead of a compatibility shim being written (R27, interfaces §3).
///
/// **3** since 2026-09-29 (dillad-1 task 27a, Ruling C): `public_group_process`'s response grew a
/// ninth element, `new_leaf` — the leaf an external commit's joiner lands on — and the module
/// grew `device_list_entries`, the verified decoder of a user's signed device list (NV-B8).
///
/// **4** since 2026-10-05 (hardening C): `validate_key_package`'s response grew a seventh element,
/// the KeyPackage leaf's `signature_key`, and each item of `public_group_process`'s applied list a
/// sixth, the added leaf's `signature_key` (an Add's; null for every other proposal), so the
/// delivery service can bind a new leaf to the device's registered key without parsing MLS.
pub const ABI_VERSION: u64 = 4;
