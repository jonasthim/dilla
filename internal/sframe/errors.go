package sframe

// Error is a dilla-sframe/1 failure, spelled as its protocol/05 code. The codes never cross the
// wire: a receiver drops and counts a frame, a sender refuses to emit one. They are the strings the
// Rust core's SframeError displays and the media worker counts.
type Error string

func (e Error) Error() string { return string(e) }

const (
	ErrTruncatedHeader  Error = "E_SFRAME_TRUNCATED_HEADER"
	ErrNonMinimalHeader Error = "E_SFRAME_NON_MINIMAL_HEADER"
	ErrNonCanonicalKID  Error = "E_SFRAME_NON_CANONICAL_KID"
	ErrTruncatedFrame   Error = "E_SFRAME_TRUNCATED_FRAME"
	ErrMalformedPrefix  Error = "E_SFRAME_MALFORMED_PREFIX"
	ErrUnsupportedCodec Error = "E_SFRAME_UNSUPPORTED_CODEC"
	ErrNoVCLNAL         Error = "E_SFRAME_NO_VCL_NAL"
	ErrNonCanonicalSPS  Error = "E_SFRAME_NON_CANONICAL_SPS"
	ErrAuth             Error = "E_SFRAME_AUTH"
	ErrLayerRange       Error = "E_SFRAME_LAYER_RANGE"
	ErrCounterExhausted Error = "E_SFRAME_COUNTER_EXHAUSTED"
	ErrLeafRange        Error = "E_SFRAME_LEAF_RANGE"
	ErrUnknownKID       Error = "E_SFRAME_UNKNOWN_KID"
	ErrStaleEpoch       Error = "E_SFRAME_STALE_EPOCH"
	ErrLeafNotInEpoch   Error = "E_SFRAME_LEAF_NOT_IN_EPOCH"
	ErrSenderMismatch   Error = "E_SFRAME_SENDER_MISMATCH"
	ErrOwnKID           Error = "E_SFRAME_OWN_KID"
	ErrSlotMismatch     Error = "E_SFRAME_SLOT_MISMATCH"
	ErrReplay           Error = "E_SFRAME_REPLAY"
)

// AllErrors is every code in protocol/05's order (the Rust SframeError::ALL order).
var AllErrors = [19]Error{
	ErrTruncatedHeader, ErrNonMinimalHeader, ErrNonCanonicalKID, ErrTruncatedFrame, ErrMalformedPrefix,
	ErrUnsupportedCodec, ErrNoVCLNAL, ErrNonCanonicalSPS, ErrAuth, ErrLayerRange,
	ErrCounterExhausted, ErrLeafRange, ErrUnknownKID, ErrStaleEpoch, ErrLeafNotInEpoch,
	ErrSenderMismatch, ErrOwnKID, ErrSlotMismatch, ErrReplay,
}
