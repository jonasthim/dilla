package main

import (
	"errors"
	"io"
	"os"
	"os/exec"
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

// Ruling K. Deviation B16 is that the wasi artifact is never committed: CI
// downloads it from the rust-wasi job and a developer builds it locally. The
// root `.gitignore` ignores `*.wasm`, and a negation used to re-include this one
// path — which bought nothing (nobody needs the file tracked) and made a stray
// `git add .` able to commit a 2 MB build product. The negation is gone, so what
// has to hold is the opposite of the old assertion.
//
// `git check-ignore` is the authority, not a grep for a line: it applies the
// whole ignore stack in order, so it also catches a future rule elsewhere that
// un-ignores the path again.
func TestTheWasiTestdataArtifactIsIgnored(t *testing.T) {
	cmd := exec.Command("git", "check-ignore", "-q", "internal/mlswasi/testdata/dilla_core_wasi.wasm")
	cmd.Dir = "../.."
	err := cmd.Run()
	if err == nil {
		return // exit 0: the path is ignored, which is the whole requirement
	}
	var exit *exec.ExitError
	if errors.As(err, &exit) && exit.ExitCode() == 1 {
		t.Error("internal/mlswasi/testdata/dilla_core_wasi.wasm is not ignored by .gitignore; " +
			"deviation B16 says the artifact is never committed, so `git add .` must not be able to stage it")
		return
	}
	// Exit 128 or a missing binary: there is no repository to ask (a source
	// tarball, say). That is not the failure this test exists to catch.
	t.Skipf("git check-ignore could not run: %v", err)
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

// A job-level `env:` member sits at six spaces (`    env:` then the key); a
// step-level one at ten (`        env:` then the key). Only the first applies to
// every step of the job, so only the first can disarm `go test -race`.
var jobLevelCGOEnabled = regexp.MustCompile(`(?m)^ {6}CGO_ENABLED: `)

func TestCIWorkflowHasTheGoJob(t *testing.T) {
	wf := readRepoFile(t, ".github/workflows/ci.yml")

	// Slice the job out first: every assertion below is about the `go` job, and
	// some of these strings appear elsewhere in the file. `name: dilla-core-wasi`
	// is rust-wasi's upload name too, so checking it against the whole workflow
	// would pass on a `go` job that downloads nothing at all. Fail cleanly if
	// the job is absent: slicing at a -1 index panics with "slice bounds out of
	// range".
	idx := strings.Index(wf, "\n  go:\n")
	if idx < 0 {
		t.Fatal("ci.yml has no `go:` job, so its steps cannot be checked")
	}
	goJob := wf[idx:]
	if end := strings.Index(goJob[1:], "\n  go-fts5-arm64:"); end >= 0 {
		goJob = goJob[:end+1] // end is relative to goJob[1:]
	}

	for _, want := range []string{
		// Without this the artifact does not exist yet: GitHub starts jobs with
		// no `needs:` immediately and in parallel, and download-artifact only
		// sees artifacts already uploaded in the same run (gap-31 §3.2's
		// reference job carries it).
		"needs: [rust-wasi]",
		"uses: actions/setup-go@v7",
		"go-version-file: go.mod",
		"cache-dependency-path: go.sum",
		"uses: actions/download-artifact@v8",
		"name: dilla-core-wasi",
		"path: internal/mlswasi/testdata",
		"run: go mod verify",
		"run: go vet ./...",
		// Ruling M: `internal/deps` sits behind the `dillapins` tag so no
		// ordinary build drags the LiveKit SFU in, which also means this is the
		// only place in CI where the pinned module graph — the three pion
		// `replace` directives included — is compiled at all.
		"CGO_ENABLED=0 go build -tags dillapins ./internal/deps",
		"go test -race -shuffle=on -timeout 15m ./...",
		"GORACE: halt_on_error=1",
		"CGO_ENABLED=0 go build -trimpath -ldflags='-s -w' ./cmd/dillad",
	} {
		if !strings.Contains(goJob, want) {
			t.Errorf("the go job in ci.yml is missing %q", want)
		}
	}

	// A `needs:` naming a job that does not exist is a workflow-validation
	// error, so the job it points at has to be in the same file.
	if !strings.Contains(wf, "\n  rust-wasi:\n") {
		t.Error("the go job needs rust-wasi, but ci.yml declares no rust-wasi job; " +
			"land Plan A's CI task first (it owns that job and uploads the dilla-core-wasi artifact)")
	}

	// The race detector needs cgo and a C toolchain, so CGO_ENABLED=0 must
	// never be set job-wide. On a single build step it is not only harmless but
	// required — that is how the static release build and the dillapins build
	// are spelled — so the rule is the scope, not the string.
	if jobLevelCGOEnabled.MatchString(goJob) {
		t.Error("the go job sets CGO_ENABLED at job level; go test -race needs cgo, " +
			"so it may only be set on a build step")
	}
}

func TestCIWorkflowRunsFTS5OnArm64(t *testing.T) {
	wf := readRepoFile(t, ".github/workflows/ci.yml")
	for _, want := range []string{
		"\n  go-fts5-arm64:\n",
		"runs-on: ubuntu-24.04-arm",
		"go test ./internal/store/sqlite/...",
	} {
		if !strings.Contains(wf, want) {
			t.Errorf("ci.yml is missing %q", want)
		}
	}
}

// R22: no step may swallow a failure. The rule is "no `|| true`, no
// `continue-on-error`, no `if: always()` **on a gate**" — `if: always()` on an
// artifact or coverage upload after a failing step is normal and correct, and
// Plan A owns six more jobs in this file, so banning the string outright would
// turn this test red the first time someone adds such an upload.
func TestCIWorkflowIsFailClosed(t *testing.T) {
	wf := readRepoFile(t, ".github/workflows/ci.yml")
	for _, forbidden := range []string{"|| true", "continue-on-error"} {
		if strings.Contains(wf, forbidden) {
			t.Errorf("ci.yml contains %q; CI is fail-closed (R22)", forbidden)
		}
	}

	// `if: always()` is only a problem on a step that runs a gate command. Walk
	// the steps and flag the combination, not the string.
	gateCommands := []string{"go test", "go vet", "go mod verify", "cargo ", "npm test",
		"npm run", "git diff --exit-code", "git status --porcelain"}
	for _, step := range strings.Split(wf, "\n      - ") {
		if !strings.Contains(step, "if: always()") {
			continue
		}
		for _, gate := range gateCommands {
			if strings.Contains(step, gate) {
				t.Errorf("a step carrying `if: always()` runs the gate command %q; a gate must "+
					"not run unconditionally (R22). Step:\n%s", gate, step)
				break
			}
		}
	}
}
