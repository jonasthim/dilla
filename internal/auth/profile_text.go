package auth

import (
	"errors"
	"strings"
	"unicode"
	"unicode/utf8"

	"golang.org/x/text/unicode/norm"
)

const (
	statusMax = 190
	bioMax    = 500
)

var (
	ErrProfileLength  = errors.New("auth: a status message is at most 190 characters and a bio at most 500")
	ErrProfileControl = errors.New("auth: a status message or bio may not contain a control or bidi character")
)

// NormalizeStatus normalises a status message to NFC. It is one line of at most 190 characters and
// carries no control or bidi character (the display-name rules, which keep one person from painting
// another's row).
func NormalizeStatus(s string) (string, error) {
	return normalizeProfileText(s, statusMax, false)
}

// NormalizeBio normalises a bio to NFC. It is at most 500 characters; a line break is kept (CRLF
// becomes LF) and every other control or bidi character is refused.
func NormalizeBio(s string) (string, error) {
	return normalizeProfileText(strings.ReplaceAll(s, "\r\n", "\n"), bioMax, true)
}

func normalizeProfileText(s string, max int, lines bool) (string, error) {
	out := norm.NFC.String(s)
	if utf8.RuneCountInString(out) > max {
		return "", ErrProfileLength
	}
	for _, r := range out {
		switch r {
		case '‪', '‫', '‬', '‭', '‮',
			'⁦', '⁧', '⁨', '⁩', '‎', '‏':
			return "", ErrProfileControl
		case '\n':
			if lines {
				continue
			}
		}
		if unicode.IsControl(r) {
			return "", ErrProfileControl
		}
	}
	return out, nil
}
