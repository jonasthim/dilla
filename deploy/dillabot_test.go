package deploy_test

import (
	"os/exec"
	"strings"
	"testing"
)

func TestBotUnitRunsBesideServerWithPrivateState(t *testing.T) {
	unit := read(t, "dillabot.service")
	for _, want := range []string{
		"After=network-online.target dilla.service",
		"Requires=dilla.service",
		"ExecStart=/usr/local/bin/dillabot --config=/etc/dillabot/bot.toml",
		"User=dillabot",
		"Group=dillabot",
		"StateDirectory=dillabot",
		"StateDirectoryMode=0700",
		"UMask=0077",
		"NoNewPrivileges=yes",
		"ProtectSystem=strict",
	} {
		if !strings.Contains(unit, want) {
			t.Errorf("bot unit is missing %q", want)
		}
	}
	if strings.Contains(unit, "AmbientCapabilities=") {
		t.Fatal("bot does not need privileged port capabilities")
	}
}

func TestBotUnitVerifies(t *testing.T) {
	if _, err := exec.LookPath("systemd-analyze"); err != nil {
		t.Skip("systemd-analyze is unavailable")
	}
	out, err := exec.CommandContext(t.Context(), "systemd-analyze", "verify", "dillabot.service").CombinedOutput()
	ignored := 0
	for _, line := range strings.Split(strings.TrimSpace(string(out)), "\n") {
		line = strings.TrimSpace(line)
		switch {
		case line == "":
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
