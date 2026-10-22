package auth

import (
	"testing"
	"unicode"

	"golang.org/x/text/unicode/norm"
)

// The generated tables are for the Unicode version the Go runtime ships: a Go or x/text upgrade that moves either
// fails here until `node scripts/gen-profile-text-tables.mjs` is re-run against the new version's files.
func TestTheTablesAreForTheRuntimesUnicodeVersion(t *testing.T) {
	if unicodeTablesVersion != unicode.Version {
		t.Errorf("tables are Unicode %s, unicode.Version is %s", unicodeTablesVersion, unicode.Version)
	}
	if unicodeTablesVersion != norm.Version {
		t.Errorf("tables are Unicode %s, x/text norm.Version is %s", unicodeTablesVersion, norm.Version)
	}
}

// The tables are sorted and disjoint, which the binary searches rely on.
func TestTheTablesAreSortedAndDisjoint(t *testing.T) {
	for name, rs := range map[string][]runeRange{
		"virama": viramaRanges, "defaultIgnorable": defaultIgnorableRanges, "whiteSpace": whiteSpaceRanges, "marks": markRanges,
		"unusable": unusableRanges, "extPict": extPictRanges, "emojiPresentation": emojiPresentationRanges, "emoji": emojiRanges,
		"mongolian": mongolianLetterRanges,
	} {
		for i, r := range rs {
			if r.lo > r.hi || (i > 0 && rs[i-1].hi >= r.lo) {
				t.Errorf("%s: range %d (%X-%X) is out of order", name, i, r.lo, r.hi)
			}
		}
	}
	for i, r := range joiningRanges {
		if r.lo > r.hi || (i > 0 && joiningRanges[i-1].hi >= r.lo) {
			t.Errorf("joining: range %d is out of order", i)
		}
	}
}
