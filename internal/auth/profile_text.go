package auth

import (
	"errors"
	"sort"
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
	// ErrTextChars: a control, bidi, invisible or line-separator character, or a line break where there is none.
	ErrTextChars = errors.New("auth: the text has characters that cannot be shown")
	// ErrTextBlank: nothing visible: only whitespace, marks or variation selectors.
	ErrTextBlank = errors.New("auth: the text is only whitespace")
)

// NormalizeUserText is the one rule for free text a person writes about themselves or a device (a
// display name, a status message, a bio, E7's device label): NFC, at most maxRunes characters, trimmed,
// and none of
//
//   - a control character (a tab included; a line break only when allowNewline, and then CRLF becomes LF);
//   - a bidi control (U+200E, U+200F, U+202A-202E, U+2066-2069), U+061C, U+2028 or U+2029;
//   - an invisible character: U+00AD, U+034F, U+115F, U+1160, U+180E, U+200B, U+2060-2064, U+206A-206F,
//     U+2800, U+3164, U+FEFF, U+FFA0, U+FFF9-FFFB;
//   - a tag character (U+E0020-E007F), except as the tag sequence that follows a black flag (U+1F3F4)
//     and ends in U+E007F;
//   - a zero-width non-joiner (U+200C) or joiner (U+200D) outside its context: after a virama
//     (Canonical_Combining_Class 9), a ZWNJ between joining letters (RFC 5892 Appendix A.1, which keeps
//     Persian, Kurdish and other Arabic-script text working), or a ZWJ joining two emoji (Extended_Pictographic
//     with an emoji presentation, so (c)(c) is refused but a family is kept).
//
// "" is allowed and means "none". A text of nothing visible (only whitespace, combining marks or variation
// selectors) is ErrTextBlank. The errors are ErrTextLength, ErrTextChars and ErrTextBlank, so a caller can
// tell a person what to change. The tables come from Unicode unicodeTablesVersion
// (scripts/gen-profile-text-tables.mjs); packages/client-core/src/profile-text.ts is the client's mirror.
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
	if out != "" && !hasVisible(trimmed) {
		return "", ErrTextBlank
	}
	return trimmed, nil
}

// hasVisible: some character that is not whitespace, a combining mark or a variation selector.
func hasVisible(s string) bool {
	for _, r := range s {
		if !unicode.IsSpace(r) && !unicode.In(r, unicode.Mn, unicode.Me) && (r < 0xfe00 || r > 0xfe0f) {
			return true
		}
	}
	return false
}

// textCharsOK is the character class of NormalizeUserText (and so of NormalizeDisplay).
func textCharsOK(s string, allowNewline bool) bool {
	runes := []rune(s)
	for i := 0; i < len(runes); i++ {
		r := runes[i]
		switch {
		case r == '\n':
			if !allowNewline {
				return false
			}
		case unicode.IsControl(r), refusedRune(r), r >= 0xe0020 && r <= 0xe007f:
			return false
		case r == 0x1f3f4:
			// A flag tag sequence: U+1F3F4, tag characters, U+E007F. Anything else tagged is refused above.
			j := i + 1
			for j < len(runes) && runes[j] >= 0xe0020 && runes[j] <= 0xe007e {
				j++
			}
			if j > i+1 && j < len(runes) && runes[j] == 0xe007f {
				i = j
			}
		case r == 0x200c:
			if (i == 0 || !isVirama(runes[i-1])) && !zwnjJoins(runes, i) {
				return false
			}
		case r == 0x200d:
			if (i == 0 || !isVirama(runes[i-1])) && !joinsEmoji(runes, i) {
				return false
			}
		}
	}
	return true
}

// refusedRune: the characters that are refused wherever they stand.
func refusedRune(r rune) bool {
	switch r {
	case 0x00ad, 0x034f, 0x061c, 0x115f, 0x1160, 0x180e, 0x200b, 0x200e, 0x200f, 0x2028, 0x2029, 0x2800, 0x3164, 0xfeff, 0xffa0:
		return true
	}
	return (r >= 0x202a && r <= 0x202e) || (r >= 0x2060 && r <= 0x2064) || (r >= 0x2066 && r <= 0x206f) || (r >= 0xfff9 && r <= 0xfffb)
}

func inRanges(r rune, rs []runeRange) bool {
	i := sort.Search(len(rs), func(i int) bool { return rs[i].hi >= r })
	return i < len(rs) && rs[i].lo <= r
}

func isVirama(r rune) bool { return inRanges(r, viramaRanges) }

// joinType is the Joining_Type of r: L, R, D, C or U from ArabicShaping.txt, and T for the rest of Mn, Me and Cf.
func joinType(r rune) byte {
	i := sort.Search(len(joiningRanges), func(i int) bool { return joiningRanges[i].hi >= r })
	if i < len(joiningRanges) && joiningRanges[i].lo <= r {
		return joiningRanges[i].typ
	}
	if unicode.In(r, unicode.Mn, unicode.Me, unicode.Cf) {
		return 'T'
	}
	return 'U'
}

// zwnjJoins is RFC 5892 Appendix A.1: (Joining_Type:{L,D})(Joining_Type:T)* ZWNJ (Joining_Type:T)* (Joining_Type:{R,D}).
func zwnjJoins(runes []rune, i int) bool {
	j := i - 1
	for j >= 0 && joinType(runes[j]) == 'T' {
		j--
	}
	if j < 0 || (joinType(runes[j]) != 'L' && joinType(runes[j]) != 'D') {
		return false
	}
	k := i + 1
	for k < len(runes) && joinType(runes[k]) == 'T' {
		k++
	}
	return k < len(runes) && (joinType(runes[k]) == 'R' || joinType(runes[k]) == 'D')
}

// joinsEmoji: a ZWJ between two pictographs. Before it: an emoji-presentation character, a skin-tone modifier, or U+FE0F
// after an Extended_Pictographic. After it: an emoji-presentation character, or an Extended_Pictographic followed by
// U+FE0F. A text-presentation symbol such as (c) therefore never takes a joiner.
func joinsEmoji(runes []rune, i int) bool {
	if i == 0 || i+1 >= len(runes) {
		return false
	}
	b, a := runes[i-1], runes[i+1]
	before := (b >= 0x1f3fb && b <= 0x1f3ff) || inRanges(b, emojiPresentationRanges) || (b == 0xfe0f && i >= 2 && inRanges(runes[i-2], extPictRanges))
	after := inRanges(a, emojiPresentationRanges) || (inRanges(a, extPictRanges) && i+2 < len(runes) && runes[i+2] == 0xfe0f)
	return before && after
}
