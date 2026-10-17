package main

import (
	"slices"
	"testing"
)

// web3.8 S1: -wire is the one wire version the host's hello offers and GET /v1/instance
// advertises. Its default is 2, the version dillad offers; E2's version-reload spec passes another.
func TestTheWireFlagReachesTheHostOptions(t *testing.T) {
	o, err := parseFlags([]string{"-wire", "3"})
	if err != nil {
		t.Fatalf("parseFlags: %v", err)
	}
	if ho := o.hostOptions("/data", "/core.wasm", ""); !slices.Equal(ho.WireVersions, []uint64{3}) {
		t.Fatalf("WireVersions = %v, want [3]", ho.WireVersions)
	}
	// Control: the flag left out is 2.
	o, err = parseFlags(nil)
	if err != nil {
		t.Fatalf("parseFlags: %v", err)
	}
	if ho := o.hostOptions("/data", "/core.wasm", ""); !slices.Equal(ho.WireVersions, []uint64{2}) {
		t.Fatalf("WireVersions = %v, want [2]", ho.WireVersions)
	}
}
