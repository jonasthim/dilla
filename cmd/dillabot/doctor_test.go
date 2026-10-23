//go:build linux

package main

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"encoding/base64"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
)

// This is the offline Bot half of the backup/restore acceptance slice. The
// server archive and generation reconciliation need a coordinated staging
// instance; this test exercises what can be proved from a cold Bot archive:
// key + encrypted database + SQLite recovery sidecars travel together, modes
// survive, and the restored private state passes the local doctor.
func TestColdBotArchiveRoundTripKeepsKeyAndSQLiteSidecarsDoctorReady(t *testing.T) {
	root := t.TempDir()
	source := filepath.Join(root, "source")
	restored := filepath.Join(root, "restored")
	etc := filepath.Join(source, "etc", "dillabot")
	state := filepath.Join(source, "var", "lib", "dillabot")
	install := filepath.Join(state, "04040404040404040404040404040404")
	for _, dir := range []string{etc, install} {
		if err := os.MkdirAll(dir, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	files := map[string][]byte{
		"database.key":     bytes.Repeat([]byte{0x42}, 32),
		"state.db":         []byte("opaque encrypted database fixture"),
		"state.db-wal":     []byte("opaque encrypted wal fixture"),
		"state.db-journal": []byte("opaque encrypted journal fixture"),
	}
	for name, body := range files {
		if err := os.WriteFile(filepath.Join(install, name), body, 0o600); err != nil {
			t.Fatal(err)
		}
	}
	files["state.db-shm"] = []byte("opaque encrypted shm fixture")
	if err := os.WriteFile(filepath.Join(install, "state.db-shm"), files["state.db-shm"], 0o600); err != nil {
		t.Fatal(err)
	}
	credentialText := "dbr_" + base64.RawURLEncoding.EncodeToString(make([]byte, 32))
	credential := filepath.Join(restored, "etc", "dillabot", "runtime.token")
	if err := os.WriteFile(filepath.Join(etc, "runtime.token"), []byte(credentialText), 0o600); err != nil {
		t.Fatal(err)
	}
	helper := filepath.Join(root, "helper")
	if err := os.WriteFile(helper, []byte("#!/bin/sh\nexit 0\n"), 0o700); err != nil {
		t.Fatal(err)
	}
	module := filepath.Join(root, "identity.wasm")
	if err := os.WriteFile(module, []byte("fixture wasm"), 0o600); err != nil {
		t.Fatal(err)
	}
	configPath := filepath.Join(restored, "etc", "dillabot", "bot.toml")
	config := "base_url = \"https://dilla.example\"\n" +
		"instance_id = \"01010101010101010101010101010101\"\n" +
		"runtime_credential_file = \"" + credential + "\"\n" +
		"helper_executable = \"" + helper + "\"\n" +
		"wasi_module = \"" + module + "\"\n" +
		"state_dir = \"" + filepath.Join(restored, "var", "lib", "dillabot") + "\"\n" +
		"reconcile_interval = \"30s\"\n"
	if err := os.WriteFile(filepath.Join(etc, "bot.toml"), []byte(config), 0o600); err != nil {
		t.Fatal(err)
	}
	archive := filepath.Join(root, "bot-cold.tar.gz")
	if err := writeBotColdArchive(archive, source); err != nil {
		t.Fatalf("write cold archive: %v", err)
	}
	if info, err := os.Stat(archive); err != nil || info.Mode().Perm() != 0o600 {
		t.Fatalf("cold archive mode/info = %v, %v; want 0600", info, err)
	}
	if err := extractBotColdArchive(archive, restored); err != nil {
		t.Fatalf("restore cold archive: %v", err)
	}
	restoredState := filepath.Join(restored, "var", "lib", "dillabot")
	for name, want := range files {
		path := filepath.Join(restoredState, filepath.Base(install), name)
		got, err := os.ReadFile(path)
		if err != nil {
			t.Fatalf("restored %s: %v", name, err)
		}
		if !bytes.Equal(got, want) {
			t.Errorf("restored %s differs from cold snapshot", name)
		}
		info, err := os.Stat(path)
		if err != nil || info.Mode().Perm() != 0o600 {
			t.Errorf("restored %s mode/info = %v, %v; want 0600", name, info, err)
		}
	}
	if info, err := os.Stat(restoredState); err != nil || info.Mode().Perm() != 0o700 {
		t.Fatalf("restored state directory mode/info = %v, %v; want 0700", info, err)
	}
	if info, err := os.Stat(filepath.Join(restoredState, filepath.Base(install))); err != nil || info.Mode().Perm() != 0o700 {
		t.Fatalf("restored installation directory mode/info = %v, %v; want 0700", info, err)
	}

	if _, err := os.Stat(filepath.Join(restored, "etc", "dillabot", "runtime.token")); err != nil {
		t.Fatalf("restored Bot credential: %v", err)
	}
	oldDoctorWASI := doctorWASI
	doctorWASI = func(context.Context, []byte) error { return nil }
	t.Cleanup(func() { doctorWASI = oldDoctorWASI })
	var stdout, stderr bytes.Buffer
	if code := runDoctorCommand([]string{"--config", configPath}, &stdout, &stderr); code != 0 {
		t.Fatalf("doctor rejected restored private state (exit %d): %s\n%s", code, stderr.String(), stdout.String())
	}
	if !strings.Contains(stdout.String(), "state_directory OK") {
		t.Fatalf("doctor did not accept restored state directory:\n%s", stdout.String())
	}
}

func writeBotColdArchive(path, root string) error {
	f, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	gz := gzip.NewWriter(f)
	tw := tar.NewWriter(gz)
	for _, name := range []string{
		"etc/dillabot",
		"etc/dillabot/bot.toml",
		"etc/dillabot/runtime.token",
		"var/lib/dillabot",
		"var/lib/dillabot/04040404040404040404040404040404",
		"var/lib/dillabot/04040404040404040404040404040404/database.key",
		"var/lib/dillabot/04040404040404040404040404040404/state.db",
		"var/lib/dillabot/04040404040404040404040404040404/state.db-wal",
		"var/lib/dillabot/04040404040404040404040404040404/state.db-shm",
		"var/lib/dillabot/04040404040404040404040404040404/state.db-journal",
	} {
		full := filepath.Join(root, filepath.FromSlash(name))
		info, err := os.Stat(full)
		if err != nil {
			_ = tw.Close()
			_ = gz.Close()
			_ = f.Close()
			return err
		}
		hdr, err := tar.FileInfoHeader(info, "")
		if err != nil {
			return err
		}
		hdr.Name = name
		if err := tw.WriteHeader(hdr); err != nil {
			return err
		}
		if info.Mode().IsRegular() {
			in, err := os.Open(full)
			if err != nil {
				return err
			}
			_, copyErr := io.Copy(tw, in)
			closeErr := in.Close()
			if copyErr != nil {
				return copyErr
			}
			if closeErr != nil {
				return closeErr
			}
		}
	}
	if err := tw.Close(); err != nil {
		return err
	}
	if err := gz.Close(); err != nil {
		return err
	}
	return f.Close()
}

func extractBotColdArchive(path, root string) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()
	gz, err := gzip.NewReader(f)
	if err != nil {
		return err
	}
	defer gz.Close()
	tr := tar.NewReader(gz)
	for {
		hdr, err := tr.Next()
		if errors.Is(err, io.EOF) {
			return nil
		}
		if err != nil {
			return err
		}
		if filepath.IsAbs(hdr.Name) || filepath.Clean(hdr.Name) != hdr.Name || hdr.Name == ".." || strings.HasPrefix(hdr.Name, "../") {
			return errors.New("unsafe archive member")
		}
		dest := filepath.Join(root, filepath.FromSlash(hdr.Name))
		if hdr.Typeflag == tar.TypeDir {
			if err := os.MkdirAll(dest, os.FileMode(hdr.Mode)); err != nil {
				return err
			}
			continue
		}
		if hdr.Typeflag != tar.TypeReg {
			return errors.New("unexpected archive member type")
		}
		if err := os.MkdirAll(filepath.Dir(dest), 0o700); err != nil {
			return err
		}
		out, err := os.OpenFile(dest, os.O_CREATE|os.O_EXCL|os.O_WRONLY, os.FileMode(hdr.Mode))
		if err != nil {
			return err
		}
		_, copyErr := io.Copy(out, tr)
		closeErr := out.Close()
		if copyErr != nil {
			return copyErr
		}
		if closeErr != nil {
			return closeErr
		}
	}
}

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
	if err := os.Chmod(helper, os.ModeSetuid|0o700); err != nil {
		t.Fatal(err)
	}
	if err := validateHelperExecutable(helper); err == nil {
		t.Fatal("setuid helper was accepted")
	}
	if err := os.Chmod(module, 0o620); err != nil {
		t.Fatal(err)
	}
	if _, err := readDoctorWASI(module); err == nil {
		t.Fatal("group-writable WASI module was accepted")
	}
	fifo := filepath.Join(dir, "blocking-fifo")
	if err := syscall.Mkfifo(fifo, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := validateHelperExecutable(fifo); err == nil {
		t.Fatal("FIFO was accepted as a helper")
	}
	if _, err := readDoctorWASI(fifo); err == nil {
		t.Fatal("FIFO was accepted as a WASI module")
	}
}
