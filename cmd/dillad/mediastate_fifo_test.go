package main

import (
	"errors"
	"os"
	"strings"
	"syscall"
	"testing"
	"time"
)

// UP3 fix round 4: media.json lives in a directory dillad writes, and the doctor (run by the
// installer) and serve read it. A FIFO there must never block them: it is no media.json.
func TestReadMediaStateTreatsAFIFOAsAbsentWithoutBlocking(t *testing.T) {
	cfg := sidecarConfig(t)
	stubMediaMainPID(t, 4242, nil)
	if err := syscall.Mkfifo(mediaStatePath(cfg.Instance.DataDir), 0o600); err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() {
		_, err := readMediaState(t.Context(), cfg.Instance.DataDir)
		done <- err
	}()
	select {
	case err := <-done:
		if !errors.Is(err, errNoMediaState) {
			t.Fatalf("a FIFO media.json: err = %v, want errNoMediaState", err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("readMediaState blocked on a FIFO media.json")
	}
}

// A symbolic link is no media.json either, and an oversized file is refused, not read whole.
func TestReadMediaStateRefusesALinkAndAnOversizedFile(t *testing.T) {
	cfg := sidecarConfig(t)
	stubMediaMainPID(t, 4242, nil)
	target := t.TempDir() + "/media.json"
	if err := os.WriteFile(target, []byte(`{"version":"x","media_level":2,"capabilities":[],"pid":4242}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(target, mediaStatePath(cfg.Instance.DataDir)); err != nil {
		t.Fatal(err)
	}
	if _, err := readMediaState(t.Context(), cfg.Instance.DataDir); !errors.Is(err, errNoMediaState) {
		t.Fatalf("a symlinked media.json: err = %v, want errNoMediaState", err)
	}
	_ = os.Remove(mediaStatePath(cfg.Instance.DataDir))
	big := `{"version":"x","media_level":2,"capabilities":[],"pid":4242,"pad":"` + strings.Repeat("a", 8192) + `"}`
	if err := os.WriteFile(mediaStatePath(cfg.Instance.DataDir), []byte(big), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := readMediaState(t.Context(), cfg.Instance.DataDir); !errors.Is(err, errNoMediaState) {
		t.Fatalf("an oversized media.json: err = %v, want errNoMediaState", err)
	}
}
