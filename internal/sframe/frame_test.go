package sframe

import (
	"bytes"
	"errors"
	"testing"
)

var testBase = [16]byte{0x0a, 0x0a, 0x0a, 0x0a, 0x0a, 0x0a, 0x0a, 0x0a, 0x0a, 0x0a, 0x0a, 0x0a, 0x0a, 0x0a, 0x0a, 0x0a}

func TestAFrameSealsAndOpensWithItsPrefixAuthenticated(t *testing.T) {
	kid := KID(3, 297)
	ctr, err := CTR(Camera, 2, 1000)
	if err != nil {
		t.Fatal(err)
	}
	k := DeriveKeys(testBase, kid)
	in := unhex(t, "5002009d012a8002e0010102030405060708")
	sealed, err := EncryptFrame(k, kid, ctr, 10, in)
	if err != nil {
		t.Fatalf("EncryptFrame: %v", err)
	}
	if !bytes.Equal(sealed[:10], in[:10]) || len(sealed) != len(in)+11+Nt {
		t.Fatalf("sealed %x: the prefix must stay clear and the overhead be header 11 + tag 16", sealed)
	}
	gotKID, gotCTR, out, err := OpenFrame(k, 10, sealed)
	if err != nil || gotKID != kid || gotCTR != ctr || !bytes.Equal(out, in) {
		t.Fatalf("OpenFrame = %d, %d, %x, %v", gotKID, gotCTR, out, err)
	}
	for _, at := range []int{6, 20, 21, len(sealed) - 1} {
		bad := bytes.Clone(sealed)
		bad[at] ^= 1
		if _, _, _, err := OpenFrame(k, 10, bad); !errors.Is(err, ErrAuth) {
			t.Errorf("byte %d flipped: %v, want %v", at, err, ErrAuth)
		}
	}
	if _, _, _, err := OpenFrame(k, 10, sealed[:10+11+15]); !errors.Is(err, ErrTruncatedFrame) {
		t.Errorf("15 tag bytes: %v, want %v", err, ErrTruncatedFrame)
	}
}

// After Protect, no start code (00 00 00, 00 00 01, 00 00 02) can form anywhere behind the clear
// H.264 prefix, counting the zeros the prefix ends with; 00 00 03 is the emulation byte itself.
func TestProtectEscapesEverythingBehindTheH264Prefix(t *testing.T) {
	kid := KID(3, 41)
	ctr, err := CTR(Camera, 0, 5)
	if err != nil {
		t.Fatal(err)
	}
	out, err := Protect(DeriveKeys(testBase, kid), kid, ctr, H264, unhex(t, vectorH264))
	if err != nil {
		t.Fatalf("Protect: %v", err)
	}
	zeros := int(trailingZeros(out[:28]))
	for _, b := range out[28:] {
		if zeros >= 2 && b <= 2 {
			t.Fatalf("an unescaped 00 00 %02x behind the prefix in %x", b, out)
		}
		if b == 0 {
			zeros++
		} else {
			zeros = 0
		}
	}
	x, n, err := UnescapeProtected(H264, out)
	if err != nil || n != 28 {
		t.Fatalf("UnescapeProtected: %d, %v", n, err)
	}
	if _, _, plain, err := OpenFrame(DeriveKeys(testBase, kid), n, x); err != nil || !bytes.Equal(plain, unhex(t, vectorH264)) {
		t.Fatalf("open after unescape = %x, %v", plain, err)
	}
}

func TestTheVP8PrefixIsTenBytesForAKeyFrameAndOneOtherwise(t *testing.T) {
	if n, err := PrefixLen(VP8, unhex(t, "5002009d012a8002e001ff")); err != nil || n != 10 {
		t.Errorf("key frame: %d, %v", n, err)
	}
	if n, err := PrefixLen(VP8, unhex(t, "31aa")); err != nil || n != 1 {
		t.Errorf("delta frame: %d, %v", n, err)
	}
	if _, err := PrefixLen(VP8, unhex(t, "5002009d012a8002e0")); !errors.Is(err, ErrMalformedPrefix) {
		t.Errorf("a 9-byte key frame: %v, want %v", err, ErrMalformedPrefix)
	}
	if n, err := PrefixLen(Opus, []byte{0xfc}); err != nil || n != 0 {
		t.Errorf("opus: %d, %v", n, err)
	}
	if _, err := PrefixLen(Codec(9), []byte{1}); !errors.Is(err, ErrUnsupportedCodec) {
		t.Errorf("codec 9: %v, want %v", err, ErrUnsupportedCodec)
	}
}
