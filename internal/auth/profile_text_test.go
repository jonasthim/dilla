package auth_test

import (
	"errors"
	"strings"
	"testing"

	"github.com/jonasthim/dilla/internal/auth"
)

func TestNormalizeStatus(t *testing.T) {
	if got, err := auth.NormalizeStatus("café open"); err != nil || got != "café open" {
		t.Fatalf("NFC: %q, %v", got, err)
	}
	if got, err := auth.NormalizeStatus(strings.Repeat("ä", 190)); err != nil || len([]rune(got)) != 190 {
		t.Fatalf("190 characters refused: %v", err)
	}
	if _, err := auth.NormalizeStatus(strings.Repeat("a", 191)); !errors.Is(err, auth.ErrProfileLength) {
		t.Fatalf("191 characters = %v, want ErrProfileLength", err)
	}
	for name, in := range map[string]string{"newline": "a\nb", "tab": "a\tb", "bidi override": "a‮b", "isolate": "a⁦b", "nul": "a\x00b"} {
		if _, err := auth.NormalizeStatus(in); !errors.Is(err, auth.ErrProfileControl) {
			t.Errorf("%s: %v, want ErrProfileControl", name, err)
		}
	}
	if got, err := auth.NormalizeStatus(""); err != nil || got != "" {
		t.Fatalf("empty clears: %q, %v", got, err)
	}
}

func TestNormalizeBio(t *testing.T) {
	if got, err := auth.NormalizeBio("one\ntwo\n\nthree"); err != nil || got != "one\ntwo\n\nthree" {
		t.Fatalf("newlines kept: %q, %v", got, err)
	}
	if got, err := auth.NormalizeBio("one\r\ntwo"); err != nil || got != "one\ntwo" {
		t.Fatalf("CRLF becomes LF: %q, %v", got, err)
	}
	if _, err := auth.NormalizeBio(strings.Repeat("ö", 500)); err != nil {
		t.Fatalf("500 characters refused: %v", err)
	}
	if _, err := auth.NormalizeBio(strings.Repeat("a", 501)); !errors.Is(err, auth.ErrProfileLength) {
		t.Fatalf("501 characters = %v, want ErrProfileLength", err)
	}
	for name, in := range map[string]string{"bidi": "a‮b", "rlm": "a‏b", "tab": "a\tb", "esc": "a\x1bb", "lone CR": "a\rb"} {
		if _, err := auth.NormalizeBio(in); !errors.Is(err, auth.ErrProfileControl) {
			t.Errorf("%s: %v, want ErrProfileControl", name, err)
		}
	}
}
