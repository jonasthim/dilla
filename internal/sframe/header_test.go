package sframe

import (
	"encoding/hex"
	"errors"
	"testing"
)

func unhex(t *testing.T, s string) []byte {
	t.Helper()
	b, err := hex.DecodeString(s)
	if err != nil {
		t.Fatalf("hex %q: %v", s, err)
	}
	return b
}

// The dilla boundaries RFC 9605 appendix C.1 does not list: 7 is the largest value the config byte
// carries, 8 the smallest that needs an extension byte.
func TestTheHeaderBoundariesRoundTrip(t *testing.T) {
	for _, c := range []struct {
		kid, ctr uint64
		hex      string
	}{
		{7, 7, "77"},
		{8, 8, "880808"},
		{7, 8, "7808"},
		{8, 7, "8708"},
		{0, 0, "00"},
		{0x123, 0x4567, "9901234567"},
		{1<<64 - 1, 1<<64 - 1, "ffffffffffffffffffffffffffffffffff"},
	} {
		if got := hex.EncodeToString(EncodeHeader(c.kid, c.ctr)); got != c.hex {
			t.Errorf("EncodeHeader(%d, %d) = %s, want %s", c.kid, c.ctr, got, c.hex)
		}
		kid, ctr, n, err := DecodeHeader(unhex(t, c.hex))
		if err != nil || kid != c.kid || ctr != c.ctr || n != len(c.hex)/2 {
			t.Errorf("DecodeHeader(%s) = %d, %d, %d, %v", c.hex, kid, ctr, n, err)
		}
	}
}

// Decoding is strict, in reading order: truncation of a field is reported before its minimality.
func TestDecodeHeaderRefusesTruncatedAndNonMinimalFields(t *testing.T) {
	for _, c := range []struct {
		hex  string
		want error
	}{
		{"", ErrTruncatedHeader},
		{"80", ErrTruncatedHeader},
		{"8f", ErrTruncatedHeader},
		{"99010001", ErrTruncatedHeader},
		{"8005", ErrNonMinimalHeader},
		{"0800", ErrNonMinimalHeader},
		{"9000ff", ErrNonMinimalHeader},
		{"f00000000000000000", ErrNonMinimalHeader},
		{"0f0000000000000008", ErrNonMinimalHeader},
		// 8100ff is a one-byte extended KID 00 (non-minimal), not a two-byte KID.
		{"8100ff", ErrNonMinimalHeader},
	} {
		if _, _, _, err := DecodeHeader(unhex(t, c.hex)); !errors.Is(err, c.want) {
			t.Errorf("DecodeHeader(%q) = %v, want %v", c.hex, err, c.want)
		}
	}
}

func TestTheErrorCodesAreProtocolFivesNineteen(t *testing.T) {
	want := []string{
		"E_SFRAME_TRUNCATED_HEADER", "E_SFRAME_NON_MINIMAL_HEADER", "E_SFRAME_NON_CANONICAL_KID", "E_SFRAME_TRUNCATED_FRAME",
		"E_SFRAME_MALFORMED_PREFIX", "E_SFRAME_UNSUPPORTED_CODEC", "E_SFRAME_NO_VCL_NAL",
		"E_SFRAME_NON_CANONICAL_SPS", "E_SFRAME_AUTH", "E_SFRAME_LAYER_RANGE",
		"E_SFRAME_COUNTER_EXHAUSTED", "E_SFRAME_LEAF_RANGE", "E_SFRAME_UNKNOWN_KID",
		"E_SFRAME_STALE_EPOCH", "E_SFRAME_LEAF_NOT_IN_EPOCH", "E_SFRAME_SENDER_MISMATCH",
		"E_SFRAME_OWN_KID", "E_SFRAME_SLOT_MISMATCH", "E_SFRAME_REPLAY",
	}
	if len(AllErrors) != len(want) {
		t.Fatalf("%d codes, want %d", len(AllErrors), len(want))
	}
	for i, e := range AllErrors {
		if e.Error() != want[i] {
			t.Errorf("AllErrors[%d] = %s, want %s", i, e, want[i])
		}
	}
}

func TestKIDAndCTRPackLikeTheRustCore(t *testing.T) {
	if got := KID(3, 297); got != 809 {
		t.Errorf("KID(3, 297) = %d, want 809 (leaf << 8 | epoch mod 256)", got)
	}
	ctr, err := CTR(Camera, 2, 1000)
	if err != nil || ctr != 81064793292669928 {
		t.Errorf("CTR(camera, 2, 1000) = %d, %v, want 81064793292669928", ctr, err)
	}
	if _, err := CTR(Mic, 16, 0); !errors.Is(err, ErrLayerRange) {
		t.Errorf("layer 16: %v, want %v", err, ErrLayerRange)
	}
	if _, err := CTR(Mic, 0, MaxSeq+1); !errors.Is(err, ErrCounterExhausted) {
		t.Errorf("seq 2^52: %v, want %v", err, ErrCounterExhausted)
	}
}
