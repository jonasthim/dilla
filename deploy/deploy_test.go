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
	// reason read(t, "dilla.service") below is
	// spelled the way it is.
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
		// AF_NETLINK (C8, fix wave): net.Interfaces, LiveKit's SFU setup and pion's stdnet read the
		// interface list over netlink; without it serve cannot start with the default config.
		"RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX AF_NETLINK",
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

func read(t *testing.T, path string) string {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	return string(b)
}
