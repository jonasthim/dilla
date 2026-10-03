package sframe

import (
	"bytes"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"strconv"
	"testing"
)

// sframe.json as task 4's generator writes it (packages/protocol-vectors/src/generate.ts). Every
// row the Rust runner checks, this file checks against the pure-Go implementation: the two must
// agree byte for byte (DEV-39).
type vectorFile struct {
	BaseKey string `json:"base_key"`
	Cases   []struct {
		LeafIndex uint16 `json:"leaf_index"`
		Epoch     uint64 `json:"epoch"`
		KID       string `json:"kid"`
		Key       string `json:"key"`
		Salt      string `json:"salt"`
		Slot      uint8  `json:"slot"`
		Layer     uint8  `json:"layer"`
		Seq       uint64 `json:"seq"`
		CTR       string `json:"ctr"`
		Nonce     string `json:"nonce"`
		Header    string `json:"header"`
	} `json:"cases"`
	C1 []struct {
		KID    string `json:"kid"`
		CTR    string `json:"ctr"`
		Header string `json:"header"`
	} `json:"rfc9605_c1"`
	C3 struct {
		BaseKey   string `json:"base_key"`
		KID       string `json:"kid"`
		CTR       string `json:"ctr"`
		Key       string `json:"key"`
		Salt      string `json:"salt"`
		Nonce     string `json:"nonce"`
		Prefix    string `json:"prefix"`
		Plaintext string `json:"plaintext"`
		Frame     string `json:"frame"`
	} `json:"rfc9605_c3"`
	Frames []struct {
		Name      string `json:"name"`
		Codec     string `json:"codec"`
		LeafIndex uint16 `json:"leaf_index"`
		Epoch     uint64 `json:"epoch"`
		Slot      uint8  `json:"slot"`
		Layer     uint8  `json:"layer"`
		Seq       uint64 `json:"seq"`
		Input     string `json:"input"`
		PrefixLen int    `json:"prefix_len"`
		Frame     string `json:"frame"`
	} `json:"media_frames"`
	Escapes []struct {
		Seed uint8  `json:"seed_zeros"`
		In   string `json:"in"`
		Out  string `json:"out"`
	} `json:"escapes"`
	Rejects []struct {
		Name   string  `json:"name"`
		Header *string `json:"header"`
		Codec  string  `json:"codec"`
		Frame  string  `json:"frame"`
		Error  string  `json:"error"`
	} `json:"rejects"`
}

func loadVectors(t *testing.T) vectorFile {
	t.Helper()
	raw, err := os.ReadFile("../../protocol/vectors/sframe.json")
	if err != nil {
		t.Fatalf("read sframe.json: %v", err)
	}
	var v vectorFile
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatalf("decode sframe.json: %v", err)
	}
	return v
}

func num(t *testing.T, s string) uint64 {
	t.Helper()
	n, err := strconv.ParseUint(s, 10, 64)
	if err != nil {
		t.Fatalf("decimal %q: %v", s, err)
	}
	return n
}

func base16(t *testing.T, s string) [16]byte {
	t.Helper()
	var b [16]byte
	if n := copy(b[:], unhex(t, s)); n != 16 {
		t.Fatalf("base key %q is %d bytes", s, n)
	}
	return b
}

func codecNamed(t *testing.T, name string) Codec {
	t.Helper()
	switch name {
	case "opus":
		return Opus
	case "vp8":
		return VP8
	case "vp9":
		return VP9
	case "h264":
		return H264
	}
	t.Fatalf("codec %q", name)
	return 0
}

// openVector is the receiver's path over a vector frame: unescape, read the KID, derive, open.
func openVector(base [16]byte, c Codec, frame []byte) ([]byte, error) {
	x, n, err := UnescapeProtected(c, frame)
	if err != nil {
		return nil, err
	}
	kid, _, _, err := peekKIDCTR(n, x)
	if err != nil {
		return nil, err
	}
	_, _, out, err := OpenFrame(DeriveKeys(base, kid), n, x)
	return out, err
}

func TestTheSuitesOfSframeJSONArePresent(t *testing.T) {
	v := loadVectors(t)
	if len(v.Cases) != 4 || len(v.C1) != 34 || len(v.Escapes) != 8 || len(v.Rejects) != 23 {
		t.Fatalf("cases %d, c1 %d, escapes %d, rejects %d; want 4, 34, 8, 23",
			len(v.Cases), len(v.C1), len(v.Escapes), len(v.Rejects))
	}
	// MD-2: four media frames when SP-04 shipped the H.264 entry, three when it did not.
	if n := len(v.Frames); n != 3 && n != 4 {
		t.Fatalf("%d media frames, want 3 or 4", n)
	}
}

