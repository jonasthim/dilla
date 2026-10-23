package deploy_test

import (
	"os"
	"os/exec"
	"slices"
	"strings"
	"testing"
)

func TestTheUnitVerifies(t *testing.T) {
	// "dilla.service", not "deploy/dilla.service": go test runs a package with its
	// working directory set to the package directory, which is deploy/ — the same
	// reason read(t, "dilla.service") below is
	// spelled the way it is.
	verifyUnit(t, "dilla.service")
}

// The media unit and the refresh timer's two units (R-UP4, R-UP5) pass the same check.
func TestTheMediaAndRefreshUnitsVerify(t *testing.T) {
	for _, unit := range []string{"dilla-media.service", "dilla-media-refresh.service", "dilla-media-refresh.timer"} {
		t.Run(unit, func(t *testing.T) { verifyUnit(t, unit) })
	}
}

func verifyUnit(t *testing.T, unit string) {
	t.Helper()
	if _, err := exec.LookPath("systemd-analyze"); err != nil {
		t.Skip("systemd-analyze is not installed on this box: skipping the unit verification")
	}
	// systemd-analyze exits non-zero for the two expected warnings too (systemd
	// 262 does for a missing ExecStart binary), so the exit status alone is not
	// the verdict: the output lines are.
	out, err := exec.CommandContext(t.Context(), "systemd-analyze", "verify", "./"+unit).CombinedOutput()
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
			strings.Contains(line, "Failed to resolve group"),
			// The timer names its service, which verify looks for in the unit path, not here.
			strings.Contains(line, "dilla-media-refresh.service") && strings.Contains(line, "not found"):
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

// directives returns the unit's non-comment lines, trimmed.
func directives(t *testing.T, path string) []string {
	t.Helper()
	var out []string
	for _, line := range strings.Split(read(t, path), "\n") {
		line = strings.TrimSpace(line)
		if line != "" && !strings.HasPrefix(line, "#") {
			out = append(out, line)
		}
	}
	return out
}

// R-UP5: the media unit says when the SFU is ready and is no part of dilla.service, so restarting the
// API never restarts the SFU (one SFU restart per upgrade, and only when needed, R-UP10).
func TestTheMediaUnitIsNotifyAndNotPartOfTheAPI(t *testing.T) {
	got := directives(t, "dilla-media.service")
	for _, want := range []string{
		"Type=notify",
		"NotifyAccess=main",
		"TimeoutStartSec=60s",
		"ExecStart=/usr/local/bin/dillad media --config=%E/dilla/dilla.toml",
		// serve and media exit 69 (exit.Unavailable) when they cannot come up yet; systemd retries
		// that, and only exit.Config (78) stops the loop.
		"Restart=on-failure",
		"RestartPreventExitStatus=78",
		"StateDirectory=dillad",
		"User=dillad",
		"NoNewPrivileges=yes",
		// The media server executes nothing but dillad itself.
		"NoExecPaths=/",
		"ExecPaths=/usr/local/bin",
		"WantedBy=multi-user.target",
	} {
		if !slices.Contains(got, want) {
			t.Errorf("dilla-media.service is missing %q", want)
		}
	}
	for _, line := range got {
		for _, banned := range []string{"PartOf=", "BindsTo=", "Requires=dilla.service", "AmbientCapabilities="} {
			if strings.HasPrefix(line, banned) {
				t.Errorf("dilla-media.service sets %q; the shipped unit must not (R-UP5; install.sh adds the capability only for a turn.listen below 1024)", line)
			}
		}
	}
}

// R-UP5: dilla.service keeps its start order on dilla-media and retries exit 69, which serve uses when
// dilla-media serves TURN and api.sock cannot be bound.
func TestTheAPIUnitStartsAfterTheMediaUnitAndRetries69(t *testing.T) {
	got := directives(t, "dilla.service")
	for _, want := range []string{
		"After=network-online.target dilla-media.service",
		"Wants=network-online.target dilla-media.service",
		"Restart=on-failure",
		"RestartPreventExitStatus=78",
	} {
		if !slices.Contains(got, want) {
			t.Errorf("dilla.service is missing %q", want)
		}
	}
}

// R-UP4: a root oneshot every minute, whose logic is a script (no shell quoting in the unit).
func TestTheRefreshTimerRunsTheScriptEveryMinute(t *testing.T) {
	svc := directives(t, "dilla-media-refresh.service")
	for _, want := range []string{"Type=oneshot", "ExecStart=/usr/local/libexec/dilla-media-refresh"} {
		if !slices.Contains(svc, want) {
			t.Errorf("dilla-media-refresh.service is missing %q", want)
		}
	}
	for _, line := range svc {
		if strings.HasPrefix(line, "User=") || strings.Contains(line, "sh -c") {
			t.Errorf("dilla-media-refresh.service sets %q; it runs the script as root, unquoted", line)
		}
	}
	timer := directives(t, "dilla-media-refresh.timer")
	for _, want := range []string{"OnUnitActiveSec=1min", "OnBootSec=1min", "WantedBy=timers.target"} {
		if !slices.Contains(timer, want) {
			t.Errorf("dilla-media-refresh.timer is missing %q", want)
		}
	}
}

// UP3 fix round 1: install.sh and the refresh script run as root, and a dillad process can execve
// a binary of its own and keep its pid. So nothing reached through /proc is ever executed: its
// executable is only hashed (sha256_of) or stat'ed, and the running SFU is asked over media.sock.
func TestNothingReachedThroughProcIsExecuted(t *testing.T) {
	for _, file := range []string{"install.sh", "dilla-media-refresh.sh"} {
		for n, line := range strings.Split(read(t, file), "\n") {
			code := strings.TrimSpace(line)
			if strings.HasPrefix(code, "#") || !strings.Contains(code, "/exe") {
				continue
			}
			// SFU_FROM only names where an answer came from, for the log.
			if !strings.Contains(code, "sha256_of") && !strings.Contains(code, "stat -L") && !strings.HasPrefix(code, "SFU_FROM=") {
				t.Errorf("%s:%d touches /proc/<pid>/exe other than by hashing or stat: %s", file, n+1, code)
			}
		}
	}
}

// The web3.11 binaries a running pre-web3.12 SFU is recognised by, pinned from the v0.1.0-web3.11
// release's SHA256SUMS.
func TestInstallShPinsTheWeb311Binaries(t *testing.T) {
	install := read(t, "install.sh")
	for _, want := range []string{
		"f13cf8c804d050afd295b178f8ef2a4c87ef1387a6782ba422652fe21a5af8c1 0.1.0-web3.11 1 dillad-linux-amd64",
		"58e67dbf56bb5df012bf3cd967a5c11ee4631c41a7dc919ffc67120af4afdeee 0.1.0-web3.11 1 dillad-linux-arm64",
	} {
		if !strings.Contains(install, "\n"+want+"\n") {
			t.Errorf("install.sh's KNOWN_SFU_BINARIES lacks %q", want)
		}
	}
}

// install.sh is the one file an operator downloads, so it carries the units and the refresh script
// itself. Its copies must be the files in deploy/, byte for byte.
func TestInstallShEmbedsTheDeployFilesVerbatim(t *testing.T) {
	install := read(t, "install.sh")
	for _, c := range []struct{ file, opener, closer string }{
		{"dilla.service", "cat >\"$WORK/dilla.service\" <<'UNIT'\n", "\nUNIT\n"},
		{"dilla-media.service", "cat >\"$WORK/dilla-media.service\" <<'UNIT'\n", "\nUNIT\n"},
		{"dilla-media-refresh.service", "cat >\"$WORK/dilla-media-refresh.service\" <<'UNIT'\n", "\nUNIT\n"},
		{"dilla-media-refresh.timer", "cat >\"$WORK/dilla-media-refresh.timer\" <<'UNIT'\n", "\nUNIT\n"},
		{"dilla-media-refresh.sh", "cat >\"$WORK/dilla-media-refresh\" <<'SCRIPT'\n", "\nSCRIPT\n"},
	} {
		_, rest, ok := strings.Cut(install, c.opener)
		if !ok {
			t.Errorf("install.sh has no heredoc for %s", c.file)
			continue
		}
		body, _, ok := strings.Cut(rest, c.closer)
		if !ok {
			t.Errorf("install.sh's heredoc for %s is not closed", c.file)
			continue
		}
		if want := strings.TrimSuffix(read(t, c.file), "\n"); body != want {
			t.Errorf("install.sh's copy of %s differs from deploy/%s", c.file, c.file)
		}
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
