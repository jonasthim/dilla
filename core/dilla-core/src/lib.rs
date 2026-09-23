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

pub use error::{CoreError, ProtocolError};

/// The crate version, reported over every binding.
pub const CORE_VERSION: &str = env!("CARGO_PKG_VERSION");
/// `e2ee_version` as recorded in every `dilla_binding` (protocol/07-versioning.md).
pub const E2EE_VERSION: u64 = 1;
/// `media_version` for call groups (protocol/07-versioning.md).
pub const MEDIA_VERSION: u64 = 1;
/// The HTTP `/v1` and gateway frame version (protocol/07-versioning.md).
pub const WIRE_VERSION: u64 = 1;
/// The wasi ABI version carried in every request and response envelope.
pub const ABI_VERSION: u64 = 1;
