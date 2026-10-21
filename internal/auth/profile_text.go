package auth

import (
	"errors"
	"sort"
	"strings"
	"unicode/utf8"

	"golang.org/x/text/unicode/norm"
)

// Limits of the account's profile text, in characters.
const (
	StatusMaxRunes = 190
	BioMaxRunes    = 500
)

// maxMarkRun is the most combining marks (General_Category Mn and Me) one base may carry. Real scripts stay below it
// (Vietnamese and Hebrew with points take 2 to 4); more is overlay ("zalgo") text that draws over the rows around it.
const maxMarkRun = 8

var (
	// ErrTextLength: more characters than the field allows.
	ErrTextLength = errors.New("auth: the text is too long")
	// ErrTextChars: a control, invisible, unassigned or private-use character, a stack of marks, or a line break where there is none.
	ErrTextChars = errors.New("auth: the text has characters that cannot be shown")
	// ErrTextBlank: nothing visible: only whitespace and combining marks.
	ErrTextBlank = errors.New("auth: the text is only whitespace")
)

// NormalizeUserText is the one rule for free text a person writes about themselves (a display name, a status message,
// a bio): valid UTF-8, NFC, at most maxRunes characters, trimmed (White_Space), and none of
//
//   - a control character (a tab included; a line break only when allowNewline, and then CRLF becomes LF);
//   - a Default_Ignorable_Code_Point (zero-width and bidi controls, the soft hyphen, the Hangul fillers, variation
//     selectors, tag characters, the invisible operators, and the unassigned ones among them), except U+200C and
//     U+200D where RFC 5892 Appendix A.1 and A.2 allow them (after a virama; a ZWNJ between joining letters, which
//     keeps Persian, Kurdish and Sinhala working; a ZWJ between two emoji), U+FE0E and U+FE0F directly after an Emoji
//     code point, U+180B-180D and U+180F directly after a Mongolian letter, and the RGI tag sequences (England,
//     Scotland, Wales);
//   - U+2028, U+2029, U+2800 (braille blank) and U+FFF9-FFFB;
//   - an unassigned code point (General_Category Cn, with the noncharacters), a private-use one (Co) or a surrogate;
//   - more than maxMarkRun combining marks in a row.
//
// "" is allowed and means "none". A text of nothing visible (only whitespace and combining marks) is ErrTextBlank.
// The errors are ErrTextLength, ErrTextChars and ErrTextBlank, so a caller can tell a person what to change. The
// character properties come from the generated tables of Unicode unicodeTablesVersion
// (scripts/gen-profile-text-tables.mjs), not from the runtime, so the client's mirror
// (packages/client-core/src/profile-text.ts) agrees whatever the browser's Unicode version.
func NormalizeUserText(s string, maxRunes int, allowNewline bool) (string, error) {
	if !utf8.ValidString(s) {
		return "", ErrTextChars
	}
	if allowNewline {
		s = strings.ReplaceAll(s, "\r\n", "\n")
	}
	// The marks are counted before NFC as well: it composes the first one into the base (a + 9 x U+0301 is one letter
	// and 8 marks), and the person still typed 9.
	if markRunTooLong(s) {
		return "", ErrTextChars
	}
	out := norm.NFC.String(s)
	if utf8.RuneCountInString(out) > maxRunes {
		return "", ErrTextLength
	}
	if !textCharsOK(out, allowNewline) {
		return "", ErrTextChars
	}
	trimmed := trimWhiteSpace(out)
	if out != "" && !hasVisible(trimmed) {
		return "", ErrTextBlank
	}
	return trimmed, nil
}

// markRunTooLong: more than maxMarkRun combining marks in a row.
func markRunTooLong(s string) bool {
	run := 0
	for _, r := range s {
		if !inRanges(r, markRanges) {
			run = 0
		} else if run++; run > maxMarkRun {
			return true
		}
	}
	return false
}

func isWhiteSpace(r rune) bool { return inRanges(r, whiteSpaceRanges) }

// trimWhiteSpace removes White_Space from both ends.
func trimWhiteSpace(s string) string { return strings.TrimFunc(s, isWhiteSpace) }

// hasVisible: some character that is not whitespace, a combining mark or Default_Ignorable (a joiner or a variation
// selector that textCharsOK allowed in context shows nothing by itself).
func hasVisible(s string) bool {
	for _, r := range s {
		if !isWhiteSpace(r) && !inRanges(r, markRanges) && !inRanges(r, defaultIgnorableRanges) {
			return true
		}
	}
	return false
}

// textCharsOK is the character class of NormalizeUserText (and so of NormalizeDisplay).
func textCharsOK(s string, allowNewline bool) bool {
	runes := []rune(s)
	marks := 0
	for i := 0; i < len(runes); i++ {
		r := runes[i]
		if inRanges(r, markRanges) {
			if marks++; marks > maxMarkRun {
				return false
			}
		} else {
			marks = 0
		}
		switch {
		case r == '\n':
			if !allowNewline {
				return false
			}
		case r < 0x20 || (r >= 0x7f && r <= 0x9f):
			return false // Cc
		case inRanges(r, unusableRanges):
			return false
		case r == 0x2028 || r == 0x2029 || r == 0x2800 || (r >= 0xfff9 && r <= 0xfffb):
			return false // visible-looking or line-breaking, but not Default_Ignorable
		case r == 0x1f3f4:
			// A flag tag sequence from the RGI list (England, Scotland, Wales) is kept whole. Any other tag character
			// is Default_Ignorable and refused below, so a run of tags cannot carry hidden text.
			if n := tagSequenceAt(runes, i); n > 0 {
				i += n - 1
				marks = 0
			}
		case inRanges(r, defaultIgnorableRanges):
			if !ignorableAllowed(runes, i) {
				return false
			}
		}
	}
	return true
}

// ignorableAllowed: the Default_Ignorable code points that may stand where they are, by context.
func ignorableAllowed(runes []rune, i int) bool {
	r := runes[i]
	afterVirama := i > 0 && isVirama(runes[i-1])
	switch r {
	case 0x200c:
		return afterVirama || zwnjJoins(runes, i)
	case 0x200d:
		return afterVirama || joinsEmoji(runes, i)
	case 0xfe0e, 0xfe0f:
		// One per base: a stacked selector has no emoji before it.
		return i > 0 && inRanges(runes[i-1], emojiRanges)
	case 0x180b, 0x180c, 0x180d, 0x180f:
		return i > 0 && inRanges(runes[i-1], mongolianLetterRanges)
	}
	return false
}

// tagSequenceAt is the length of the RGI tag sequence that starts at runes[i], 0 when none does.
func tagSequenceAt(runes []rune, i int) int {
	for _, seq := range tagSequences {
		if i+len(seq) > len(runes) {
			continue
		}
		match := true
		for k, r := range seq {
			if runes[i+k] != r {
				match = false
				break
			}
		}
		if match {
			return len(seq)
		}
	}
	return 0
}

func inRanges(r rune, rs []runeRange) bool {
	i := sort.Search(len(rs), func(i int) bool { return rs[i].hi >= r })
	return i < len(rs) && rs[i].lo <= r
}

func isVirama(r rune) bool { return inRanges(r, viramaRanges) }

// joinType is the Joining_Type of r: L, R, D, C or T from the generated table, U for every other code point.
func joinType(r rune) byte {
	i := sort.Search(len(joiningRanges), func(i int) bool { return joiningRanges[i].hi >= r })
	if i < len(joiningRanges) && joiningRanges[i].lo <= r {
		return joiningRanges[i].typ
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
