//! dilla-core: the cryptographic, protocol and storage core of dilla.
//!
//! Every module here is target-agnostic. The two binding crates
//! (`dilla-core-wasm`, `dilla-core-wasi`) hold the target-specific glue.
#![forbid(unsafe_code)]

pub mod cbor;
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
pub const ABI_VERSION: u64 = 2;
