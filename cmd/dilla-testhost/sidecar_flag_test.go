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

// UP9: -turn-listen and -turn-secret-file name the sidecar's relay; they go together, and only
// with -sfu-sidecar (the relay runs in the media process). -hold-public reaches the options.
func TestTheRelayAndHoldFlagsReachTheOptions(t *testing.T) {
	sidecar := []string{"-sfu-sidecar", "-sfu-secret-file", "/s", "-sfu-webhook-listen", "127.0.0.1:7993"}
	o, err := parseFlags(append(append([]string{}, sidecar...), "-turn-listen", "127.0.0.1:8568", "-turn-secret-file", "/t", "-hold-public"))
	if err != nil {
		t.Fatalf("parseFlags: %v", err)
	}
	if !o.holdPublic {
		t.Fatal("-hold-public did not reach the options")
	}
	if ho := o.hostOptions("/data", "/core.wasm", ""); ho.TURNListen != "127.0.0.1:8568" || ho.TURNSecretFile != "/t" {
		t.Fatalf("host options %+v", ho)
	}
	for name, args := range map[string][]string{
		"no sidecar": {"-turn-listen", "127.0.0.1:8568", "-turn-secret-file", "/t"},
		"no secret":  append(append([]string{}, sidecar...), "-turn-listen", "127.0.0.1:8568"),
		"no listen":  append(append([]string{}, sidecar...), "-turn-secret-file", "/t"),
	} {
		if _, err := parseFlags(args); err == nil || !strings.Contains(err.Error(), "-turn-") {
			t.Errorf("%s: parseFlags = %v, want an error naming the -turn- flags", name, err)
		}
	}
	// Control: without them, no relay and an open listener.
	o, err = parseFlags(sidecar)
	if err != nil {
		t.Fatal(err)
	}
	if ho := o.hostOptions("/data", "/core.wasm", ""); o.holdPublic || ho.TURNListen != "" || ho.TURNSecretFile != "" {
		t.Fatalf("control: %+v %+v", o, ho)
	}
}
