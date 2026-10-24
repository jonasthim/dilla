package mlswasi

import (
	"strings"
	"testing"

	"github.com/fxamacker/cbor/v2"
)

func keyPackageResult(credential any) []cbor.RawMessage {
	encoded, err := cbor.Marshal([]any{
		uint64(0), make([]byte, 16), make([]byte, 16), uint64(1), uint64(3), make([]byte, 32), make([]byte, 32), credential,
	})
	if err != nil {
		panic(err)
	}
	var elems []cbor.RawMessage
	if err := cbor.Unmarshal(encoded, &elems); err != nil {
		panic(err)
	}
	return elems
}

func TestValidateKeyPackageABI8FixedByteFieldsHaveExactLengths(t *testing.T) {
	for _, tc := range []struct {
		name  string
		index int
		size  int
	}{
		{name: "device id short", index: 1, size: 15},
		{name: "user id long", index: 2, size: 17},
		{name: "key package ref short", index: 5, size: 31},
		{name: "signature key long", index: 6, size: 33},
	} {
		t.Run(tc.name, func(t *testing.T) {
			elems := keyPackageResult([]byte{1})
			elems[tc.index] = mustRaw(t, make([]byte, tc.size))
			if _, err := decodeKeyPackageInfo(elems); err == nil {
				t.Fatal("wrong-length fixed byte field was accepted")
			}
		})
	}

	elems := keyPackageResult([]byte{1})
	elems[6] = mustRaw(t, []any{uint64(1)})
	if _, err := decodeKeyPackageInfo(elems); err == nil {
		t.Fatal("integer array was coerced into signature-key bytes")
	}
}

func TestValidateKeyPackageABI8CredentialIsRequiredAndBounded(t *testing.T) {
	want := []byte{0x81, 0x01, 0x02}
	info, err := decodeKeyPackageInfo(keyPackageResult(want))
	if err != nil {
		t.Fatalf("decode valid ABI8 result: %v", err)
	}
	if string(info.Credential) != string(want) {
		t.Fatalf("Credential = %x, want exact leaf bytes %x", info.Credential, want)
	}

	if _, err := decodeKeyPackageInfo(keyPackageResult([]byte{})); err == nil || !strings.Contains(err.Error(), "1..8192") {
		t.Fatalf("empty credential error = %v, want bounded-byte error", err)
	}
	if _, err := decodeKeyPackageInfo(keyPackageResult(make([]byte, 8193))); err == nil || !strings.Contains(err.Error(), "1..8192") {
		t.Fatalf("oversized credential error = %v, want bounded-byte error", err)
	}

	old := keyPackageResult(want)[:7]
	if _, err := decodeKeyPackageInfo(old); err == nil || !strings.Contains(err.Error(), "want 8") {
		t.Fatalf("ABI7 tuple error = %v, want exact-length rejection", err)
	}
}

func TestValidateKeyPackageABI8CredentialRequiresStrictByteString(t *testing.T) {
	for name, raw := range map[string]cbor.RawMessage{
		"text":      mustRaw(t, "credential"),
		"truncated": {0x59, 0x00},
	} {
		t.Run(name, func(t *testing.T) {
			elems := keyPackageResult([]byte{1})
			elems[7] = raw
			if _, err := decodeKeyPackageInfo(elems); err == nil {
				t.Fatal("malformed credential was accepted")
			}
		})
	}
}

func mustRaw(t *testing.T, value any) cbor.RawMessage {
	t.Helper()
	raw, err := cbor.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return raw
}
