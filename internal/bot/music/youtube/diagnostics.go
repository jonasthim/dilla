package youtube

import (
	"context"
	"errors"
	"log/slog"
	"net/url"
	"os/exec"
	"regexp"
	"sort"
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

type diagnosticInputKey struct{}

var diagnosticURL = regexp.MustCompile(`(?i)[a-z][a-z0-9+.-]*://[^\s]+`)
var diagnosticYouTubeToken = regexp.MustCompile(`(\[youtube[^\]]*\]\s+)[^\r\n]*?:`)

// Redact raw text before normalization or truncation can split a private value.
func newProcessError(cause error, raw string, exitCode int, inputs ...string) *ProcessError {
	var secrets []string
	for _, input := range inputs {
		if input == "" {
			continue
		}
		secrets = append(secrets, input)
		if kind, canonical, err := NormalizeInput(input); err == nil {
			secrets = append(secrets, canonical)
			if kind == "search" {
				secrets = append(secrets, strings.TrimPrefix(canonical, "ytsearch5:"))
			} else {
				u, _ := url.Parse(canonical)
				secrets = append(secrets, u.Query().Get("v"), u.Query().Get("list"))
			}
		}
	}
	var encoded []string
	for _, secret := range secrets {
		if secret != "" {
			encoded = append(encoded, secret, url.QueryEscape(secret), url.PathEscape(secret))
		}
	}
	sort.Slice(encoded, func(i, j int) bool { return len(encoded[i]) > len(encoded[j]) })
	patterns := []string{diagnosticURL.String()}
	for _, secret := range encoded {
		patterns = append(patterns, regexp.QuoteMeta(secret))
	}
	pattern := regexp.MustCompile(strings.Join(patterns, "|"))
	// Replace URLs and known secrets in one pass so short queries cannot rewrite
	// markers or strip a URL scheme before the URL matcher sees it.
	raw = pattern.ReplaceAllString(raw, "[redacted]")
	// Known search text (which can contain colons) is gone before the generic
	// extractor token fallback handles IDs belonging to other playlist videos.
	raw = diagnosticYouTubeToken.ReplaceAllString(raw, "${1}[redacted]:")
	return &ProcessError{Cause: cause, Stderr: DiagnosticText(raw), ExitCode: exitCode}
}
