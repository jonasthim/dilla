package main

import (
	"strings"
	"testing"
)

// UP5: -sfu-sidecar points the host at an SFU another process owns. It needs the secret file that
// process reads and the webhook address that process was told, and it is not -sfu.
func TestTheSidecarFlagsReachTheHostOptions(t *testing.T) {
	o, err := parseFlags([]string{"-sfu-sidecar", "-sfu-port", "7990", "-sfu-udp-port", "7992",
		"-sfu-secret-file", "/media/secret", "-sfu-webhook-listen", "127.0.0.1:7993", "-state-dir", "/state"})
	if err != nil {
		t.Fatalf("parseFlags: %v", err)
	}
	ho := o.hostOptions("/data", "/core.wasm", "")
	if !ho.SFUSidecar || ho.SFU || ho.SFUPort != 7990 || ho.SFUUDPPort != 7992 ||
		ho.SFUSecretFile != "/media/secret" || ho.SFUWebhookListen != "127.0.0.1:7993" || ho.StateDir != "/state" {
		t.Fatalf("host options %+v", ho)
	}
}

func TestTheSidecarModeNeedsItsSecretAndWebhookAndExcludesTheInProcessSFU(t *testing.T) {
	for name, args := range map[string][]string{
		"no secret file":  {"-sfu-sidecar", "-sfu-webhook-listen", "127.0.0.1:7993"},
		"no webhook":      {"-sfu-sidecar", "-sfu-secret-file", "/s"},
		"both SFU modes":  {"-sfu", "-sfu-sidecar", "-sfu-secret-file", "/s", "-sfu-webhook-listen", "127.0.0.1:7993"},
		"secret w/o mode": {"-sfu-secret-file", "/s"},
	} {
		if _, err := parseFlags(args); err == nil || !strings.Contains(err.Error(), "-sfu") {
			t.Errorf("%s: parseFlags = %v, want an error naming the -sfu flags", name, err)
		}
	}
	// Control: the in-process default is untouched.
	o, err := parseFlags([]string{"-sfu"})
	if err != nil {
		t.Fatalf("control: %v", err)
	}
	if ho := o.hostOptions("/data", "/core.wasm", ""); !ho.SFU || ho.SFUSidecar {
		t.Fatalf("control: %+v", ho)
	}
}

// Without -state-dir the host keeps its state in the data directory, never in a fixed path.
func TestTheStateDirFollowsTheDataDirByDefault(t *testing.T) {
	o, err := parseFlags(nil)
	if err != nil {
		t.Fatal(err)
	}
	if ho := o.hostOptions("/data", "/core.wasm", ""); ho.StateDir != "" {
		t.Fatalf("StateDir = %q, want empty (the host then uses its data dir)", ho.StateDir)
	}
}
