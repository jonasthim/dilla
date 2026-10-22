//go:build linux

package spotify

import (
	"io"
	"testing"
)

func TestAccessTokenStaysInUnnamedCredentialDescriptor(t *testing.T) {
	f, err := NewAccessTokenFile("BQD_abc-123")
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil || !info.Mode().IsRegular() || info.Size() == 0 {
		t.Fatalf("credential descriptor = %v, %v", info, err)
	}
	bytes, err := io.ReadAll(f)
	if err != nil {
		t.Fatal(err)
	}
	if string(bytes) != `{"access_token":"BQD_abc-123"}` {
		t.Fatalf("unexpected credential envelope shape")
	}
	if _, err := f.WriteAt([]byte("x"), 0); err == nil {
		t.Fatal("credential descriptor was not sealed")
	}
	if _, err := NewAccessTokenFile("line\nbreak"); err == nil {
		t.Fatal("control byte accepted")
	}
}
