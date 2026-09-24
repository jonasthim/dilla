package cborx

import (
	"encoding/hex"
	"errors"
	"testing"

	"github.com/fxamacker/cbor/v2"
)

func mustHex(t *testing.T, s string) []byte {
	t.Helper()
	b, err := hex.DecodeString(s)
	if err != nil {
		t.Fatalf("bad hex %q: %v", s, err)
	}
	return b
}

// The accept corpus of interfaces.md 2.3: every item must survive
// CheckDeterministic and re-encode to exactly the same bytes.
func TestAcceptCorpus(t *testing.T) {
	cases := []struct {
		name  string
		hex   string
		value any
	}{
		{"uint 0", "00", uint64(0)},
		{"uint 1", "01", uint64(1)},
		{"uint 10", "0a", uint64(10)},
		{"uint 23", "17", uint64(23)},
		{"uint 24", "1818", uint64(24)},
		{"uint 25", "1819", uint64(25)},
		{"uint 100", "1864", uint64(100)},
		{"uint 1000", "1903e8", uint64(1000)},
		{"uint 1000000", "1a000f4240", uint64(1000000)},
		{"uint 1000000000000", "1b000000e8d4a51000", uint64(1000000000000)},
		{"text empty", "60", ""},
		{"text a", "6161", "a"},
		{"text IETF", "6449455446", "IETF"},
		{"text u umlaut", "62c3bc", "ü"},
		{"bytes empty", "40", []byte{}},
		{"bytes 4", "4401020304", []byte{1, 2, 3, 4}},
		{"null", "f6", nil},
		{"array empty", "80", []uint64{}},
		{"array 1 2 3", "83010203", []uint64{1, 2, 3}},
		{"nested arrays", "8301820203820405", []any{uint64(1), []uint64{2, 3}, []uint64{4, 5}}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			raw := mustHex(t, tc.hex)
			if err := CheckDeterministic(raw); err != nil {
				t.Fatalf("CheckDeterministic(%s) = %v, want nil", tc.hex, err)
			}
			got, err := Marshal(tc.value)
			if err != nil {
				t.Fatalf("Marshal: %v", err)
			}
			if hex.EncodeToString(got) != tc.hex {
				t.Errorf("Marshal round trip = %s, want %s", hex.EncodeToString(got), tc.hex)
			}
		})
	}
}

