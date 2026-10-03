package sframe

import (
	"bytes"
	"errors"
	"strings"
	"testing"
)

// The vector frame: SPS, PPS and an IDR with 4-byte start codes (sframe.json's H.264 input).
const vectorH264 = "000000016742c01e95a0501ec80000000168ce3c800000000165888421ff00000312345a5a5a5a"

// A Constrained Baseline SPS (640x480, one reference frame) whose VUI carries the bitstream
// restriction libwebrtc's outgoing rewrite writes: task 4's hand-built STABLE_SPS, not a measurement.
const stableSPS = "6742c01fda0280f68078442350"

func TestTheVectorFrameHasATwentyEightBytePrefix(t *testing.T) {
	n, err := PrefixLen(H264, unhex(t, vectorH264))
	if err != nil || n != 28 {
		t.Fatalf("PrefixLen = %d, %v, want 28 (SPS 13 + PPS 8 + start code 4 + header 1 + 2 bytes through pps_id)", n, err)
	}
}

// The server-sdk-go example key frame: libdave's rule keeps the byte holding pic_parameter_set_id
// clear, where the SDK's own "+2" would encrypt it.
func TestThePrefixRunsThroughThePPSIDOfTheSDKExample(t *testing.T) {
	frame := unhex(t, strings.ReplaceAll("00000001 6742c01f0fd91f888884000003000400000300c83c60c920 "+
		"00000001 6887cb83cb20 00000001 6588840af2628000a7be", " ", ""))
	n, err := PrefixLen(H264, frame)
	if err != nil {
		t.Fatalf("PrefixLen: %v", err)
	}
	if !bytes.HasSuffix(frame[:n], []byte{0x65, 0x88, 0x84}) || len(frame)-n != 7 {
		t.Fatalf("prefix ends %x with %d bytes after it, want …658884 and 7", frame[n-3:n], len(frame)-n)
	}
}

// libwebrtc's FindNaluIndices: leading garbage dropped, a 3-byte start code rewritten to four
// bytes, and a zero more than a start code needs kept in the previous NAL's payload.
func TestCanonicalisationRewritesStartCodesLikeTheReceiver(t *testing.T) {
	in := unhex(t, "ffee"+"000001"+"6742c01e95a0501ec8"+"000001"+"68ce3c80"+"0000000001"+"65888421ff")
	out, n, err := canonicalizeH264(in)
	if err != nil {
		t.Fatalf("canonicalizeH264: %v", err)
	}
	want := unhex(t, "00000001"+"6742c01e95a0501ec8"+"00000001"+"68ce3c8000"+"00000001"+"65888421ff")
	if !bytes.Equal(out, want) || n != 29 {
		t.Fatalf("canonical = %x (prefix %d), want %x (prefix 29)", out, n, want)
	}
}

func TestTheH264PrefixRefusesWhatItCannotCover(t *testing.T) {
	for _, c := range []struct {
		name, hex string
		want      error
	}{
		{"no start code", "6742c01e95a0501ec8", ErrMalformedPrefix},
		{"partitioned slice (type 2)", "0000000102aabbcc", ErrUnsupportedCodec},
		{"MVC slice (type 20)", "0000000114aabbcc", ErrUnsupportedCodec},
		{"STAP-A inside a frame (type 24)", "0000000118aabbcc", ErrMalformedPrefix},
		{"SPS and PPS only", "000000016742c01e95a0501ec80000000168ce3c80", ErrNoVCLNAL},
		{"pic_parameter_set_id 256", "0000000165c0203fff", ErrMalformedPrefix},
	} {
		if _, err := PrefixLen(H264, unhex(t, c.hex)); !errors.Is(err, c.want) {
			t.Errorf("%s: %v, want %v", c.name, err, c.want)
		}
	}
	// pic_parameter_set_id 255 is the largest libwebrtc accepts: 19 bits of slice header, 3 bytes.
	if n, err := PrefixLen(H264, unhex(t, "0000000165c0201fff")); err != nil || n != 8 {
		t.Errorf("pps_id 255: %d, %v, want 8", n, err)
	}
}

func TestTrailingZerosSeedTheEscape(t *testing.T) {
	for _, c := range []struct {
		in   []byte
		want uint8
	}{{nil, 0}, {[]byte{1, 0}, 1}, {[]byte{0, 0, 0}, 2}, {[]byte{0, 1}, 0}} {
		if got := trailingZeros(c.in); got != c.want {
			t.Errorf("trailingZeros(%x) = %d, want %d", c.in, got, c.want)
		}
	}
}

func TestTheVUICheckAcceptsAStableSPSAndRefusesTheRest(t *testing.T) {
	if err := CheckSPSVUI(unhex(t, stableSPS)); err != nil {
		t.Errorf("the stable SPS: %v", err)
	}
	// The vector's synthetic SPS ends inside its VUI: no bitstream restriction.
	if err := CheckSPSVUI(unhex(t, "6742c01e95a0501ec8")); !errors.Is(err, ErrNonCanonicalSPS) {
		t.Errorf("the synthetic SPS: %v, want %v", err, ErrNonCanonicalSPS)
	}
	if err := CheckSPSVUI(unhex(t, "68ce3c80")); !errors.Is(err, ErrNonCanonicalSPS) {
		t.Errorf("a PPS: %v, want %v", err, ErrNonCanonicalSPS)
	}
	good := unhex(t, "00000001"+stableSPS+"0000000168ce3c800000000165888421")
	if err := checkPrefixSPS(good); err != nil {
		t.Errorf("a prefix carrying the stable SPS: %v", err)
	}
	if err := checkPrefixSPS(unhex(t, vectorH264)); !errors.Is(err, ErrNonCanonicalSPS) {
		t.Errorf("a prefix carrying the synthetic SPS: %v, want %v", err, ErrNonCanonicalSPS)
	}
}
