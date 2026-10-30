package youtube

import (
	"bytes"
	"context"
	"errors"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"unicode/utf8"
)

func TestYouTubeDiagnosticTextIsBoundedAndPrintable(t *testing.T) {
	for _, tc := range []struct{ input, want string }{
		{"namespace\n\t failed\x00\x1b\u202e", "namespace failed"},
		{strings.Repeat("x", 600), strings.Repeat("x", 509) + "…"},
		{strings.Repeat("é", 600), strings.Repeat("é", 254) + "…"},
	} {
		got := DiagnosticText(tc.input)
		if got != tc.want || len(got) > 512 || !utf8.ValidString(got) {
			t.Fatalf("diagnostic=%q (%d bytes)", got, len(got))
		}
	}
}
func TestYouTubeProcessFailureClasses(t *testing.T) {
	for _, tc := range []struct {
		err   error
		class string
	}{
		{ErrSandboxUnavailable, "sandbox_unavailable"}, {ErrExtractFailed, "extract_failed"}, {ErrMetadataInvalid, "metadata_invalid"},
		{ErrInvalidInput, "invalid_input"}, {context.DeadlineExceeded, "deadline_exceeded"}, {context.Canceled, "canceled"},
		{ErrMetadataTooLarge, "metadata_too_large"}, {ErrRunnerRequired, "runner_required"},
	} {
		err := &ProcessError{Cause: tc.err, Stderr: "bwrap\nfailed", ExitCode: 1}
		if !errors.Is(err, tc.err) || FailureClass(err) != tc.class || FailureStderr(err) != "bwrap failed" || strings.Contains(err.Error(), "bwrap") {
			t.Fatalf("error=%v class=%s stderr=%s", err, FailureClass(err), FailureStderr(err))
		}
	}
}

func TestYouTubeProcessExitCodeClass(t *testing.T) {
	err := &ProcessError{Cause: errors.New("process exited"), ExitCode: 42}
	if class := FailureClass(err); class != "exit_42" {
		t.Fatalf("class=%s", class)
	}
}

func TestIsolatedMetadataRunnerRetainsSandboxStderr(t *testing.T) {
	python, err := exec.LookPath("python3")
	if err != nil {
		t.Fatal(err)
	}
	executable, err := exec.LookPath("true")
	if err != nil {
		t.Fatal(err)
	}
	shim := filepath.Join(t.TempDir(), "bwrap")
	if err := os.WriteFile(shim, []byte("#!/bin/sh\nprintf 'namespace\\nblocked\\000' >&2\nexit 42\n"), 0o700); err != nil {
		t.Fatal(err)
	}
	var logs bytes.Buffer
	logger := slog.New(slog.NewJSONHandler(&logs, nil)).With("installation_id", "test-installation")
	ctx := WithDiagnosticLogger(t.Context(), logger)
	_, err = (IsolatedMetadataRunner{Bubblewrap: shim, Python: python}).Run(ctx, executable, nil, 2048)
	var process *ProcessError
	if !errors.Is(err, ErrSandboxUnavailable) || !errors.As(err, &process) || process.ExitCode != 42 || FailureStderr(err) != "namespace blocked" {
		t.Fatalf("error=%v diagnostics=%q", err, FailureStderr(err))
	}
	if !strings.Contains(logs.String(), `"installation_id":"test-installation"`) || !strings.Contains(logs.String(), `"class":"sandbox_unavailable"`) || !strings.Contains(logs.String(), `"stderr":"namespace blocked"`) {
		t.Fatalf("startup log=%s", logs.String())
	}
}

func TestSandboxStderrCaptureIsBounded(t *testing.T) {
	capture := &sandboxStderr{}
	input := strings.Repeat("x", 100000)
	n, err := capture.Write([]byte(input))
	if err != nil || n != len(input) || len(capture.String()) > 4096 || len(DiagnosticText(capture.String())) != 512 {
		t.Fatalf("write=%d err=%v captured=%d", n, err, len(capture.String()))
	}
}