// The reject corpus of interfaces.md 2.3. Each entry names the sentinel the
// strict layer must return, so a wrong-but-still-failing decoder is caught too.
func TestRejectCorpus(t *testing.T) {
	cases := []struct {
		name string
		hex  string
		want error
	}{
		{"non-minimal 1 in one byte", "1801", ErrNonMinimalInt},
		{"non-minimal 23 in one byte", "1817", ErrNonMinimalInt},
		{"non-minimal 23 in two bytes", "190017", ErrNonMinimalInt},
		{"non-minimal 23 in four bytes", "1a00000017", ErrNonMinimalInt},
		{"non-minimal 23 in eight bytes", "1b0000000000000017", ErrNonMinimalInt},
		{"non-minimal 255 in two bytes", "1900ff", ErrNonMinimalInt},
		{"non-minimal bstr length", "5800", ErrNonMinimalInt},
		{"non-minimal tstr length", "7800", ErrNonMinimalInt},
		{"non-minimal array length", "9800", ErrNonMinimalInt},
		{"non-minimal array length two bytes", "990003010203", ErrNonMinimalInt},
		{"indefinite array", "9f01ff", ErrIndefiniteOrReserved},
		{"indefinite bstr", "5f41014102ff", ErrIndefiniteOrReserved},
		{"indefinite tstr", "7f6161ff", ErrIndefiniteOrReserved},
		// dilla-core's Decoder::head checks the additional info before the major
		// type (plan-A1 task 2, `if ai >= 28 { return Err(IndefiniteOrReserved) }`
		// ahead of the `match major` arm), and its own test asserts
		// CborError::IndefiniteOrReserved(31) for this exact input. interfaces.md
		// §2.3 also files bf0101ff under "(indefinite)", not "(map)".
		{"indefinite map", "bf0101ff", ErrIndefiniteOrReserved},
		{"empty map", "a0", ErrMapForbidden},
		{"one-pair map", "a10102", ErrMapForbidden},
		{"tag 1 epoch", "c11a514b67b0", ErrTagForbidden},
		{"tag 255", "d8ff01", ErrTagForbidden},
		{"tag 0", "c001", ErrTagForbidden},
		{"float64", "fb3ff0000000000000", ErrFloatForbidden},
		{"float16", "f93c00", ErrFloatForbidden},
		{"negative integer", "20", ErrNegativeForbidden},
		{"undefined", "f7", ErrSimpleForbidden},
		{"one-byte simple", "f816", ErrSimpleForbidden},
		{"reserved ai 28", "1c", ErrIndefiniteOrReserved},
		{"reserved ai 29", "1d", ErrIndefiniteOrReserved},
		{"reserved ai 30", "1e", ErrIndefiniteOrReserved},
		{"trailing uint", "0101", ErrTrailingBytes},
		{"trailing map", "01a0", ErrTrailingBytes},
		{"trailing break", "83010203ff", ErrTrailingBytes},
		{"trailing breaks", "83010203ffffffff", ErrTrailingBytes},
		{"truncated bstr", "5820", ErrTruncated},
		{"invalid utf-8", "6263c3", ErrInvalidUTF8},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := CheckDeterministic(mustHex(t, tc.hex))
			if !errors.Is(err, tc.want) {
				t.Errorf("CheckDeterministic(%s) = %v, want %v", tc.hex, err, tc.want)
			}
		})
	}
}

// fxamacker/cbor v2.9.4 decodes a CBOR array straight into a Go []byte, so the
// two shape entries of the 2.3 reject corpus need ExpectMajor, not the
// deterministic check (which correctly accepts both as well-formed CBOR).
func TestExpectMajorCatchesShapeConfusion(t *testing.T) {
	arrayOfTwo := mustHex(t, "820102")
	bytesOfTwo := mustHex(t, "420102")

	if err := CheckDeterministic(arrayOfTwo); err != nil {
		t.Fatalf("820102 is well-formed deterministic CBOR: %v", err)
	}
	if err := CheckDeterministic(bytesOfTwo); err != nil {
		t.Fatalf("420102 is well-formed deterministic CBOR: %v", err)
	}
	if err := ExpectMajor(arrayOfTwo, MajorBytes); !errors.Is(err, ErrWrongMajor) {
		t.Errorf("ExpectMajor(820102, MajorBytes) = %v, want ErrWrongMajor", err)
	}
	if err := ExpectMajor(bytesOfTwo, MajorArray); !errors.Is(err, ErrWrongMajor) {
		t.Errorf("ExpectMajor(420102, MajorArray) = %v, want ErrWrongMajor", err)
	}
	if err := ExpectMajor(arrayOfTwo, MajorArray); err != nil {
		t.Errorf("ExpectMajor(820102, MajorArray) = %v, want nil", err)
	}
	if err := ExpectMajor(bytesOfTwo, MajorBytes); err != nil {
		t.Errorf("ExpectMajor(420102, MajorBytes) = %v, want nil", err)
	}

	// The same confusion, through the typed decoder: proof that the library
	// alone would let it through.
	var target []byte
	if err := Unmarshal(arrayOfTwo, &target); err != nil {
		t.Fatalf("Unmarshal: %v", err)
	}
	if len(target) != 2 {
		t.Fatalf("expected fxamacker to absorb the array into []byte, got %v", target)
	}
}