func TestTheKeyScheduleCases(t *testing.T) {
	v := loadVectors(t)
	base := base16(t, v.BaseKey)
	for _, c := range v.Cases {
		kid := KID(c.LeafIndex, c.Epoch)
		if kid != num(t, c.KID) {
			t.Errorf("KID(%d, %d) = %d, want %s", c.LeafIndex, c.Epoch, kid, c.KID)
		}
		k := DeriveKeys(base, kid)
		if hex.EncodeToString(k.Key[:]) != c.Key || hex.EncodeToString(k.Salt[:]) != c.Salt {
			t.Errorf("kid %d: key %x salt %x, want %s %s", kid, k.Key, k.Salt, c.Key, c.Salt)
		}
		ctr, err := CTR(Slot(c.Slot), c.Layer, c.Seq)
		if err != nil || ctr != num(t, c.CTR) {
			t.Errorf("CTR(%d, %d, %d) = %d, %v, want %s", c.Slot, c.Layer, c.Seq, ctr, err, c.CTR)
		}
		if got := hex.EncodeToString(nonce(k.Salt, ctr)); got != c.Nonce {
			t.Errorf("nonce = %s, want %s", got, c.Nonce)
		}
		if got := hex.EncodeToString(EncodeHeader(kid, ctr)); got != c.Header {
			t.Errorf("header = %s, want %s", got, c.Header)
		}
	}
}

func TestRFC9605AppendixC1Headers(t *testing.T) {
	for _, c := range loadVectors(t).C1 {
		kid, ctr := num(t, c.KID), num(t, c.CTR)
		if got := hex.EncodeToString(EncodeHeader(kid, ctr)); got != c.Header {
			t.Errorf("EncodeHeader(%d, %d) = %s, want %s", kid, ctr, got, c.Header)
		}
		k, cr, n, err := DecodeHeader(unhex(t, c.Header))
		if err != nil || k != kid || cr != ctr || n != len(c.Header)/2 {
			t.Errorf("DecodeHeader(%s) = %d %d %d %v", c.Header, k, cr, n, err)
		}
	}
}

func TestRFC9605AppendixC3AsADillaFrame(t *testing.T) {
	c3 := loadVectors(t).C3
	base := base16(t, c3.BaseKey)
	kid, ctr := num(t, c3.KID), num(t, c3.CTR)
	k := DeriveKeys(base, kid)
	if hex.EncodeToString(k.Key[:]) != c3.Key || hex.EncodeToString(k.Salt[:]) != c3.Salt {
		t.Fatalf("key %x salt %x, want %s %s", k.Key, k.Salt, c3.Key, c3.Salt)
	}
	if got := hex.EncodeToString(nonce(k.Salt, ctr)); got != c3.Nonce {
		t.Fatalf("nonce %s, want %s", got, c3.Nonce)
	}
	prefix := unhex(t, c3.Prefix)
	input := append(bytes.Clone(prefix), unhex(t, c3.Plaintext)...)
	out, err := EncryptFrame(k, kid, ctr, len(prefix), input)
	if err != nil || hex.EncodeToString(out) != c3.Frame {
		t.Fatalf("EncryptFrame = %x, %v, want %s", out, err, c3.Frame)
	}
	if _, _, plain, err := OpenFrame(k, len(prefix), unhex(t, c3.Frame)); err != nil || !bytes.Equal(plain, input) {
		t.Fatalf("OpenFrame = %x, %v", plain, err)
	}
}

func TestTheMediaFrames(t *testing.T) {
	v := loadVectors(t)
	base := base16(t, v.BaseKey)
	for _, f := range v.Frames {
		c := codecNamed(t, f.Codec)
		input := unhex(t, f.Input)
		if n, err := PrefixLen(c, input); err != nil || n != f.PrefixLen {
			t.Errorf("%s: PrefixLen = %d, %v, want %d", f.Name, n, err, f.PrefixLen)
		}
		kid := KID(f.LeafIndex, f.Epoch)
		ctr, err := CTR(Slot(f.Slot), f.Layer, f.Seq)
		if err != nil {
			t.Fatalf("%s: %v", f.Name, err)
		}
		out, err := Protect(DeriveKeys(base, kid), kid, ctr, c, input)
		if err != nil || hex.EncodeToString(out) != f.Frame {
			t.Errorf("%s: Protect = %x, %v, want %s", f.Name, out, err, f.Frame)
		}
		plain, err := openVector(base, c, unhex(t, f.Frame))
		if err != nil || !bytes.Equal(plain, input) {
			t.Errorf("%s: open = %x, %v, want %s", f.Name, plain, err, f.Input)
		}
	}
}

func TestTheSeededEscapes(t *testing.T) {
	for i, e := range loadVectors(t).Escapes {
		if got := hex.EncodeToString(RBSPEscape(e.Seed, unhex(t, e.In))); got != e.Out {
			t.Errorf("escape %d seed %d: %s, want %s", i, e.Seed, got, e.Out)
		}
		if got := hex.EncodeToString(RBSPUnescape(e.Seed, unhex(t, e.Out))); got != e.In {
			t.Errorf("unescape %d seed %d: %s, want %s", i, e.Seed, got, e.In)
		}
	}
}

func TestTheRejects(t *testing.T) {
	v := loadVectors(t)
	base := base16(t, v.BaseKey)
	for _, r := range v.Rejects {
		var err error
		if r.Header != nil {
			_, _, _, err = peekKIDCTR(0, unhex(t, *r.Header))
		} else {
			_, err = openVector(base, codecNamed(t, r.Codec), unhex(t, r.Frame))
		}
		var code Error
		if !errors.As(err, &code) || string(code) != r.Error {
			t.Errorf("%s: %v, want %s", r.Name, err, r.Error)
		}
	}
}
