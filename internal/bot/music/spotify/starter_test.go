package spotify

import (
	"context"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestPCMStarterLoadsCredentialWithoutPuttingItInArguments(t *testing.T) {
	helper := fakeTokenProtocolHelper(t)
	argsFile := filepath.Join(t.TempDir(), "args")
	body, err := os.ReadFile(helper)
	if err != nil {
		t.Fatal(err)
	}
	// Record the argument vector while retaining the protocol checks in the fake.
	body = append([]byte("#!/bin/sh\nprintf '%s\\n' \"$@\" >'"+argsFile+"'\n"), body[len("#!/bin/sh\n"):]...)
	if err := os.WriteFile(helper, body, 0700); err != nil {
		t.Fatal(err)
	}
	starter, err := NewPCMStarter(helper, t.TempDir(), func(context.Context) (string, error) {
		return "private-token", nil
	})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(t.Context(), 3*time.Second)
	defer cancel()
	pcm, err := starter.Start(ctx, "spotify:track:0123456789012345678901")
	if err != nil {
		t.Fatal(err)
	}
	defer pcm.Close()
	frame := make([]byte, PCMBytesPerFrame)
	if _, err := io.ReadFull(pcm, frame); err != nil {
		t.Fatal(err)
	}
	args, err := os.ReadFile(argsFile)
	if err != nil {
		t.Fatal(err)
	}
	if string(args) != "spotify:track:0123456789012345678901\n" {
		t.Fatalf("helper arguments = %q", args)
	}
}

func TestPCMStarterSanitizesCredentialLoadErrors(t *testing.T) {
	starter, err := NewPCMStarter("/bin/true", t.TempDir(), func(context.Context) (string, error) {
		return "", os.ErrPermission
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := starter.Start(t.Context(), "spotify:track:0123456789012345678901"); err == nil || err.Error() == os.ErrPermission.Error() {
		t.Fatalf("credential error was not sanitized: %v", err)
	}
}

func TestPCMStarterCancellationReapsChildAndAllowsRestart(t *testing.T) {
	helper := fakeTokenProtocolHelper(t)
	loads := 0
	starter, err := NewPCMStarter(helper, t.TempDir(), func(context.Context) (string, error) {
		loads++
		return "private-token", nil
	})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(t.Context())
	pcm, err := starter.Start(ctx, "spotify:track:0123456789012345678901")
	if err != nil {
		cancel()
		t.Fatal(err)
	}
	frame := make([]byte, PCMBytesPerFrame)
	if _, err := io.ReadFull(pcm, frame); err != nil {
		cancel()
		_ = pcm.Close()
		t.Fatal(err)
	}
	cancel()
	_, _ = pcm.Read(frame)
	if err := pcm.Close(); err != nil {
		t.Fatalf("close cancelled child: %v", err)
	}
	next, err := starter.Start(t.Context(), "spotify:track:0123456789012345678901")
	if err != nil {
		t.Fatalf("restart after cancellation: %v", err)
	}
	if loads != 2 {
		t.Fatalf("credential loads = %d, want one fresh load per playback", loads)
	}
	if err := next.Close(); err != nil {
		t.Fatal(err)
	}
}

func fakeTokenProtocolHelper(t *testing.T) string {
	t.Helper()
	helper := mustFakeProtocolHelper(t, true)
	body, err := os.ReadFile(helper)
	if err != nil {
		t.Fatal(err)
	}
	body = []byte(strings.ReplaceAll(string(body), `"private-token"`, `"{\"access_token\":\"private-token\"}"`))
	if err := os.WriteFile(helper, body, 0700); err != nil {
		t.Fatal(err)
	}
	return helper
}
