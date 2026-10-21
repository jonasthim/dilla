package main

import (
	"bytes"
	"encoding/json"
	"flag"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/jonasthim/dilla/internal/sfu"
)

var updateVersionGolden = flag.Bool("update-version-golden", false, "rewrite testdata/version-json.golden")

// release.yml stamps the tag (without its leading v) into dillad at link time:
// -ldflags "-X main.Version=<version>". The linker sets only a package-level
// string variable and silently ignores a constant, so this builds dillad the way
// the release does and runs its version verb. Every other build, ci.yml's
// included, is a development build and says 0.0.0-dev.
func TestVersionIsStampedAtLink(t *testing.T) {
	if testing.Short() {
		t.Skip("builds dillad")
	}
	goBin, err := exec.LookPath("go")
	if err != nil {
		t.Fatalf("this test builds dillad and needs go on PATH: %v", err)
	}
	for _, tc := range []struct {
		name, ldflags, want string
	}{
		{"plain build", "", "dillad 0.0.0-dev "},
		{"release build", "-s -w -X main.Version=0.1.0-web3.1", "dillad 0.1.0-web3.1 "},
	} {
		t.Run(tc.name, func(t *testing.T) {
			bin := filepath.Join(t.TempDir(), "dillad")
			args := []string{"build", "-trimpath"}
			if tc.ldflags != "" {
				args = append(args, "-ldflags", tc.ldflags)
			}
			build := exec.CommandContext(t.Context(), goBin, append(args, "-o", bin, ".")...)
			build.Env = append(os.Environ(), "CGO_ENABLED=0")
			if out, err := build.CombinedOutput(); err != nil {
				t.Fatalf("go build: %v\n%s", err, out)
			}
			out, err := exec.CommandContext(t.Context(), bin, "version").Output()
			if err != nil {
				t.Fatalf("dillad version: %v", err)
			}
			if !strings.HasPrefix(string(out), tc.want) {
				t.Fatalf("dillad version printed %q, want it to start with %q", out, tc.want)
			}
		})
	}
}

// `version --json` is what release.yml turns into release.json and what the installer asks a
// binary: its shape is pinned byte for byte, so a new migration or a level bump shows here.
func TestVersionJSONMatchesItsGolden(t *testing.T) {
	out, _, err := run(t, "version", "--json")
	if err != nil {
		t.Fatalf("version --json: %v", err)
	}
	if strings.Count(out, "\n") != 1 || !strings.HasSuffix(out, "\n") {
		t.Fatalf("version --json must print exactly one line, got %q", out)
	}
	var got versionInfo
	if err := json.Unmarshal([]byte(out), &got); err != nil {
		t.Fatalf("version --json is not JSON: %v\n%s", err, out)
	}
	if got.MediaLevel != sfu.MediaLevel || got.MinSFUMediaLevel != sfu.MinSFUMediaLevel {
		t.Fatalf("levels = %d/%d, want %d/%d", got.MediaLevel, got.MinSFUMediaLevel, sfu.MediaLevel, sfu.MinSFUMediaLevel)
	}
	got.Revision = "REVISION" // the one field that depends on how the test binary was built
	norm, err := json.Marshal(got)
	if err != nil {
		t.Fatal(err)
	}
	norm = append(norm, '\n')
	const golden = "testdata/version-json.golden"
	if *updateVersionGolden {
		if err := os.WriteFile(golden, norm, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	want, err := os.ReadFile(golden)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(want, norm) {
		t.Fatalf("version --json drifted from %s (-update-version-golden rewrites it):\n got %s\nwant %s", golden, norm, want)
	}
}

func TestVersionJSONKeysAreTheReleaseMetadataKeys(t *testing.T) {
	out, _, err := run(t, "version", "--json")
	if err != nil {
		t.Fatal(err)
	}
	var raw map[string]json.RawMessage
	if err := json.Unmarshal([]byte(out), &raw); err != nil {
		t.Fatal(err)
	}
	for _, k := range []string{"version", "revision", "wire", "schema", "media_level", "min_sfu_media_level", "media_capabilities"} {
		if _, ok := raw[k]; !ok {
			t.Errorf("version --json lacks %q: %s", k, out)
		}
	}
	if string(raw["wire"]) != "[2]" {
		t.Errorf("wire = %s, want [2]", raw["wire"])
	}
	if len(raw) != 7 {
		t.Errorf("version --json has %d keys, want 7: %s", len(raw), out)
	}
}

func TestPlainVersionIsUnchangedByTheJSONFlag(t *testing.T) {
	out, _, err := run(t, "version")
	if err != nil || !strings.HasPrefix(out, "dillad ") {
		t.Fatalf("version = %q, %v", out, err)
	}
}
