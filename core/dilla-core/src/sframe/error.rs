//! The non-wire `dilla-sframe/1` error vocabulary (protocol/05 "Errors").
//!
//! These codes never cross the wire: a receiver drops and counts a frame, a sender refuses to emit
//! one. They are published in protocol/05 so that every implementation (this crate, the pure-Go
//! port, the media worker's counters) names a failure the same way. They are deliberately **not**
//! `ProtocolError` variants: that enum's twenty codes change only through protocol/07's process,
//! and `core/dilla-core/src/error.rs` pins its count.

/// Every way a `dilla-sframe/1` operation can fail. `Display` is the bare `E_SFRAME_*` code, which
/// is what the wasm surface throws and what the vectors' `error` fields hold.
#[derive(Clone, Copy, Debug, PartialEq, Eq, thiserror::Error)]
pub enum SframeError {
    #[error("E_SFRAME_TRUNCATED_HEADER")]
    TruncatedHeader,
    #[error("E_SFRAME_NON_MINIMAL_HEADER")]
    NonMinimalHeader,
    #[error("E_SFRAME_TRUNCATED_FRAME")]
    TruncatedFrame,
    #[error("E_SFRAME_MALFORMED_PREFIX")]
    MalformedPrefix,
    #[error("E_SFRAME_UNSUPPORTED_CODEC")]
    UnsupportedCodec,
    #[error("E_SFRAME_NO_VCL_NAL")]
    NoVclNal,
    #[error("E_SFRAME_NON_CANONICAL_SPS")]
    NonCanonicalSps,
    #[error("E_SFRAME_AUTH")]
    AuthFailed,
    #[error("E_SFRAME_LAYER_RANGE")]
    LayerOutOfRange,
    #[error("E_SFRAME_COUNTER_EXHAUSTED")]
    CounterExhausted,
    #[error("E_SFRAME_LEAF_RANGE")]
    LeafOutOfRange,
    #[error("E_SFRAME_UNKNOWN_KID")]
    UnknownKid,
    #[error("E_SFRAME_STALE_EPOCH")]
    StaleEpoch,
    #[error("E_SFRAME_LEAF_NOT_IN_EPOCH")]
    LeafNotInEpoch,
    #[error("E_SFRAME_SENDER_MISMATCH")]
    SenderMismatch,
    #[error("E_SFRAME_OWN_KID")]
    OwnKid,
    #[error("E_SFRAME_SLOT_MISMATCH")]
    SlotMismatch,
    #[error("E_SFRAME_REPLAY")]
    Replay,
}

impl SframeError {
    /// Every variant, in declaration order. The tests pin the count and the code strings.
    pub const ALL: [SframeError; 18] = [
        SframeError::TruncatedHeader,
        SframeError::NonMinimalHeader,
        SframeError::TruncatedFrame,
        SframeError::MalformedPrefix,
        SframeError::UnsupportedCodec,
        SframeError::NoVclNal,
        SframeError::NonCanonicalSps,
        SframeError::AuthFailed,
        SframeError::LayerOutOfRange,
        SframeError::CounterExhausted,
        SframeError::LeafOutOfRange,
        SframeError::UnknownKid,
        SframeError::StaleEpoch,
        SframeError::LeafNotInEpoch,
        SframeError::SenderMismatch,
        SframeError::OwnKid,
        SframeError::SlotMismatch,
        SframeError::Replay,
    ];

    /// The stable `E_SFRAME_*` code, identical to `Display`.
    pub const fn code(self) -> &'static str {
        match self {
            SframeError::TruncatedHeader => "E_SFRAME_TRUNCATED_HEADER",
            SframeError::NonMinimalHeader => "E_SFRAME_NON_MINIMAL_HEADER",
            SframeError::TruncatedFrame => "E_SFRAME_TRUNCATED_FRAME",
            SframeError::MalformedPrefix => "E_SFRAME_MALFORMED_PREFIX",
            SframeError::UnsupportedCodec => "E_SFRAME_UNSUPPORTED_CODEC",
            SframeError::NoVclNal => "E_SFRAME_NO_VCL_NAL",
            SframeError::NonCanonicalSps => "E_SFRAME_NON_CANONICAL_SPS",
            SframeError::AuthFailed => "E_SFRAME_AUTH",
            SframeError::LayerOutOfRange => "E_SFRAME_LAYER_RANGE",
            SframeError::CounterExhausted => "E_SFRAME_COUNTER_EXHAUSTED",
            SframeError::LeafOutOfRange => "E_SFRAME_LEAF_RANGE",
            SframeError::UnknownKid => "E_SFRAME_UNKNOWN_KID",
            SframeError::StaleEpoch => "E_SFRAME_STALE_EPOCH",
            SframeError::LeafNotInEpoch => "E_SFRAME_LEAF_NOT_IN_EPOCH",
            SframeError::SenderMismatch => "E_SFRAME_SENDER_MISMATCH",
            SframeError::OwnKid => "E_SFRAME_OWN_KID",
            SframeError::SlotMismatch => "E_SFRAME_SLOT_MISMATCH",
            SframeError::Replay => "E_SFRAME_REPLAY",
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_eighteen_codes_are_the_published_strings() {
        let codes: Vec<&str> = SframeError::ALL.iter().map(|e| e.code()).collect();
        assert_eq!(
            codes,
            [
                "E_SFRAME_TRUNCATED_HEADER",
                "E_SFRAME_NON_MINIMAL_HEADER",
                "E_SFRAME_TRUNCATED_FRAME",
                "E_SFRAME_MALFORMED_PREFIX",
                "E_SFRAME_UNSUPPORTED_CODEC",
                "E_SFRAME_NO_VCL_NAL",
                "E_SFRAME_NON_CANONICAL_SPS",
                "E_SFRAME_AUTH",
                "E_SFRAME_LAYER_RANGE",
                "E_SFRAME_COUNTER_EXHAUSTED",
                "E_SFRAME_LEAF_RANGE",
                "E_SFRAME_UNKNOWN_KID",
                "E_SFRAME_STALE_EPOCH",
                "E_SFRAME_LEAF_NOT_IN_EPOCH",
                "E_SFRAME_SENDER_MISMATCH",
                "E_SFRAME_OWN_KID",
                "E_SFRAME_SLOT_MISMATCH",
                "E_SFRAME_REPLAY",
            ]
        );
        for e in SframeError::ALL {
            assert_eq!(e.to_string(), e.code(), "Display is the bare code");
        }
    }
}
