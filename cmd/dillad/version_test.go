package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// A build without a stamp is a development build: ci.yml's builds keep this.
func TestVersionDefaultsToDev(t *testing.T) {
	if Version != "0.0.0-dev" {
		t.Fatalf("Version = %q, want the unstamped 0.0.0-dev", Version)
	}
}

// release.yml stamps the tag (without its leading v) into the binary at link time:
// -ldflags "-X main.Version=<tag>". The linker sets only a package-level string
// variable, and silently ignores a constant, so this builds dillad the way the
// release does and runs its version verb.
func TestVersionIsStampedAtLink(t *testing.T) {
	if testing.Short() {
		t.Skip("builds dillad")
	}
	goBin, err := exec.LookPath("go")
	if err != nil {
		t.Fatalf("this test builds dillad and needs go on PATH: %v", err)
	}
	bin := filepath.Join(t.TempDir(), "dillad")
	build := exec.CommandContext(t.Context(), goBin, "build", "-trimpath",
		"-ldflags", "-s -w -X main.Version=9.8.7-stamp.1", "-o", bin, ".")
	build.Env = append(os.Environ(), "CGO_ENABLED=0")
	if out, err := build.CombinedOutput(); err != nil {
		t.Fatalf("go build: %v\n%s", err, out)
	}
	out, err := exec.CommandContext(t.Context(), bin, "version").Output()
	if err != nil {
		t.Fatalf("dillad version: %v", err)
	}
	if !strings.HasPrefix(string(out), "dillad 9.8.7-stamp.1 (") {
		t.Fatalf("dillad version printed %q, want it to start with %q", out, "dillad 9.8.7-stamp.1 (")
	}
}
