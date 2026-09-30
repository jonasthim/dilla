package deploy_test

import (
	"os"
	"os/exec"
	"strings"
	"testing"
)

func TestTheUnitVerifies(t *testing.T) {
	if _, err := exec.LookPath("systemd-analyze"); err != nil {
		t.Skip("systemd-analyze is not installed on this box: skipping the unit verification")
	}
	// "dilla.service", not "deploy/dilla.service": go test runs a package with its
	// working directory set to the package directory, which is deploy/ — the same
	// reason read(t, "dilla.service") and read(t, "../Dockerfile") below are
	// spelled the way they are.
	// systemd-analyze exits non-zero for the two expected warnings too (systemd
	// 262 does for a missing ExecStart binary), so the exit status alone is not
	// the verdict: the output lines are.
	out, err := exec.CommandContext(t.Context(), "systemd-analyze", "verify", "dilla.service").CombinedOutput()
	// Two warning classes are expected on any box that is not the deployment
	// target and are ignored by name: the ExecStart binary is not installed, and
	// the dillad user does not exist. Anything else fails the test, so a real
	// directive error is still caught.
	ignored := 0
	for _, line := range strings.Split(strings.TrimSpace(string(out)), "\n") {
		line = strings.TrimSpace(line)
		switch {
		case line == "":
			continue
		case strings.Contains(line, "is not executable"),
			strings.Contains(line, "Failed to resolve user"),
			strings.Contains(line, "Failed to resolve group"):
			ignored++
		default:
			t.Errorf("systemd-analyze verify: %s", line)
		}
	}
	if err != nil && ignored == 0 {
		t.Fatalf("systemd-analyze verify: %v\n%s", err, out)
	}
}

func TestTheUnitCarriesTheRequiredDirectives(t *testing.T) {
	unit := read(t, "dilla.service")
	for _, want := range []string{
		"Type=notify",
		"NotifyAccess=main",
		"StateDirectory=dillad",
		"StateDirectoryMode=0700",
		"UMask=0077",
		"RestartPreventExitStatus=78",
		"AmbientCapabilities=CAP_NET_BIND_SERVICE",
		"CapabilityBoundingSet=CAP_NET_BIND_SERVICE",
		"NoNewPrivileges=yes",
		"ProtectSystem=strict",
		"RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX",
		"TimeoutStartSec=300s",
	} {
		if !strings.Contains(unit, want) {
			t.Errorf("the unit is missing %q", want)
		}
	}
}

// The absence is the assertion, and the reason is in the unit file beside it.
func TestTheUnitDoesNotSetMemoryDenyWriteExecute(t *testing.T) {
	unit := read(t, "dilla.service")
	for _, line := range strings.Split(unit, "\n") {
		trimmed := strings.TrimSpace(line)
		if strings.HasPrefix(trimmed, "MemoryDenyWriteExecute=") {
			t.Fatalf("MemoryDenyWriteExecute is set (%q); wazero's compiler back end writes and then executes generated machine code, so the wasi path would fail at runtime, not at start", trimmed)
		}
	}
	if !strings.Contains(unit, "wazero") {
		t.Fatal("the unit must carry a comment naming wazero as the reason MemoryDenyWriteExecute is absent")
	}
}

func TestTheImageIsDistrolessDebian13PinnedByDigest(t *testing.T) {
	df := read(t, "../Dockerfile")
	if !strings.Contains(df, "gcr.io/distroless/static-debian13:nonroot@sha256:") {
		t.Fatal("the runtime base must be static-debian13:nonroot pinned by digest; the unsuffixed tag will move to a newer Debian")
	}
	if strings.Contains(df, "static-debian12") || strings.Contains(df, "distroless/static:nonroot") {
		t.Fatal("do not use static-debian12 or the unsuffixed tag")
	}
	if !strings.Contains(df, "FROM --platform=$BUILDPLATFORM") {
		t.Fatal("the builder stage must be pinned to $BUILDPLATFORM so nothing runs under QEMU")
	}
	if !strings.Contains(df, "CGO_ENABLED=0") {
		t.Fatal("the build must be cgo-free")
	}
	if !strings.Contains(df, "USER 65532:65532") {
		t.Fatal("the image must run as the nonroot UID explicitly; the base config records only User: 65532")
	}
	if !strings.Contains(df, "EXPOSE 443/tcp 7882/udp") {
		t.Fatal("the container publishes exactly 443/tcp and 7882/udp")
	}
	for _, forbidden := range []string{"setup-qemu", "apt-get", "RUN chown"} {
		if strings.Contains(df, forbidden) {
			t.Fatalf("the Dockerfile contains %q", forbidden)
		}
	}
}

func TestTheWorkflowBuildsMultiArchWithoutQEMU(t *testing.T) {
	wf := read(t, "../.github/workflows/ci.yml")
	for _, want := range []string{
		"docker/build-push-action@v7",
		"docker/setup-buildx-action@v4",
		// The repository's house style, on every job of the existing workflow.
		"actions/checkout@v7",
		"platforms: linux/amd64,linux/arm64",
		"if-no-files-found: error",
	} {
		if !strings.Contains(wf, want) {
			t.Errorf("the workflow is missing %q", want)
		}
	}
	if strings.Contains(wf, "setup-qemu-action") {
		t.Fatal("setup-qemu-action is not needed: the Dockerfile cross-compiles with GOOS/GOARCH")
	}
	for _, forbidden := range []string{"|| true", "continue-on-error", "if: always()"} {
		if strings.Contains(wf, forbidden) {
			t.Fatalf("the workflow is not fail-closed: it contains %q", forbidden)
		}
	}
}

func TestComposeDocumentsTheHostNetworkingTrap(t *testing.T) {
	c := read(t, "compose.yaml")
	if !strings.Contains(c, "net.ipv4.ip_unprivileged_port_start") {
		t.Fatal("compose.yaml must document the sysctl host networking needs; Docker sets it only for private networks, so a host-networked container as UID 65532 cannot bind 443")
	}
	if !strings.Contains(c, "65532:65532") {
		t.Fatal("compose.yaml must state that the bind-mounted data directory is owned 65532:65532 on the host; distroless has no shell, so nothing can chown it at start")
	}
}

func read(t *testing.T, path string) string {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	return string(b)
}

func TestComposeConfigResolves(t *testing.T) {
	docker, err := exec.LookPath("docker")
	if err != nil {
		t.Skip("docker is not installed on this box: skipping the compose validation")
	}
	out, err := exec.CommandContext(t.Context(), docker, "compose", "-f", "compose.yaml", "config").CombinedOutput()
	if err != nil {
		t.Fatalf("docker compose config: %v\n%s", err, out)
	}
	// The resolved document must still carry the two things the file exists to
	// get right, after Compose has expanded it.
	for _, want := range []string{"7882", "/var/lib/dilla"} {
		if !strings.Contains(string(out), want) {
			t.Errorf("the resolved compose document does not mention %q", want)
		}
	}
}
