package sframe

import (
	"bytes"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"strconv"
	"testing"
	"time"
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
		Canonical string `json:"canonical"`
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
	SenderRejects []struct {
		Name  string  `json:"name"`
		Codec string  `json:"codec"`
		Slot  uint8   `json:"slot"`
		Layer uint8   `json:"layer"`
		Input string  `json:"input"`
		Seq   *string `json:"seq"`
		Error string  `json:"error"`
	} `json:"sender_rejects"`
	Receiver []struct {
		Name  string `json:"name"`
		Steps []struct {
			Op        string   `json:"op"`
			Epoch     uint64   `json:"epoch"`
			BaseKey   string   `json:"base_key"`
			Roster    [][2]any `json:"roster"`
			OwnLeaf   int      `json:"own_leaf"`
			Now       int64    `json:"now"`
			Codec     string   `json:"codec"`
			Frame     string   `json:"frame"`
			Device    string   `json:"device"`
			TrackSlot uint8    `json:"track_slot"`
			Expect    string   `json:"expect"`
		} `json:"steps"`
	} `json:"receiver"`
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
	if len(v.Cases) != 4 || len(v.C1) != 34 || len(v.Escapes) != 8 || len(v.Rejects) != 37 {
		t.Fatalf("cases %d, c1 %d, escapes %d, rejects %d; want 4, 34, 8, 37",
			len(v.Cases), len(v.C1), len(v.Escapes), len(v.Rejects))
	}
	// Pinned exactly (CRYPTO-2): the four codec rules plus six H.264 sender shapes, so a frame that
	// disappears from the file fails here instead of leaving the runner green.
	if n := len(v.Frames); n != 10 {
		t.Fatalf("%d media frames, want 10", n)
	}
	steps := 0
	for _, s := range v.Receiver {
		for _, st := range s.Steps {
			if st.Op == "decrypt" {
				steps++
			}
		}
	}
	if len(v.SenderRejects) != 6 || len(v.Receiver) != 10 || steps != 30 {
		t.Fatalf("sender rejects %d, receiver scripts %d with %d decrypt steps; want 6, 10, 30",
			len(v.SenderRejects), len(v.Receiver), steps)
	}
}

// TestTheReceiverScript runs sframe.json's scripted key-ring runs through the Go KeyRing, each from
// an empty ring with a hand-moved clock: the Rust runner (run_sframe) runs the same steps.
func TestTheReceiverScript(t *testing.T) {
	for _, s := range loadVectors(t).Receiver {
		c := &clock{t: time.Unix(1_790_000_000, 0)}
		start := c.t
		r := NewKeyRing(c.now)
		for i, st := range s.Steps {
			c.t = start.Add(time.Duration(st.Now) * time.Millisecond)
			if st.Op == "install" {
				roster := make([]RosterEntry, 0, len(st.Roster))
				for _, m := range st.Roster {
					leaf, _ := m[0].(float64)
					dev, _ := m[1].(string)
					var d [16]byte
					copy(d[:], unhex(t, dev))
					roster = append(roster, RosterEntry{Leaf: uint16(leaf), Device: d})
				}
				r.InstallEpoch(st.Epoch, base16(t, st.BaseKey), roster, st.OwnLeaf)
				continue
			}
			var dev [16]byte
			copy(dev[:], unhex(t, st.Device))
			got := "ok"
			if _, err := r.Decrypt(codecNamed(t, st.Codec), unhex(t, st.Frame), &dev, Slot(st.TrackSlot)); err != nil {
				var code Error
				if !errors.As(err, &code) {
					t.Fatalf("%s step %d: %v is no protocol/05 code", s.Name, i, err)
				}
				got = string(code)
			}
			if got != st.Expect {
				t.Errorf("receiver %s step %d: %s, want %s", s.Name, i, got, st.Expect)
			}
		}
	}
}

// TestTheSenderRejects: a fresh sender (leaf 1, epoch 41, floor 41) refuses each row's input with
// its code, or, for a row with seq, the counter itself is refused.
func TestTheSenderRejects(t *testing.T) {
	v := loadVectors(t)
	base := base16(t, v.BaseKey)
	for _, row := range v.SenderRejects {
		var err error
		if row.Seq != nil {
			_, err = CTR(Slot(row.Slot), row.Layer, num(t, *row.Seq))
		} else {
			s, serr := NewSender(base, 1, 41, 41)
			if serr != nil {
				t.Fatal(serr)
			}
			_, err = s.Encrypt(codecNamed(t, row.Codec), Slot(row.Slot), row.Layer, unhex(t, row.Input))
		}
		var code Error
		if !errors.As(err, &code) || string(code) != row.Error {
			t.Errorf("%s: %v, want %s", row.Name, err, row.Error)
		}
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
		// A row whose sender rewrites the input carries `canonical`: the prefix is the canonical
		// frame's, and the receiver opens to it.
		canonical := input
		if f.Canonical != "" {
			canonical = unhex(t, f.Canonical)
		}
		if n, err := PrefixLen(c, canonical); err != nil || n != f.PrefixLen {
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
		if err != nil || !bytes.Equal(plain, canonical) {
			t.Errorf("%s: open = %x, %v, want %x", f.Name, plain, err, canonical)
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
