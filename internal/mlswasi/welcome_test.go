package mlswasi

import (
	"encoding/hex"
	"testing"

	"github.com/fxamacker/cbor/v2"
)

func TestDecodeWelcomeKeyPackageRefsAllowsMultipleRecipients(t *testing.T) {
	first := bytesOf(0x11, 32)
	second := bytesOf(0x22, 32)
	raw, err := cbor.Marshal([]any{uint64(0), [][]byte{first, second}})
	if err != nil {
		t.Fatal(err)
	}
	elems, err := responseElements(raw)
	if err != nil {
		t.Fatal(err)
	}
	refs, err := decodeWelcomeKeyPackageRefs(elems)
	if err != nil {
		t.Fatal(err)
	}
	if len(refs) != 2 || hex.EncodeToString(refs[0]) != hex.EncodeToString(first) || hex.EncodeToString(refs[1]) != hex.EncodeToString(second) {
		t.Fatalf("decoded refs = %x, want both exact 32-byte refs", refs)
	}
}

func TestDecodeWelcomeKeyPackageRefsRejectsMalformedResponse(t *testing.T) {
	for name, response := range map[string][]byte{
		"wrong response length": {0x81, 0x00},
		"wrong outer shape":     {0x82, 0x00, 0x01},
		"wrong ref length":      mustCBOR(t, []any{uint64(0), [][]byte{{1}}}),
	} {
		t.Run(name, func(t *testing.T) {
			elems, err := responseElements(response)
			if err != nil {
				if _, ok := err.(*ABIError); ok {
					t.Fatal(err)
				}
				return // malformed frame is already rejected at the response boundary
			}
			if _, err := decodeWelcomeKeyPackageRefs(elems); err == nil {
				t.Fatal("malformed recipient refs were accepted")
			}
		})
	}
}

func mustCBOR(t *testing.T, v any) []byte {
	t.Helper()
	b, err := cbor.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func bytesOf(b byte, n int) []byte {
	out := make([]byte, n)
	for i := range out {
		out[i] = b
	}
	return out
}
