package auth

import (
	"errors"
	"strings"
	"unicode"
	"unicode/utf8"

	"golang.org/x/text/unicode/norm"
)

// Limits of the account's profile text, in characters.
const (
	StatusMaxRunes = 190
	BioMaxRunes    = 500
)

var (
	// ErrTextLength: more characters than the field allows.
	ErrTextLength = errors.New("auth: the text is too long")
	// ErrTextChars: a control, bidi, zero-width or line-separator character, or a line break where there is none.
	ErrTextChars = errors.New("auth: the text has characters that cannot be shown")
	// ErrTextBlank: only whitespace.
	ErrTextBlank = errors.New("auth: the text is only whitespace")
)

// NormalizeUserText is the one rule for free text a person writes about themselves or a device (a
// status message, a bio, E7's device label): NFC, at most maxRunes characters, trimmed, and none of
//
//   - a control character (a tab included; a line break only when allowNewline, and then CRLF becomes LF);
//   - a bidi control (U+200E, U+200F, U+202A-202E, U+2066-2069) or U+061C;
//   - a zero-width character (U+200B, U+200C, U+200D, U+2060, U+FEFF), except a U+200D joiner inside an
//     emoji sequence (a symbol before and after it);
//   - U+2028 or U+2029.
//
// Only whitespace is ErrTextBlank, and "" is allowed and means "none". The errors are ErrTextLength,
// ErrTextChars and ErrTextBlank, so a caller can tell a person what to change. The display name uses the
// same character rule (NormalizeDisplay).
func NormalizeUserText(s string, maxRunes int, allowNewline bool) (string, error) {
	if allowNewline {
		s = strings.ReplaceAll(s, "\r\n", "\n")
	}
	out := norm.NFC.String(s)
	if utf8.RuneCountInString(out) > maxRunes {
		return "", ErrTextLength
	}
	if !textCharsOK(out, allowNewline) {
		return "", ErrTextChars
	}
	trimmed := strings.TrimSpace(out)
	if trimmed == "" && out != "" {
		return "", ErrTextBlank
	}
	return trimmed, nil
}

// textCharsOK is the character class of NormalizeUserText and NormalizeDisplay.
func textCharsOK(s string, allowNewline bool) bool {
	runes := []rune(s)
	for i, r := range runes {
		switch r {
		case 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069, 0x061c,
			0x200b, 0x200c, 0x2060, 0xfeff, 0x2028, 0x2029:
			return false
		case 0x200d:
			if i == 0 || i == len(runes)-1 || !joinsEmoji(runes[i-1], runes[i+1]) {
				return false
			}
		case '\n':
			if !allowNewline {
				return false
			}
		default:
			if unicode.IsControl(r) {
				return false
			}
		}
	}
	return true
}

// joinsEmoji: a zero-width joiner is kept only between pictographs (a symbol, a skin-tone modifier or a
// variation selector before it, a symbol after it).
func joinsEmoji(before, after rune) bool {
	return (unicode.In(before, unicode.So, unicode.Sk) || before == 0xfe0f) && unicode.Is(unicode.So, after)
}
