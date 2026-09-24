//! Deterministic CBOR (RFC 8949 section 4.2.1 core deterministic encoding) restricted to the
//! subset protocol/00-overview.md and protocol/04-envelope-and-franking.md define:
//! majors 0 (uint), 2 (bstr), 3 (tstr), 4 (array) and the simple value 22 (`null`).
//!
//! Every structure is a **fixed-position array**; there are no maps, so there is no map-key
//! ordering question. The decoder rejects non-minimal integer arguments, indefinite lengths,
//! reserved additional information, tags, floats, negative integers, every simple value other
//! than `null`, invalid UTF-8 and trailing bytes.
//!
//! This is a port of `packages/protocol-vectors/src/cbor.ts`, the reference implementation that
//! generates `protocol/vectors/*.json`. Keep the two in step: CI diffs the vectors in both
//! directions.

mod dec;
mod enc;

pub use dec::{Decoder, decode_strict};
pub use enc::Encoder;

/// The deepest array nesting `Decoder::skip` will descend through.
///
/// The typed readers (`array`, `uint`, `bytes`, ...) are driven by hand-written decoders whose
/// nesting is fixed at compile time, so the limit exists for `skip`, which is the only place an
/// attacker chooses the depth.
pub const MAX_NESTING: usize = 8;

/// Every way a strict decode can fail.
#[derive(Clone, PartialEq, Eq, Debug, thiserror::Error)]
#[non_exhaustive]
pub enum CborError {
    #[error("non-minimal integer argument")]
    NonMinimalInt,
    #[error("indefinite length or reserved additional info {0}")]
    IndefiniteOrReserved(u8),
    #[error("map not allowed")]
    MapForbidden,
    #[error("tag not allowed")]
    TagForbidden,
    #[error("float not allowed")]
    FloatForbidden,
    #[error("negative integer not allowed")]
    NegativeForbidden,
    #[error("simple value {0} not allowed")]
    SimpleForbidden(u8),
    #[error("trailing bytes after the top-level item")]
    TrailingBytes,
    #[error("truncated input")]
    Truncated,
    #[error("invalid utf-8 in text string")]
    InvalidUtf8,
    #[error("array length {actual}, expected {expected}")]
    WrongArrayLen { expected: usize, actual: usize },
    #[error("byte string length {actual}, expected {expected}")]
    WrongByteLen { expected: usize, actual: usize },
    #[error("expected {expected} at offset {offset}")]
    TypeMismatch {
        expected: &'static str,
        offset: usize,
    },
    #[error("integer does not fit")]
    IntegerOverflow,
    #[error("nesting deeper than {0}")]
    TooDeep(usize),
}

/// The number of bytes CBOR's preferred serialization spends on a head whose argument is `arg`,
/// the head byte included.
pub const fn head_len(arg: u64) -> usize {
    if arg < 24 {
        1
    } else if arg < 0x100 {
        2
    } else if arg < 0x1_0000 {
        3
    } else if arg < 0x1_0000_0000 {
        5
    } else {
        9
    }
}
