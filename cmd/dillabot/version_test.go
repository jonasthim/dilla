//go:build linux

package main

import (
	"bytes"
	"testing"
)

func TestVersionCommand(t *testing.T) {
	old := Version
	Version = "1.2.3-test.1"
	t.Cleanup(func() { Version = old })

	var out bytes.Buffer
	if !runVersionCommand([]string{"version"}, &out) {
		t.Fatal("version command was not handled")
	}
	if got, want := out.String(), "dillabot 1.2.3-test.1\n"; got != want {
		t.Fatalf("version output = %q, want %q", got, want)
	}
	if runVersionCommand([]string{"version", "extra"}, &out) {
		t.Fatal("version command accepted extra arguments")
	}
}