func TestUnmarshalRejectsTrailingBytesAndNonMinimalHeads(t *testing.T) {
	var v uint64
	if err := Unmarshal(mustHex(t, "0101"), &v); !errors.Is(err, ErrTrailingBytes) {
		t.Errorf("Unmarshal(0101) = %v, want ErrTrailingBytes", err)
	}
	if err := Unmarshal(mustHex(t, "1801"), &v); !errors.Is(err, ErrNonMinimalInt) {
		t.Errorf("Unmarshal(1801) = %v, want ErrNonMinimalInt", err)
	}
}

func TestNestingLimit(t *testing.T) {
	// Nine nested one-element arrays: one level deeper than MaxNesting.
	deep := make([]byte, 0, MaxNesting+2)
	for range MaxNesting + 1 {
		deep = append(deep, 0x81)
	}
	deep = append(deep, 0x01)
	if err := CheckDeterministic(deep); !errors.Is(err, ErrTooDeep) {
		t.Errorf("CheckDeterministic(nine nested arrays) = %v, want ErrTooDeep", err)
	}
}

func TestDecModeForbidsIndefiniteLengthsAndTags(t *testing.T) {
	dm, err := DecMode()
	if err != nil {
		t.Fatalf("DecMode: %v", err)
	}
	if got := dm.DecOptions().IndefLength; got != cbor.IndefLengthForbidden {
		t.Errorf("DecOptions().IndefLength = %v, want IndefLengthForbidden", got)
	}
	if got := dm.DecOptions().TagsMd; got != cbor.TagsForbidden {
		t.Errorf("DecOptions().TagsMd = %v, want TagsForbidden", got)
	}
}

func TestEncModeIsCoreDeterministic(t *testing.T) {
	em, err := EncMode()
	if err != nil {
		t.Fatalf("EncMode: %v", err)
	}
	if got := em.EncOptions().IndefLength; got != cbor.IndefLengthForbidden {
		t.Errorf("EncOptions().IndefLength = %v, want IndefLengthForbidden", got)
	}
	if got := em.EncOptions().Sort; got != cbor.SortCoreDeterministic {
		t.Errorf("EncOptions().Sort = %v, want SortCoreDeterministic", got)
	}
}

// envelopeV1 mirrors the nine-element array of
// protocol/04-envelope-and-franking.md. The toarray tag gives fixed positions
// and disables omitempty and omitzero, so a zero value can never shift the
// position of a later element.
type envelopeV1 struct {
	_           struct{} `cbor:",toarray"`
	V           uint64
	MsgID       []byte
	Type        uint64
	ThreadID    []byte
	ReplyTo     []byte
	Body        string
	Attachments []cbor.RawMessage
	Previews    []cbor.RawMessage
	KF          []byte
}

// Golden case "delete tombstone" from protocol/vectors/envelope.json.
func TestToarrayStructReproducesTheEnvelopeVector(t *testing.T) {
	const want = "8901502121212121212121212121212121212102f65001010101010101010101010101010101" +
		"60808058202626262626262626262626262626262626262626262626262626262626262626"
	e := envelopeV1{
		V:           1,
		MsgID:       mustHex(t, "21212121212121212121212121212121"),
		Type:        2,
		ThreadID:    nil,
		ReplyTo:     mustHex(t, "01010101010101010101010101010101"),
		Body:        "",
		Attachments: []cbor.RawMessage{},
		Previews:    []cbor.RawMessage{},
		KF:          mustHex(t, "2626262626262626262626262626262626262626262626262626262626262626"),
	}
	got, err := Marshal(e)
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}
	if hex.EncodeToString(got) != want {
		t.Errorf("envelope encoding\n got %s\nwant %s", hex.EncodeToString(got), want)
	}
	if err := CheckDeterministic(got); err != nil {
		t.Errorf("own output failed CheckDeterministic: %v", err)
	}
	var back envelopeV1
	if err := Unmarshal(got, &back); err != nil {
		t.Fatalf("Unmarshal: %v", err)
	}
	if back.Type != 2 || back.Body != "" || back.ThreadID != nil || len(back.Previews) != 0 {
		t.Errorf("round trip lost fields: %+v", back)
	}
}
