package main

import (
	"io"
	"os"
	"regexp"
	"runtime"
	"strings"
	"testing"

	"github.com/jonasthim/dilla/internal/sfu"
)

// readRepoFile reads a file relative to the repository root. Tests run with the
// package directory as the working directory, so cmd/dillad is two levels down.
func readRepoFile(t *testing.T, rel string) string {
	t.Helper()
	b, err := os.ReadFile("../../" + rel)
	if err != nil {
		t.Fatalf("read %s: %v", rel, err)
	}
	return string(b)
}

// The three directives are copied verbatim from livekit-server v1.13.7's own
// go.mod (lines 167, 169, 171). Go ignores `replace` in dependencies, so
// without these `github.com/livekit/livekit-server/pkg/rtc` does not compile.
var livekitReplaces = []string{
	"replace github.com/pion/webrtc/v4 => github.com/livekit/webrtc-pion/v4 v4.2.18-warp.1",
	"replace github.com/pion/dtls/v3 => github.com/livekit/dtls/v3 v3.1.5-warp.1",
	"replace github.com/pion/ice/v4 => github.com/livekit/ice/v4 v4.4.0-warp.2",
}

func TestGoModCarriesTheLiveKitReplaceDirectives(t *testing.T) {
	gomod := readRepoFile(t, "go.mod")
	for _, want := range livekitReplaces {
		if !strings.Contains(gomod, want) {
			t.Errorf("go.mod is missing the verbatim line:\n\t%s", want)
		}
	}
}

func TestGoModPinsTheVerifiedVersions(t *testing.T) {
	gomod := readRepoFile(t, "go.mod")
	// The two LiveKit pseudo-versions are deviation B13: server-sdk-go v2.18.1 does
	// not compile once MVS lifts livekit/protocol to what livekit-server v1.13.7
	// requires (sipclient.go returns *emptypb.Empty where the lifted protocol
	// declares *livekit.TransferSIPParticipantResponse).
	pins := map[string]string{
		"github.com/fxamacker/cbor/v2":        "v2.9.4",
		"github.com/livekit/livekit-server":   "v1.13.7",
		"github.com/livekit/protocol":         "v1.51.1-0.20260910121219-271d9cde3897",
		"github.com/livekit/server-sdk-go/v2": "v2.18.2-0.20260922130803-2088dabd3442",
		"github.com/pion/turn/v5":             "v5.0.13",
		"github.com/tetratelabs/wazero":       "v1.12.0",
		"modernc.org/sqlite":                  "v1.59.0",
	}
	for module, version := range pins {
		// Matches both a direct require line and an `// indirect` one, but not a
		// different version of the same module.
		re := regexp.MustCompile(`(?m)^\s*` + regexp.QuoteMeta(module) + `\s+` + regexp.QuoteMeta(version) + `\b`)
		if !re.MatchString(gomod) {
			t.Errorf("go.mod does not pin %s at %s", module, version)
		}
	}
	if strings.Contains(gomod, "github.com/pion/turn/v5 v5.1") {
		t.Error("go.mod pins pion/turn v5.1.x; R18 and gap-21 require exactly v5.0.13")
	}
}

func TestGoModDeclaresGo1270(t *testing.T) {
	gomod := readRepoFile(t, "go.mod")
	if !regexp.MustCompile(`(?m)^go 1\.27\.0$`).MatchString(gomod) {
		t.Error("go.mod must declare `go 1.27.0` (R17)")
	}
}

func TestGitignoreKeepsTheWasiTestdataArtifact(t *testing.T) {
	ignore := readRepoFile(t, ".gitignore")
	if !strings.Contains(ignore, "!internal/mlswasi/testdata/*.wasm") {
		t.Error(".gitignore must re-include internal/mlswasi/testdata/*.wasm; the root ignores *.wasm")
	}
}

func TestVersionLineNamesTheBinaryAndThePlatform(t *testing.T) {
	got := versionLine()
	if !strings.HasPrefix(got, "dillad "+Version+" ") {
		t.Errorf("versionLine() = %q, want it to start with %q", got, "dillad "+Version+" ")
	}
	// Assert the pair this binary actually runs on. An "is there a slash in it"
	// check would be true of every possible output and would assert nothing.
	want := runtime.GOOS + "/" + runtime.GOARCH
	if !strings.Contains(got, want) {
		t.Errorf("versionLine() = %q, want it to name the platform %q", got, want)
	}
}

// Assert the flags parse, not how they are spelled in the source: a grep for
// `flag.Bool("sfu"` passes on a file where the flag is registered and never read,
// and fails on a correct refactor to a FlagSet.
func TestSFUFlagsParse(t *testing.T) {
	fs, opts := newFlagSet()
	secret := strings.Repeat("x", 32)
	if err := fs.Parse([]string{"-sfu", "-api-secret", secret}); err != nil {
		t.Fatalf("Parse: %v", err)
	}
	if !opts.runSFU {
		t.Error("-sfu did not set runSFU")
	}
	if opts.apiSecret != secret {
		t.Errorf("-api-secret = %q, want %q", opts.apiSecret, secret)
	}

	// The defaults are the ones an ordinary `dillad` run gets: no SFU, no secret.
	fs, opts = newFlagSet()
	if err := fs.Parse(nil); err != nil {
		t.Fatalf("Parse(nil): %v", err)
	}
	if opts.runSFU || opts.apiSecret != "" {
		t.Errorf("defaults are runSFU=%v apiSecret=%q, want false and empty", opts.runSFU, opts.apiSecret)
	}

	// An unknown flag is an error, not a silent ignore.
	fs, _ = newFlagSet()
	fs.SetOutput(io.Discard)
	if err := fs.Parse([]string{"-not-a-flag"}); err == nil {
		t.Error("an unknown flag was accepted")
	}
}

// The flag must reach the SFU: a secret shorter than 32 characters is what
// sfu.Config.YAML refuses, and dillad must surface that rather than boot.
func TestShortAPISecretIsRejectedBeforeTheSFUStarts(t *testing.T) {
	cfg := sfu.DefaultConfig()
	cfg.APISecret = "short"
	if _, err := cfg.YAML(); err == nil {
		t.Fatal("sfu.Config.YAML accepted a 5-character secret; dillad -sfu would then boot with it")
	}
}
