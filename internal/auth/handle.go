// Package auth is dillad's account, credential and session layer: handles,
// invites, passwords, TOTP, recovery codes, passkeys, OIDC, device sessions and
// the login throttle.
package auth

import (
	"errors"
	"fmt"
	"unicode"
	"unicode/utf8"

	"golang.org/x/text/secure/precis"
	"golang.org/x/text/unicode/norm"
)

const (
	handleMin  = 3
	handleMax  = 32
	displayMax = 64
)

var (
	ErrHandleLength   = errors.New("auth: a handle is 3 to 32 characters")
	ErrHandleSyntax   = errors.New("auth: a handle is lowercase a-z, 0-9, dot, underscore or dash, and does not start or end with a dot")
	ErrHandleUnicode  = errors.New("auth: v1 handles are ASCII only")
	ErrDisplayLength  = errors.New("auth: a display name is at most 64 characters")
	ErrDisplayControl = errors.New("auth: a display name may not contain a bidi control character")
)

// NormalizeHandle canonicalises a handle: PRECIS UsernameCaseMapped (RFC 8265 —
// width folding, lowercasing, NFC and the bidi rule), then dilla's own ASCII
// rule.
//
// Two facts about the PRECIS profile shape this function. It accepts the empty
// string, because unlike Nickname and OpaqueString it carries no DisallowEmpty
// option — so the length check below is not redundant. And it lowercases rather
// than case-folds, so "STRASSE" and "straße" stay distinct; v1 sidesteps the
// question by refusing non-ASCII handles altogether, because no maintained Go
// UTS #39 confusables implementation exists (facts-auth §6.1). Unicode handles
// are a follow-up card, not a v1 feature.
func NormalizeHandle(s string) (string, error) {
	if n := utf8.RuneCountInString(s); n < handleMin || n > handleMax {
		return "", fmt.Errorf("%w (got %d)", ErrHandleLength, n)
	}
	canonical, err := precis.UsernameCaseMapped.String(s)
	if err != nil {
		return "", fmt.Errorf("auth: %q is not a valid username: %w", s, err)
	}
	if canonical == "" {
		return "", ErrHandleLength
	}
	for _, r := range canonical {
		if r > unicode.MaxASCII {
			return "", ErrHandleUnicode
		}
	}
	if !ValidHandle(canonical) {
		return "", ErrHandleSyntax
	}
	return canonical, nil
}

// ValidHandle is dilla's syntax rule on top of PRECIS. '@' is excluded because
// it separates handle from host in handle@host.
func ValidHandle(s string) bool {
	if len(s) < handleMin || len(s) > handleMax {
		return false
	}
	if s[0] == '.' || s[len(s)-1] == '.' {
		return false
	}
	for i := 0; i < len(s); i++ {
		c := s[i]
		switch {
		case c >= 'a' && c <= 'z', c >= '0' && c <= '9', c == '.', c == '_', c == '-':
		default:
			return false
		}
	}
	return true
}

// NormalizeDisplay normalises a display name to NFC and refuses bidi controls.
// Display names are freeform by design, so the only rules are the ones that
// would let one user paint another user's name in the UI.
func NormalizeDisplay(s string) (string, error) {
	out := norm.NFC.String(s)
	if utf8.RuneCountInString(out) > displayMax {
		return "", ErrDisplayLength
	}
	for _, r := range out {
		switch r {
		case '‪', '‫', '‬', '‭', '‮',
			'⁦', '⁧', '⁨', '⁩', '‎', '‏':
			return "", ErrDisplayControl
		}
		if unicode.IsControl(r) {
			return "", ErrDisplayControl
		}
	}
	return out, nil
}
