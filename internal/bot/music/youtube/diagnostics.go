package youtube

import (
	"context"
	"errors"
	"log/slog"
	"os/exec"
	"strconv"
	"strings"
	"unicode"
	"unicode/utf8"
)

// ProcessError retains bounded subprocess diagnostics without putting command
// arguments (which may contain message content) in Error().
type ProcessError struct {
	Cause    error
	Stderr   string
	ExitCode int
}

func (e *ProcessError) Error() string { return e.Cause.Error() }
func (e *ProcessError) Unwrap() error { return e.Cause }

// DiagnosticText produces one printable line, at most 512 UTF-8 bytes including
// the truncation marker. Whitespace separates words; other controls are removed.
func DiagnosticText(value string) string {
	value = strings.Map(func(r rune) rune {
		if unicode.IsSpace(r) {
			return ' '
		}
		if unicode.IsControl(r) || unicode.Is(unicode.Cf, r) {
			return -1
		}
		return r
	}, strings.ToValidUTF8(value, ""))
	value = strings.Join(strings.Fields(value), " ")
	if len(value) <= 512 {
		return value
	}
	end := 512 - len("…")
	for !utf8.RuneStart(value[end]) {
		end--
	}
	return value[:end] + "…"
}

func FailureClass(err error) string {
	switch {
	case errors.Is(err, context.DeadlineExceeded):
		return "deadline_exceeded"
	case errors.Is(err, context.Canceled):
		return "canceled"
	case errors.Is(err, ErrSandboxUnavailable):
		return "sandbox_unavailable"
	case errors.Is(err, ErrExtractFailed):
		return "extract_failed"
	case errors.Is(err, ErrMetadataInvalid):
		return "metadata_invalid"
	case errors.Is(err, ErrInvalidInput):
		return "invalid_input"
	case errors.Is(err, ErrMetadataTooLarge):
		return "metadata_too_large"
	case errors.Is(err, ErrRunnerRequired):
		return "runner_required"
	}
	var process *ProcessError
	if errors.As(err, &process) && process.ExitCode != 0 {
		return "exit_" + strconv.Itoa(process.ExitCode)
	}
	var exit *exec.ExitError
	if errors.As(err, &exit) {
		return "exit_" + strconv.Itoa(exit.ExitCode())
	}
	return "unknown"
}

func FailureStderr(err error) string {
	var process *ProcessError
	if errors.As(err, &process) {
		return DiagnosticText(process.Stderr)
	}
	var exit *exec.ExitError
	if errors.As(err, &exit) {
		return DiagnosticText(string(exit.Stderr))
	}
	return ""
}

type diagnosticLoggerKey struct{}

// WithDiagnosticLogger carries installation-scoped logging into the sandbox.
func WithDiagnosticLogger(ctx context.Context, logger *slog.Logger) context.Context {
	if logger == nil {
		return ctx
	}
	return context.WithValue(ctx, diagnosticLoggerKey{}, logger)
}
func diagnosticLogger(ctx context.Context) *slog.Logger {
	if logger, ok := ctx.Value(diagnosticLoggerKey{}).(*slog.Logger); ok {
		return logger
	}
	return slog.Default()
}
