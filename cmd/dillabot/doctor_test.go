//go:build linux

package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestDillabotDoctorChecksLocalDependenciesWithoutPrintingPathsOrSecrets(t *testing.T) {
	dir := t.TempDir()
	credentialText := "dbr_" + base64.RawURLEncoding.EncodeToString(make([]byte, 32))
	credential := filepath.Join(dir, "runtime.token")
	if err := os.WriteFile(credential, []byte(credentialText), 0o600); err != nil {
		t.Fatal(err)
	}
	helper := filepath.Join(dir, "helper")
	if err := os.WriteFile(helper, []byte("helper"), 0o700); err != nil {
		t.Fatal(err)
	}
	module := filepath.Join(dir, "identity.wasm")
	if err := os.WriteFile(module, []byte("fixture wasm"), 0o600); err != nil {
		t.Fatal(err)
	}
	state := filepath.Join(dir, "state")
	if err := os.Mkdir(state, 0o700); err != nil {
		t.Fatal(err)
	}
	config := filepath.Join(dir, "bot.toml")
	body := "base_url = \"https://dilla.example\"\n" +
		"instance_id = \"01010101010101010101010101010101\"\n" +
		"runtime_credential_file = \"" + credential + "\"\n" +
		"helper_executable = \"" + helper + "\"\n" +
		"wasi_module = \"" + module + "\"\n" +
		"state_dir = \"" + state + "\"\n" +
		"reconcile_interval = \"30s\"\n"
	if err := os.WriteFile(config, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	oldDoctorWASI := doctorWASI
	doctorWASI = func(context.Context, []byte) error { return nil }
	t.Cleanup(func() { doctorWASI = oldDoctorWASI })

	var stdout, stderr bytes.Buffer
	if code := runDoctorCommand([]string{"--config", config}, &stdout, &stderr); code != 0 {
		t.Fatalf("doctor exit code = %d, stderr %q, output:\n%s", code, stderr.String(), stdout.String())
	}
	for _, check := range []string{"runtime_credential OK", "native_helper OK", "wasi_identity_module OK", "state_directory OK"} {
		if !strings.Contains(stdout.String(), check) {
			t.Errorf("doctor output lacks %q:\n%s", check, stdout.String())
		}
	}
	if strings.Contains(stdout.String()+stderr.String(), credentialText) || strings.Contains(stdout.String()+stderr.String(), dir) {
		t.Fatal("doctor output disclosed secret material or configured filesystem paths")
	}
}

func TestDillabotDoctorFailsWhenARequiredDependencyIsUnavailable(t *testing.T) {
	dir := t.TempDir()
	credential := filepath.Join(dir, "runtime.token")
	if err := os.WriteFile(credential, []byte("dbr_"+base64.RawURLEncoding.EncodeToString(make([]byte, 32))), 0o600); err != nil {
		t.Fatal(err)
	}
	state := filepath.Join(dir, "state")
	if err := os.Mkdir(state, 0o700); err != nil {
		t.Fatal(err)
	}
	module := filepath.Join(dir, "identity.wasm")
	if err := os.WriteFile(module, []byte("fixture"), 0o600); err != nil {
		t.Fatal(err)
	}
	config := filepath.Join(dir, "bot.toml")
	body := "base_url = \"https://dilla.example\"\n" +
		"instance_id = \"01010101010101010101010101010101\"\n" +
		"runtime_credential_file = \"" + credential + "\"\n" +
		"helper_executable = \"" + filepath.Join(dir, "missing-helper") + "\"\n" +
		"wasi_module = \"" + module + "\"\n" +
		"state_dir = \"" + state + "\"\n" +
		"reconcile_interval = \"30s\"\n"
	if err := os.WriteFile(config, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	oldDoctorWASI := doctorWASI
	doctorWASI = func(context.Context, []byte) error { return errors.New("invalid module fixture") }
	t.Cleanup(func() { doctorWASI = oldDoctorWASI })

	var stdout, stderr bytes.Buffer
	if code := runDoctorCommand([]string{"--config", config}, &stdout, &stderr); code == 0 {
		t.Fatalf("doctor accepted an unavailable helper:\n%s", stdout.String())
	}
	if !strings.Contains(stdout.String(), "native_helper FAIL") {
		t.Fatalf("doctor did not report helper failure:\n%s", stdout.String())
	}
	if !strings.Contains(stdout.String(), "wasi_identity_module FAIL") || strings.Contains(stdout.String(), "invalid module fixture") {
		t.Fatalf("doctor did not report a sanitized module failure:\n%s", stdout.String())
	}
}

func TestDillabotDoctorRejectsUntrustedOrUnexecutableCodeFiles(t *testing.T) {
	dir := t.TempDir()
	helper := filepath.Join(dir, "helper")
	module := filepath.Join(dir, "identity.wasm")
	if err := os.WriteFile(helper, []byte("helper"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(module, []byte("fixture"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(helper, 0o601); err != nil {
		t.Fatal(err)
	}
	if err := validateHelperExecutable(helper); err == nil && os.Geteuid() != 0 {
		t.Fatal("owner without execute permission was accepted via another user's execute bit")
	}
	if err := os.Chmod(helper, 0o722); err != nil {
		t.Fatal(err)
	}
	if err := validateHelperExecutable(helper); err == nil {
		t.Fatal("helper writable by another user was accepted")
	}
	if err := os.Chmod(module, 0o620); err != nil {
		t.Fatal(err)
	}
	if _, err := readDoctorWASI(module); err == nil {
		t.Fatal("group-writable WASI module was accepted")
	}
}
