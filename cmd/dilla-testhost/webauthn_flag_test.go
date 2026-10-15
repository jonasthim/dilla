package main

import "testing"

func TestTheWebAuthnOriginFlagReachesTheHostOptions(t *testing.T) {
	o, err := parseFlags([]string{"-webauthn-origin", "http://localhost:9999"})
	if err != nil {
		t.Fatalf("parseFlags: %v", err)
	}
	if ho := o.hostOptions("/data", "/core.wasm", ""); ho.WebAuthnOrigin != "http://localhost:9999" {
		t.Fatalf("WebAuthnOrigin = %q", ho.WebAuthnOrigin)
	}
	// Control: the flag left empty keeps the instance domain's own relying party.
	o, err = parseFlags(nil)
	if err != nil {
		t.Fatalf("parseFlags: %v", err)
	}
	if ho := o.hostOptions("/data", "/core.wasm", ""); ho.WebAuthnOrigin != "" {
		t.Fatalf("WebAuthnOrigin = %q, want empty", ho.WebAuthnOrigin)
	}
}
