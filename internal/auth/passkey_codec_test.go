package auth

// The flag, transport and extension codecs, both directions.
//
// TestCredentialFlagsAndTransportsSurviveTheRoundTrip in passkey_test.go seeds a
// row and asserts what the READ path makes of it; nothing there ever ran
// flagBytes, joinTransports or marshalExtensions, which are what every real
// credential's stored columns are built from. A codec tested in one direction
// only is a codec whose two halves may disagree, and the pair that matters most
// is BackupEligible: validateLogin refuses a login whose BE flag differs from
// the stored one (webauthn@v0.18.2 webauthn/login.go:402-405), so a BE bit
// written at one position and read at another turns the "BE should NEVER
// change" invariant into an unconditional refusal — or, with UV, into a silent
// upgrade. dillad's packing is deliberately its own (UP=1<<0, UV=1<<1, BE=1<<2,
// BS=1<<3) and is NOT the library's single-byte form (CredentialFlags.MsgpByte
// returns the raw protocol.AuthenticatorFlags, where UV is 1<<2 and BE is
// 1<<3), so nothing outside this package would catch an inverted pair.

import (
	"encoding/json"
	"testing"

	"github.com/go-webauthn/webauthn/protocol"
	"github.com/go-webauthn/webauthn/webauthn"
)

// All sixteen combinations of the four flags survive flagBytes → flagsFromByte.
// Exhaustive rather than sampled: there are only sixteen, and a transposed pair
// is invisible to any test that sets both bits the same way.
func TestEveryCombinationOfCredentialFlagsSurvivesTheRoundTrip(t *testing.T) {
	for i := range 16 {
		want := webauthn.CredentialFlags{
			UserPresent:    i&(1<<0) != 0,
			UserVerified:   i&(1<<1) != 0,
			BackupEligible: i&(1<<2) != 0,
			BackupState:    i&(1<<3) != 0,
		}
		b := flagBytes(want)
		if len(b) != 1 {
			t.Fatalf("flagBytes(%+v) is %d bytes, want exactly 1", want, len(b))
		}
		if got := flagsFromByte(b); got != want {
			t.Fatalf("flagsFromByte(flagBytes(%+v)) = %+v", want, got)
		}
	}
	// Each flag owns a distinct bit: sixteen inputs must produce sixteen
	// distinct bytes, which a transposed or shared pair cannot.
	seen := map[byte]int{}
	for i := range 16 {
		f := webauthn.CredentialFlags{
			UserPresent:    i&(1<<0) != 0,
			UserVerified:   i&(1<<1) != 0,
			BackupEligible: i&(1<<2) != 0,
			BackupState:    i&(1<<3) != 0,
		}
		b := flagBytes(f)[0]
		if prev, ok := seen[b]; ok {
			t.Fatalf("flagBytes packs combination %d and %d into the same byte %#02x", prev, i, b)
		}
		seen[b] = i
	}
	// A row whose flags column is empty — no credential dillad wrote, but a
	// column an older row or another writer may leave NULL — reads as all-false
	// rather than panicking on b[0].
	if got := flagsFromByte(nil); got != (webauthn.CredentialFlags{}) {
		t.Fatalf("flagsFromByte(nil) = %+v, want the zero value", got)
	}
}

// joinTransports → splitTransports, including the empty list, which must come
// back nil rather than as one empty transport: a stored "" is "the
// authenticator reported none", and []AuthenticatorTransport{""} would be sent
// back to the client as a transport hint of the empty string.
func TestTransportsSurviveTheRoundTrip(t *testing.T) {
	for _, want := range [][]protocol.AuthenticatorTransport{
		nil,
		{protocol.Internal},
		{protocol.USB, protocol.NFC, protocol.BLE},
		{protocol.Hybrid, protocol.Internal, protocol.SmartCard},
	} {
		got := splitTransports(joinTransports(want))
		if len(got) != len(want) {
			t.Fatalf("splitTransports(joinTransports(%v)) = %v", want, got)
		}
		for i := range want {
			if got[i] != want[i] {
				t.Fatalf("splitTransports(joinTransports(%v)) = %v", want, got)
			}
		}
	}
}

// marshalExtensions writes "" for a credential whose authenticator reported
// nothing — the read path skips the decode entirely on "" — and a JSON object
// that decodes back to the same struct for one that reported something.
func TestCredentialExtensionsSurviveTheRoundTrip(t *testing.T) {
	if got, err := marshalExtensions(webauthn.CredentialExtensions{}); err != nil || got != "" {
		t.Fatalf("marshalExtensions(zero) = %q, %v; want \"\", nil", got, err)
	}
	rk := true
	want := webauthn.CredentialExtensions{RK: &rk}
	body, err := marshalExtensions(want)
	if err != nil {
		t.Fatalf("marshalExtensions: %v", err)
	}
	if body == "" {
		t.Fatal("marshalExtensions dropped a credProps result")
	}
	// The same decode credentials() performs on the stored column.
	var got webauthn.CredentialExtensions
	if err := json.Unmarshal([]byte(body), &got); err != nil {
		t.Fatalf("the stored extensions do not decode: %v (%q)", err, body)
	}
	if got.RK == nil || !*got.RK {
		t.Fatalf("RK did not survive the round trip: %q → %+v", body, got)
	}
}
